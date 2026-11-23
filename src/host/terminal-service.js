import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { claudeFolderTrustAction } from './claude-folder-trust.js'

const require = createRequire(import.meta.url)
const maxReadBytes = 64 * 1024
const maxReplayBytes = 1024 * 1024
const maxWaitMs = 5000
const compress = promisify(gzip)

function dimension(n, limit) {
  if (!Number.isSafeInteger(n) || n < 1 || n > limit) throw new Error('Invalid terminal dimensions')
  return n
}

// Absolute offsets never wrap. Only the physical slots in the window do.
class OutputWindow {
  constructor(capacity) {
    this.bytes = Buffer.alloc(capacity)
    this.end = 0
  }
  get start() { return Math.max(0, this.end - this.bytes.length) }
  append(bytes) {
    this.end += bytes.length
    const tail = bytes.subarray(Math.max(0, bytes.length - this.bytes.length))
    const slot = (this.end - tail.length) % this.bytes.length
    const first = tail.copy(this.bytes, slot)
    tail.copy(this.bytes, 0, first)
  }
  slice(start, end) {
    const count = end - start, slot = start % this.bytes.length
    const first = this.bytes.subarray(slot, slot + count)
    return first.length === count ? first : Buffer.concat([first, this.bytes.subarray(0, count - first.length)], count)
  }
}

function enqueue(entry, fn) {
  const pending = entry.operations.then(fn)
  entry.operations = pending.catch(() => {})
  return pending
}

function wake(entry) {
  for (const done of entry.waiters) done()
}

function waitForOutput(entry, ms, signal) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      entry.waiters.delete(finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    entry.waiters.add(finish)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function exitError(error) {
  return { exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error) }
}

function stopFolderTrust(entry) {
  clearTimeout(entry.folderTrust?.timer)
  entry.folderTrust = null
}

function checkFolderTrust(entry) {
  const trust = entry.folderTrust
  if (!trust) return
  if (entry.closing || entry.termination || Date.now() >= trust.deadline) {
    return stopFolderTrust(entry)
  }
  const action = claudeFolderTrustAction(entry.screen, trust.cwd)
  if (action === 'stop') return stopFolderTrust(entry)
  if (action === trust.pending) return
  clearTimeout(trust.timer)
  trust.pending = action
  if (!action || (action === 'select' && trust.selectSent)) return

  // Claude can paint the menu before its keyboard handler is ready and reset
  // an early selection. Keep parsing output during this interval. Check the
  // live screen again in the same queue that serializes PTY input and resize.
  trust.timer = setTimeout(() => {
    void enqueue(entry, async () => {
      if (entry.folderTrust !== trust || trust.pending !== action || entry.closing || entry.termination) return
      if (claudeFolderTrustAction(entry.screen, trust.cwd) !== action) return checkFolderTrust(entry)
      if (action === 'select') trust.selectSent = true
      else stopFolderTrust(entry)
      try { await entry.handle.write(action === 'select' ? '\x1b[B' : '\r') }
      catch { stopFolderTrust(entry) }
    })
  }, trust.selectSent ? 100 : 700)
  trust.timer.unref()
}

async function drain(entry) {
  // The provider can settle done before the final characters leave its Readable.
  // Publish an exit only after all screen writes and retained bytes catch up.
  const outcome = entry.handle.done.then(value => ({ exitCode: value.exitCode, signal: value.signal }), exitError)
  try {
    for await (const chunk of entry.handle.output) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      await enqueue(entry, async () => {
        await new Promise(resolve => entry.screen.write(data, resolve))
        entry.window.append(data)
        checkFolderTrust(entry)
        wake(entry)
      })
    }
    return await outcome
  } catch (error) {
    return exitError(error)
  }
}

// Losing the stream (or the top-level process) doesn't prove that all children
// released the native thread. Keep the chat lease until the provider confirms it.
function terminate(entry) {
  if (!entry.termination) {
    entry.termination = (async () => {
      // A CLI starting extensions can fork one last helper during the DSH
      // provider's sweep. Repeat its identity-checked cleanup on this handle.
      for (let attempt = 0; ; attempt++) {
        try { return await entry.handle.terminate() }
        catch (error) {
          if (attempt >= 2 || !error.message?.startsWith('terminal cleanup failed; surviving pids:')) throw error
          await delay(200)
        }
      }
    })().catch(error => {
      entry.termination = null
      throw error
    })
  }
  return entry.termination
}

function finish(entry, onExit) {
  if (!entry.finishing) {
    entry.finishing = (async () => {
      const outcome = await entry.drained
      await terminate(entry)
      entry.exit = outcome
      entry.endError = null
      wake(entry)
      await onExit?.(entry.terminalId, outcome)
    })().catch(error => {
      entry.finishing = null
      entry.endError = error
      wake(entry)
      throw error
    })
  }
  return entry.finishing
}

export class TerminalService {
  constructor(subprocess, { replayBytes = maxReplayBytes, scrollback = 300, onExit } = {}) {
    if (!Number.isSafeInteger(replayBytes) || replayBytes < 1) throw new Error('Invalid terminal replay window')
    this.subprocess = subprocess
    this.replayBytes = replayBytes
    this.scrollback = scrollback
    this.onExit = onExit
    this.entries = new Map()
    this.opening = new Set()
    this.lifetime = new AbortController()
  }

  async open({ command, args = [], cwd, env, cols = 80, rows = 24, trustClaudeFolder = false }) {
    this.lifetime.signal.throwIfAborted()
    dimension(cols, 500); dimension(rows, 250)
    if (!this.subprocess?.spawnTerminal) throw new Error('DSH subprocess terminal provider is unavailable')
    const { Terminal } = require('@xterm/headless')
    const { SerializeAddon } = require('@xterm/addon-serialize')
    const screen = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const terminalId = randomUUID()
    const entry = { terminalId, screen, serializer, cols, rows, exit: null, closing: null,
      window: new OutputWindow(this.replayBytes), replayFloor: 0, operations: Promise.resolve(), waiters: new Set() }
    const pending = (async () => {
      let handle
      try {
        handle = await this.subprocess.spawnTerminal({ argv: [command, ...args], cwd, env, cols, rows,
          terminalType: 'xterm-256color', graceMs: 1000, signal: this.lifetime.signal })
      } catch (error) {
        screen.dispose()
        throw error
      }
      entry.handle = handle
      if (trustClaudeFolder) entry.folderTrust = { cwd: typeof trustClaudeFolder === 'string' ? trustClaudeFolder : cwd, deadline: Date.now() + 30_000, selectSent: false }
      this.entries.set(terminalId, entry)
      entry.drained = drain(entry)
      // The close/dispose caller observes hook failures; an unattended exit must not
      // produce an unhandled rejection.
      void finish(entry, this.onExit).catch(() => {})
      if (this.lifetime.signal.aborted) {
        await this.close(terminalId)
        this.lifetime.signal.throwIfAborted()
      }
      return { terminalId, cols, rows }
    })()
    this.opening.add(pending)
    try { return await pending } finally { this.opening.delete(pending) }
  }

  info(terminalId) {
    const e = this.entries.get(terminalId)
    return e ? { terminalId, cols: e.cols, rows: e.rows, cursor: e.window.end, exit: e.exit, closing: !!e.closing } : null
  }

  async attachInfo(terminalId) {
    const entry = this.require(terminalId)
    const info = this.info(terminalId)
    if (info.closing || info.cursor <= maxReadBytes || info.cursor > maxReplayBytes ||
        entry.window.start || entry.replayFloor) return info
    // Freeze the same prefix whose cursor we send. The ring may wrap as gzip
    // runs in the thread pool. Preserve all modes, scrollback and partial ANSI.
    const bytes = Buffer.from(entry.window.slice(0, info.cursor))
    const packed = await compress(bytes, { level: 1 })
    if (entry.closing || !this.entries.has(terminalId)) return this.info(terminalId)
    if (packed.length <= maxReadBytes) info.replay = { terminalId, start: 0, cursor: info.cursor,
      encoding: 'gzip', data: packed.toString('base64'), reset: false, cols: info.cols, rows: info.rows, exit: info.exit }
    return info
  }

  async read(terminalId, { cursor = 0, waitMs = 0, signal } = {}) {
    const entry = this.require(terminalId)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid terminal output cursor')
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error('Invalid terminal read duration')
    signal?.throwIfAborted()
    if (cursor === entry.window.end && !entry.exit && !entry.endError && !entry.closing && waitMs) {
      await waitForOutput(entry, Math.min(waitMs, maxWaitMs), signal)
      signal?.throwIfAborted()
    }
    if (entry.endError) throw entry.endError
    const win = entry.window
    // Replaying bytes from an unknown parser state (or at an obsolete width)
    // corrupts alternate-screen TUIs. Rebuild those clients from the actual screen.
    const reset = cursor < Math.max(win.start, entry.replayFloor) || cursor > win.end
    if (reset) {
      // The headless parser can yield in the middle of a large write. Take its
      // snapshot and cursor together after that write commits to the byte window.
      return enqueue(entry, () => ({ terminalId, start: win.end, cursor: win.end,
        data: Buffer.from(entry.serializer.serialize()).toString('base64'), reset: true,
        exit: entry.exit, cols: entry.cols, rows: entry.rows }))
    }
    const end = Math.min(win.end, cursor + maxReadBytes)
    return { terminalId, start: cursor, cursor: end, data: win.slice(cursor, end).toString('base64'), reset: false,
      exit: end === win.end ? entry.exit : null, cols: entry.cols, rows: entry.rows }
  }

  require(terminalId) {
    const entry = this.entries.get(terminalId)
    if (!entry) throw new Error('Terminal session does not exist')
    return entry
  }

  input(terminalId, fn) {
    const entry = this.require(terminalId)
    if (entry.exit || entry.endError || entry.termination || entry.closing || this.lifetime.signal.aborted) throw new Error('Terminal is not running')
    return enqueue(entry, () => {
      if (entry.exit) throw new Error('Terminal is not running')
      return fn(entry)
    })
  }

  async write(terminalId, data) {
    if (typeof data !== 'string' || Buffer.byteLength(data) > 256 * 1024) throw new Error('Invalid terminal input')
    // xterm can answer device attributes / cursor position queries at startup.
    // Any other input gives the user exclusive control of the prompt.
    if (data && !/^(?:\x1b\[(?:[?>][\d;]*c|\??\d+;\d+R))+$/u.test(data))
      stopFolderTrust(this.require(terminalId))
    await this.input(terminalId, e => e.handle.write(data))
    return true
  }

  async resize(terminalId, cols, rows) {
    dimension(cols, 500); dimension(rows, 250)
    await this.input(terminalId, async e => {
      if (cols === e.cols && rows === e.rows) return
      await e.handle.resize(cols, rows)
      e.cols = cols
      e.rows = rows
      e.screen.resize(cols, rows)
      e.replayFloor = e.window.end
      wake(e)
    })
    return true
  }

  async close(terminalId) {
    const entry = this.entries.get(terminalId)
    if (!entry) return true
    if (!entry.closing) {
      entry.closing = (async () => {
        await entry.operations
        await terminate(entry)
        await finish(entry, this.onExit)
        this.entries.delete(terminalId)
        entry.screen.dispose()
        return true
      })().catch(error => {
        entry.closing = null
        throw error
      })
      wake(entry)
    }
    return entry.closing
  }

  async dispose() {
    this.lifetime.abort(new Error('NativeCrew terminal service stopped'))
    await Promise.allSettled([...this.opening])
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)))
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason)
    if (errors.length) throw new AggregateError(errors, 'Could not close all NativeCrew terminals')
  }
}

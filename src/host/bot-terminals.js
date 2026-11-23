// One PTY may own a chat at a time. Reopening a pane attaches to that process.
import { buildTerminalLaunch } from './terminal-launch.js'
import { TerminalService } from './terminal-service.js'

export class BotTerminals {
  constructor(service, subprocess, { build = buildTerminalLaunch, Terminal = TerminalService } = {}) {
    this.service = service
    this.build = build
    this.byChat = new Map()
    this.pending = new Map()
    this.uncertain = new Map()
    this.pty = new Terminal(subprocess, { onExit: id => this.release(id) })
  }

  status({ botId, sessionId } = {}) {
    const key = JSON.stringify([botId, sessionId])
    const previous = this.byChat.get(key)
    const info = previous && this.pty.info(previous.id)
    return { active: !!info && !info.exit, closing: info?.closing === true }
  }

  async open(request = {}) {
    const { memberId, botId, sessionId, agent, cols, rows, restart, terminalId } = request
    if (memberId != null || typeof botId !== 'string' || !botId || typeof sessionId !== 'string' || !sessionId || this.stopping)
      throw new Error('请选择当前 Bot 的私聊。')
    const key = JSON.stringify([botId, sessionId])
    const competing = this.pending.get(key)
    if (competing) {
      await competing
      return this.open(request)
    }
    const open = async () => {
      const unfinished = this.uncertain.get(key)
      if (unfinished) {
        await unfinished.release()
        this.uncertain.delete(key)
      }
      const previous = this.byChat.get(key)
      let info = previous && this.pty.info(previous.id)
      if (info && previous.lease.stillCurrent?.() === false) {
        await this.close(previous.id)
        info = undefined
      }
      if (info) {
        const reattach = !restart || terminalId !== previous.id
        if (reattach && request.includeReplay === true) {
          info = await this.pty.attachInfo(previous.id)
          if (!info) throw new Error('终端已关闭，请重新打开当前聊天的终端。')
        }
        if (previous.lease.signal?.aborted || previous.lease.stillCurrent?.() === false)
          throw new Error('该 Bot 的原生会话已切换，请重新打开。')
        if (info.closing) throw new Error('终端正在交还控制权。')
        if (reattach) return { ...this.view(previous, info, true), stale: agent !== previous.agent }
        if (!info.exit) throw new Error('请先交还正在运行的终端。')
        await this.pty.close(previous.id)
        this.byChat.delete(key)
      } else if (restart && terminalId) {
        throw new Error('终端已关闭，请重新打开当前聊天的终端。')
      }
      const lease = await this.service.runtime.claimAgentTerminal(botId, sessionId)
      let id, entry
      try {
        if (!lease.sessionId) throw new Error('请先在聊天里发一条消息以建立原生会话。')
        if (agent !== lease.agent) throw new Error('Bot 的运行引擎已改变，请重新打开终端。')
        if (lease.accountProfileId) {
          const sandbox = await this.service.sandboxTerminal(lease)
          const release = lease.release.bind(lease)
          lease.sandboxLaunch = sandbox
          lease.release = async () => { await sandbox.close(); await release() }
        }
        const launch = await this.build(lease)
        lease.signal?.throwIfAborted()
        const opened = await this.pty.open({ ...launch, command: launch.file, cols, rows,
          trustClaudeFolder: (lease.agent === 'claude' || lease.agent === 'local-claude-code') && (lease.sandboxLaunch?.guestCwd ?? true) })
        id = opened.terminalId
        entry = { key, id, agent: lease.agent, cwd: launch.cwd, nativeId: lease.sessionId, lease }
        this.byChat.set(key, entry)
        entry.onAbort = () => { void this.close(id).catch(() => {}) }
        lease.signal?.addEventListener('abort', entry.onAbort, { once: true })
        lease.signal?.throwIfAborted()
        if (this.stopping) throw new Error('NativeCrew 正在关闭。')
        const info = this.pty.info(id)
        if (info.exit) await this.release(id)
        return this.view(entry, info, false)
      } catch (error) {
        if (id) await this.pty.close(id)
        if (entry && this.byChat.get(key) === entry) this.byChat.delete(key)
        try { await lease.release() } catch (cleanupError) {
          this.uncertain.set(key, lease)
          throw cleanupError
        }
        throw error
      }
    }
    const operation = open()
    this.pending.set(key, operation)
    try { return await operation } finally { if (this.pending.get(key) === operation) this.pending.delete(key) }
  }

  view(entry, info, reused) {
    return { ...info, agent: entry.agent, cwd: entry.cwd, nativeId: entry.nativeId, reused,
      ...(entry.lease.accountProfileId ? { accountProfileId: entry.lease.accountProfileId, guestCwd: entry.lease.sandboxLaunch.guestCwd } : {}) }
  }

  async history(id) {
    const entry = [...this.byChat.values()].find(row => row.id === id)
    const active = () => {
      const info = this.pty.info(id)
      return !this.stopping && entry?.lease.readHistory && this.byChat.get(entry.key) === entry &&
        info && !info.exit && !info.closing && !entry.releasing && !entry.lease.signal?.aborted &&
        entry.lease.stillCurrent?.() !== false
    }
    if (!active()) throw new Error('请先打开当前 Bot 的原生会话。')
    const history = await entry.lease.readHistory()
    if (!active()) throw new Error('原生会话已交还或关闭。')
    return history
  }

  release(id) {
    const entry = [...this.byChat.values()].find(row => row.id === id)
    if (entry && !entry.releasing) {
      entry.lease.signal?.removeEventListener('abort', entry.onAbort)
      entry.releasing = Promise.resolve().then(() => entry.lease.release()).catch(error => { entry.releasing = undefined; throw error })
    }
    return entry?.releasing
  }

  async close(id) {
    await this.pty.close(id)
    await this.release(id)
    for (const [key, entry] of this.byChat) if (entry.id === id) this.byChat.delete(key)
    return true
  }

  async dispose() {
    this.stopping = true
    // Abort the provider before waiting for an in-flight spawn which may itself
    // be waiting for that signal. Later opens observe the same stopped lifetime.
    const [, stopped] = await Promise.allSettled([Promise.allSettled(this.pending.values()), this.pty.dispose()])
    if (stopped.status === 'rejected') throw stopped.reason
    await Promise.all([...this.byChat.values()].map(row => this.release(row.id)))
    this.byChat.clear()
    for (const lease of this.uncertain.values()) await lease.release()
    this.uncertain.clear()
  }
}

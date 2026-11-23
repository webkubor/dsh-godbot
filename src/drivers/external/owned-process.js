import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { spawnAgent } from './discover.js'

const run = promisify(execFile)
const windows = process.platform === 'win32'

// Each NativeCrew handle launches one CLI. An independent process group keeps
// its shell commands separate from the host and from other members' CLIs.
export function ownProcess(spawn = spawnAgent) {
  let child
  let group
  let closing
  let killed = false
  let released = false
  const descendants = new Map()

  function launch(bin, args, options) {
    child = spawn(bin, args, { ...options, detached: !windows })
    if (!windows) {
      group = child.pid
      child.once('exit', () => {
        // Once a group disappears its numeric ID may eventually be reused.
        // Do not signal that number if the handle is closed much later.
        if (!closing) void snapshot().then(rows => { if (!rows.length) released = true }).catch(() => {})
      })
    }
    return child
  }

  // Only identifiers and creation times are queried. Command lines may contain
  // credentials. Also remember children which created their own process group
  // while they were still attached to our CLI.
  async function snapshot() {
    const { stdout } = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
      timeout: 1500,
      maxBuffer: 8 * 1024 * 1024,
    })
    const rows = []
    for (const line of stdout.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/u.exec(line)
      if (match && !match[4].includes('Z'))
        rows.push({ pid: +match[1], parent: +match[2], group: +match[3], birth: match[5] })
    }
    const rootAlive = child.exitCode === null && child.signalCode === null
    const members = new Set(
      rows
        .filter(
          (row) =>
            row.group === group ||
            (rootAlive && row.pid === child.pid) ||
            descendants.get(row.pid) === row.birth,
        )
        .map((row) => row.pid),
    )
    // A descendant may have started a new session or set its own process group.
    for (let last = -1; last !== members.size; ) {
      last = members.size
      for (const row of rows) if (members.has(row.parent)) members.add(row.pid)
    }
    const live = rows.filter((row) => members.has(row.pid))
    for (const row of live) descendants.set(row.pid, row.birth)
    return live
  }

  function signal(pid, name) {
    try {
      process.kill(pid, name)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error
      // macOS sometimes rejects a group signal during the CLI's own exit.
      // Verification below still requires every tracked child to disappear.
      return false
    }
  }

  async function stopPosix(force) {
    const until = Date.now() + (force ? 3000 : 1000)
    do {
      const live = await snapshot()
      if (!live.length) return true
      const signame = force || killed ? 'SIGKILL' : 'SIGTERM'
      const groupSignalled = live.some((row) => row.group === group) && signal(-group, signame)
      for (const row of live) if (!groupSignalled || row.group !== group) signal(row.pid, signame)
      await delay(35)
    } while (Date.now() < until)
    return !(await snapshot()).length
  }

  async function stopWindows() {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error
    }
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(35)
    if (child.exitCode === null && child.signalCode === null)
      throw new Error('Agent process is still running')
  }

  async function stop(force) {
    if (force) killed = true
    if (!child?.pid || released) return
    if (!closing)
      closing = (async () => {
        if (windows) {
          await stopWindows()
          return
        }
        if (await stopPosix(killed)) return
        if (await stopPosix(true)) return
        throw new Error('Could not confirm exit of this agent process tree')
      })().catch((error) => {
        closing = undefined
        throw error
      })
    return closing
  }

  return {
    launch,
    stop,
    remember: async () => {
      if (!windows && child?.pid && !closing) await snapshot()
    },
  }
}

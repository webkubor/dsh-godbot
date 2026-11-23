import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { sandboxRouteInfo } from './sandbox-agents.js'
import { boundTerminalHistory } from './terminal-history.js'

const routes = new Set(['local-codex-cli', 'local-claude-code', 'local-antigravity'])
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu
const busy = () => new Error('请先结束当前任务、队列或审批，再接管原生会话。')
const occupied = () => new Error('该 Bot 的原生会话正在终端中使用。')

export class TerminalLeases {
  claims = new Map()
  writers = new Map()
  disposed = false

  enter(id) {
    if (this.disposed || this.claims.has(id)) throw occupied()
    this.writers.set(id, (this.writers.get(id) ?? 0) + 1)
    return () => {
      const n = this.writers.get(id) - 1
      if (n === 0) this.writers.delete(id)
      else this.writers.set(id, n)
    }
  }

  reserve(id) {
    if (this.disposed || this.claims.has(id)) throw occupied()
    if (this.writers.has(id)) throw busy()
    const controller = new AbortController()
    const done = Promise.withResolvers()
    const release = () => {
      if (this.claims.get(id) !== claim) return
      this.claims.delete(id)
      done.resolve()
    }
    const claim = { controller, done: done.promise, release }
    this.claims.set(id, claim)
    return claim
  }

  async waitForChat(id, signal) {
    while (this.claims.has(id)) {
      const claim = this.claims.get(id)
      const abort = Promise.withResolvers()
      const onAbort = () => abort.reject(signal.reason)
      signal?.throwIfAborted()
      signal?.addEventListener('abort', onAbort, { once: true })
      try { await Promise.race([claim.done, abort.promise]) }
      finally { signal?.removeEventListener('abort', onAbort) }
    }
    if (this.disposed) throw new Error('NativeCrew 团队已关闭。')
  }

  dispose() {
    this.disposed = true
    const claims = [...this.claims.values()]
    for (const claim of claims) claim.controller.abort(new Error('NativeCrew 团队已关闭。'))
    return Promise.all(claims.map(claim => claim.done))
  }
}

// Take the lock before looking up a session or waiting for the SDK to detach.
// The chat pre-step retains incoming messages until release. The adapter covers
// calls which can run outside a turn, such as context maintenance.
export async function claimTeamTerminal(rt, adapter, botId, part, delegate = adapter) {
  const checkOwner = () => {
    const bot = rt.botOf(botId)
    if (!bot || rt.chatOf(botId) !== part || rt.groupOwners.has(part) || rt.readOnly())
      throw new Error('请选择当前可写的 Bot 私聊。')
    const route = rt.engineOfBot(bot)
    const record = adapter.deps.record(part)
    const target = sandboxRouteInfo(route)
    if (target) rt.validateSandboxPart(bot, route, part)
    else if (bot.accountProfileId || record?.accountProfileId)
      throw new Error('Bot 的沙箱账号与当前原生会话不一致。')
    if ((!target && !routes.has(route)) || record && record.route !== route) throw new Error('Bot 的原生 Agent 已切换，无法接管此会话。')
    if (!record || !uuid.test(record.cliSessionId) || !isAbsolute(record.cwd ?? ''))
      throw new Error('该 Bot 尚未建立原生会话，请先在聊天中发送一条消息。')
    if (Object.entries(rt.state.localAgents?.sessions ?? {}).some(([key, other]) => {
      if (key === part || other?.cliSessionId !== record.cliSessionId) return false
      if (other.route === route) return true
      const account = target && sandboxRouteInfo(other.route)
      return account && account.kind === target.kind && account.accountId === target.accountId
    }))
      throw new Error('该原生会话同时绑定了其他聊天，无法独占接管。')
    return { bot, route, record }
  }
  const checkPreset = () => {
    const preset = adapter.deps.presetFor(part, { terminal: true })
    if (preset === 'read-only') throw new Error('此 Bot 使用宿主强制的只读工作区。')
    if (preset !== 'workspace-write' && preset !== 'danger-full-access')
      throw new Error('交互终端无法维持此会话的权限设置。')
    return preset
  }
  const checkIdle = agent => {
    const live = delegate.live.get(part)
    if (agent.status !== 'idle' || agent.inbox?.nextStep?.length || agent.inbox?.nextTurn?.length ||
        rt.waitsForApproval?.(part) || rt.live?.get(part)?.turn != null || rt.unreadOf?.(part)?.length ||
        rt.hasSubagents?.(part) || rt.state.questions?.[part] || rt.state.views?.[part]?.callId || rt.state.switching?.[part] ||
        (live && (live.state !== 'idle' || live.pending.size || live.queue.length)))
      throw busy()
  }
  const claim = adapter.terminalLeases.reserve(part)
  try {
    const { route, record } = checkOwner()
    const id = record.cliSessionId
    const cwd = record.cwd
    const agent = await rt.resolveAgent(part)
    const hydrated = checkOwner()
    if (hydrated.route !== route || hydrated.record.cliSessionId !== id || hydrated.record.cwd !== cwd) throw busy()
    checkPreset()
    checkIdle(agent)
    const selectedCwd = rt.workDirOf({ botId }) ?? rt.teamFolder()
    const folders = await Promise.all([selectedCwd, agent.session.header?.cwd ?? selectedCwd, record.cwd].map(dir => realpath(dir)))
    if (folders.some(dir => dir !== folders[0])) throw new Error('Bot 当前工作目录与原生会话不一致。')
    const live = delegate.live.get(part)
    if (live) {
      if (live.route !== (sandboxRouteInfo(route)?.base ?? route) || live.cliSessionId !== id) throw new Error('Bot 的原生会话正在切换。')
      await delegate.detachForTerminal(live)
    }
    const latest = checkOwner()
    if (latest.record.cliSessionId !== id || latest.record.cwd !== cwd || route !== latest.route) throw busy()
    const permissionPreset = checkPreset()
    latest.record.terminalSessionId = id
    await rt.save({ required: true })
    const stillCurrent = () => {
      try {
        const owner = checkOwner()
        return owner.route === route && owner.record.cliSessionId === id && owner.record.cwd === cwd &&
          owner.record.terminalSessionId === id && checkPreset() === permissionPreset &&
          (rt.workDirOf({ botId }) ?? rt.teamFolder()) === selectedCwd
      } catch { return false }
    }
    if (!stillCurrent()) throw busy()
    checkIdle(agent)
    claim.controller.signal.throwIfAborted()
    const onChanged = () => {
      if (!stillCurrent()) claim.controller.abort(new Error('Bot 的原生会话、工作目录或权限已变更。'))
    }
    const stopWatching = rt.onSaved?.(onChanged)
    const stopPermissions = rt.ctx?.on?.('session/event', (session, event) => {
      if (session.id === part && ['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) onChanged()
    })
    const sandbox = sandboxRouteInfo(route)
    const agentRoute = sandbox?.base ?? route
    return { agent: agentRoute, stillCurrent, ...(sandbox ? { accountProfileId: sandbox.accountId, sandboxBinding: latest.record.sandboxBinding } : {}), cwd: folders[0], sessionId: id, model: (latest.bot.model ?? latest.bot.appliedModel)?.split('/').slice(1).join('/'),
      permissionPreset, effort: latest.bot.effort, signal: claim.controller.signal,
      readHistory: () => boundTerminalHistory(rt, part, route, () => {
        if (adapter.terminalLeases.claims.get(part) !== claim || claim.controller.signal.aborted || !stillCurrent())
          throw new Error('该 Bot 的原生会话已切换，请重新打开。')
      }),
      release() { stopPermissions?.(); stopWatching?.(); claim.release() } }
  } catch (error) {
    claim.release()
    throw error
  }
}

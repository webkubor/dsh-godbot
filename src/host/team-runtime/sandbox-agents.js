// Each DSH part gets a separate native engine, process and MCP tunnel. The provider
// name persisted by DSH includes the account; the workspace speaks its original protocol.
import { createHash } from 'node:crypto'
import { rememberSandboxSource } from './sandbox-privacy.js'
import { getSandboxWorkspace, listSandboxAccounts, resolveSandboxLaunch } from '../sandbox-accounts.js'
import { sandboxAccountsEnabled } from '../sandbox-settings.js'
import { assertProviderAccountSelectable } from '../provider-accounts.js'

export const baseRoutes = { antigravity: 'local-antigravity', claude: 'local-claude-code', codex: 'local-codex-cli' }
export const sandboxRoute = (kind, accountId) => 'local-sandbox-' + kind + '-' + accountId
export function sandboxRouteInfo(route) {
  const match = /^local-sandbox-(antigravity|claude|codex)-([a-z][a-z0-9-]{0,62})(?:_w_([a-f0-9]{16}))?$/u.exec(route)
  return match && { kind: match[1], accountId: match[2], workspaceTag: match[3], base: baseRoutes[match[1]] }
}
function workspaceTag(binding) {
  return createHash('sha256').update(JSON.stringify([binding.bindingId, binding.hostCwd, binding.guestCwd])).digest('hex').slice(0, 16)
}
const provider = ref => ref?.split('/')[0]
const unavailable = () => new Error('该账号的沙箱未启用或已移除，请在 NativeCrew 设置中检查。')
function matchBinding(expected, actual) {
  if (!expected || expected.bindingId !== actual.bindingId || expected.guestCwd !== actual.guestCwd || expected.hostCwd !== actual.hostCwd)
    throw new Error('该沙箱账号或工作目录的绑定已变化，请在 Bot 设置中重新绑定。')
}
function savedBinding(selection) {
  return { bindingId: selection.bindingId, hostCwd: selection.hostCwd, guestCwd: selection.guestCwd }
}

export class SandboxTeamAgents {
  constructor(rt, { accountList = listSandboxAccounts, workspace = getSandboxWorkspace, launch = resolveSandboxLaunch,
    enabled = () => rt.config?.godbotStateDir && sandboxAccountsEnabled(rt.config.godbotStateDir), adapterFor, engineFor } = {}) {
    Object.assign(this, { rt, accountList, workspace, launch, enabled, adapterFor, engineFor })
    this.parts = new Map()
    this.changes = new Set()
    this.models = new Map()
    this.pendingRoutes = new Set()
  }
  routes() {
    if (!this.enabled()) return []
    return this.accountList().flatMap(a => a.kinds.map(kind => ({
      route: sandboxRoute(kind, a.id), name: a.name + ' · ' + ({ antigravity: 'Antigravity', claude: 'Claude Code', codex: 'Codex' })[kind],
      kind, accountProfileId: a.id, sandbox: true,
    })))
  }
  validate(bot, route, { part, cwd = bot?.workDir } = {}) {
    const target = sandboxRouteInfo(route)
    if (!target || !this.enabled()) throw unavailable()
    if (this.changes.has(bot?.id) || bot?.accountProfileId !== target.accountId || bot?.sandboxKind !== target.kind || provider(bot?.model) !== route)
      throw new Error('此对话没有绑定所选沙箱账号，请从 Bot 的当前对话重新打开。')
    const current = this.workspace({ accountId: target.accountId, kind: target.kind, cwd })
    matchBinding(bot.sandboxBinding, current)
    const record = part && this.rt.state.localAgents?.sessions?.[part]
    if (record) {
      if (record.route !== route || record.accountProfileId !== target.accountId) throw new Error('不能把已有原生会话交给另一个账号。')
      matchBinding(record.sandboxBinding, current)
    }
    return current
  }
  botFor(part) { return this.rt.botOf?.(this.rt.selfOf?.(part)) }
  get(part, route, deps) {
    const id = String(part)
    const bot = this.botFor(id)
    const initial = this.validate(bot, route, { part: id })
    rememberSandboxSource(this.rt, id, this.rt.groupOwners?.get(id)?.roomId)
    const old = this.parts.get(id)
    if (old) {
      if (old.route !== route) throw new Error('该聊天仍由另一个账号持有。')
      return old.adapter
    }
    const target = sandboxRouteInfo(route)
    const checked = () => this.validate(this.botFor(id), route, { part: id })
    const adapter = this.adapterFor({
      ...deps, sandbox: true, exposedRoute: route,
      cwdFor: async () => checked().hostCwd,
      record: key => {
        const row = deps.record(key)
        if (!row) return
        checked()
        return { ...row, route: target.base }
      },
      saveRecord: (key, row) => {
        // An async native ID can arrive after closing a chat. Store only for its
        // original owner and binding, and never let a late write replace another part.
        const owner = this.botFor(id)
        if (owner?.accountProfileId !== target.accountId || owner.sandboxBinding?.bindingId !== initial.bindingId ||
            (deps.record(key) && deps.record(key).route !== route)) return
        deps.saveRecord(key, { ...row, route, accountProfileId: target.accountId, sandboxBinding: savedBinding(initial) })
      },
      patchRecord: (key, patch) => {
        if (deps.record(key)?.sandboxBinding?.bindingId === initial.bindingId) deps.patchRecord(key, patch)
      },
      usedModels: () => deps.usedModels(route),
      spawnEngine: (_kind, _route, spec) => {
        const current = checked()
        return this.engineFor(target, spec, current, async mcp => {
          const latest = checked()
          const launch = await this.launch({ accountId: target.accountId, kind: target.kind, cwd: latest.hostCwd,
            ...(mcp ? { mcp: { name: 'godbot', url: mcp.url, token: mcp.token } } : {}) })
          try {
            matchBinding(checked(), launch)
            return launch
          } catch (error) { await launch.close(); throw error }
        })
      },
      probeCwd: () => checked().hostCwd,
      toolsFor: options => deps.toolsFor({ ...options, provider: route }),
      recordUsage: entry => deps.recordUsage({ ...entry, provider: route }),
    })
    this.parts.set(id, { route, adapter })
    return adapter
  }
  savedBotFields(model, cwd) {
    const target = sandboxRouteInfo(provider(model))
    if (!target) return
    if (!this.enabled()) throw unavailable()
    if (this.rt.config?.godbotStateDir) assertProviderAccountSelectable(this.rt.config.godbotStateDir, target.kind, target.accountId)
    const current = this.workspace({ accountId: target.accountId, kind: target.kind, cwd })
    if (target.workspaceTag && target.workspaceTag !== workspaceTag(current)) throw new Error('所选沙箱路由与工作目录不一致。')
    return { accountProfileId: target.accountId, sandboxKind: target.kind, sandboxBinding: savedBinding(current) }
  }
  async probeModels(route, baseSpec) {
    const target = sandboxRouteInfo(route)
    if (!target || !this.enabled()) throw unavailable()
    const account = this.accountList().find(a => a.id === target.accountId && a.kinds.includes(target.kind))
    if (!account?.workspaces.length) throw unavailable()
    const bot = target.workspaceTag && Object.values(this.rt.state.bots ?? {}).find(bot => provider(bot.model) === route)
    const input = { accountId: account.id, kind: target.kind, cwd: bot?.workDir ?? account.workspaces[0].hostPath }
    const current = this.workspace(input)
    if (target.workspaceTag && target.workspaceTag !== workspaceTag(current)) throw unavailable()
    const engine = this.engineFor(target, baseSpec, current, () => this.launch(input))
    const rows = await engine.probeSandboxModels()
    if (!this.enabled()) throw unavailable()
    matchBinding(current, this.workspace(input))
    // A base route can be shared by Bots on different exports of the account.
    const workspaceSpecific = target.workspaceTag !== undefined || account.workspaces.length === 1
    const models = rows.filter(row => typeof row.id === 'string' && row.id !== 'default')
      .map(({ id, name, reasoning, inputModalities }) => ({ id, name: name ?? id, provider: route,
        ...(reasoning ? { reasoning } : {}), ...(workspaceSpecific && inputModalities ? { inputModalities } : {}) }))
    this.models.set(route, { rows: models, supportsImages: workspaceSpecific ? engine.supportsImages?.() : undefined })
  }
  async bind({ botId, accountProfileId, kind, cwd }) {
    const rt = this.rt
    if (rt.readOnly() || (accountProfileId !== null && !this.enabled())) throw unavailable()
    const bot = rt.botOf(botId)
    if (!bot || this.changes.has(botId)) throw new Error('找不到当前 Bot，或账号切换尚未完成。')
    const oldRoute = provider(bot.model ?? bot.appliedModel)
    const old = sandboxRouteInfo(oldRoute)
    const account = accountProfileId === null ? undefined : this.accountList().find(a => a.id === accountProfileId)
    if (accountProfileId !== null && !account) throw unavailable()
    const requested = kind ?? old?.kind ?? Object.keys(baseRoutes).find(k => baseRoutes[k] === oldRoute) ?? (account?.kinds.length === 1 ? account.kinds[0] : undefined)
    if (!Object.hasOwn(baseRoutes, requested) || (account && !account.kinds.includes(requested))) throw new Error('该账号未提供所选 Agent。')
    if (!account && !old && oldRoute === baseRoutes[requested]) return bot
    let route = account ? sandboxRoute(requested, account.id) : baseRoutes[requested]
    const dir = cwd ?? (account ? account.workspaces[0]?.hostPath : bot.workDir)
    const fields = this.savedBotFields(route + '/default', dir)
    if (old && account?.id === old.accountId && requested === old.kind) {
      const next = fields.sandboxBinding
      if (bot.sandboxBinding?.bindingId === next.bindingId && bot.sandboxBinding.hostCwd === next.hostCwd &&
          bot.sandboxBinding.guestCwd === next.guestCwd) return bot
      // NativeCrew rotates all private and group parts when their provider changes.
      // Give the newly selected workspace its own route, even on the same VM.
      route += '_w_' + workspaceTag(next)
    }
    // Check and reserve synchronously. A rejected switch never makes an active
    // turn momentarily look unbound while checking or saving its session.
    rt.assertSandboxBotIdle(botId)
    this.changes.add(botId)
    this.pendingRoutes.add(route)
    try {
      rt.registerSandboxRoutes?.()
      return await rt.updateBot(botId, { model: route + '/default', workDir: dir, changeEngine: true, [bindingChange]: true })
    } finally {
      this.pendingRoutes.delete(route)
      this.changes.delete(botId)
      rt.registerSandboxRoutes?.()
    }
  }
  async closePart(id, reason) {
    const entry = this.parts.get(String(id))
    if (!entry) return
    await entry.adapter.closeSession(String(id), reason)
    await entry.adapter.dispose()
    if (this.parts.get(String(id)) === entry) this.parts.delete(String(id))
  }
  async dispose() { await Promise.all([...this.parts.keys()].map(id => this.closePart(id))) }
}

export const bindingChange = Symbol('owner account change')

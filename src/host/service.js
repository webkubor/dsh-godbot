import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readHistoricalClaudeUsage } from './claude-report-history.js'
import { readClaudeStats } from './claude-stats.js'
import { Store } from './store.js'
import { BotTaskWorkspace, botWorkspaceId, botWorkspaceSnapshot } from './bot-task-workspace.js'
import { getSandboxWorkspace, resolveSandboxLaunch } from './sandbox-accounts.js'
import { sandboxAccountsEnabled, sandboxSettings, setSandboxEnabled } from './sandbox-settings.js'
import { ProviderAccounts } from './provider-accounts.js'
import { ProviderUsage } from './provider-usage.js'
import { nativeUsageAdapters } from './native-provider-quota.js'
import { AutomationApi } from './automation-api.js'
import { AutomationSetup } from './automation-setup.js'
import { NativeRoutines } from './native-routines.js'
import { UsagePolicy } from './usage-policy.js'
import { localProviderUsage, refreshLocalProviderUsage } from './local-provider-usage.js'
import { resolveSlash, teamSlashPrefix } from './slash.js'
import { teamWorkspace } from './team-workspace.js'

const localRoutes = { antigravity: 'local-antigravity', claude: 'local-claude-code', codex: 'local-codex-cli' }
const claudeConfigDir = cwd => process.env.CLAUDE_CONFIG_DIR ? resolve(cwd, process.env.CLAUDE_CONFIG_DIR) : undefined
const readActions = new Set(['team-workspace.management', 'team-workspace.inbox', 'team-workspace.scheduleList',
  'team-workspace.scheduleHistory', 'team-workspace.templateExport', 'team-workspace.templatePreview', 'team-workspace.templatePlans',
  'provider-usage', 'local-provider-usage', 'provider-accounts', 'sandbox-settings', 'connector.tools', 'budget.view',
  'workflow.list', 'automation.routine.list', 'automation.routine.history', 'automation.list', 'automation.people.list'])

export function readOnlyWorkspaceSnapshot(stateDir, runtime) {
  const file = join(stateDir, 'godbot.sqlite3')
  if (!existsSync(file)) return botWorkspaceSnapshot(runtime, [], [])
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'").get())
      return botWorkspaceSnapshot(runtime, [], [])
    const query = db.prepare("SELECT seq,data FROM records WHERE collection=? AND json_extract(data,'$.teamId')=? ORDER BY seq")
    const rows = collection => query.all(collection, botWorkspaceId).map(row => ({ ...JSON.parse(row.data), seq: Number(row.seq) }))
    return botWorkspaceSnapshot(runtime, rows('tasks'), rows('messages'))
  } finally { db.close() }
}

/** Management and automation share the Bot roster, its sessions and its work receipts. */
export class NativeCrewService {
  constructor({ stateDir, runtime, config = {}, subprocess }) {
    if (runtime.readOnly()) throw new Error(runtime.readOnly())
    this.stateDir = stateDir
    this.runtime = runtime
    this.database = new Store(stateDir)
    try {
      this.database.resetIndependentTeams()
      this.botTasks = new BotTaskWorkspace(this.database, runtime)
      this.store = this.botTasks.store
      this.team = this.botTasks.team
      this.automation = new AutomationApi(this, config.automation)
      this.automationSetup = new AutomationSetup(this)
      this.routines = new NativeRoutines(this)
      this.budgets = new UsagePolicy(this)
      this.providerUsage = new ProviderUsage(stateDir, config.drivers ?? {}, { nativeProviders: nativeUsageAdapters(subprocess) })
      this.providerAccounts = new ProviderAccounts(stateDir, config.drivers ?? {}, {
        inUse: (kind, account) => Object.values(runtime.state.bots).some(bot =>
          (bot.accountProfileId ?? null) === account && (account ? bot.sandboxKind === kind : runtime.engineOfBot(bot) === localRoutes[kind])),
      })
    } catch (error) {
      this.botTasks?.dispose()
      this.database.close()
      throw error
    }
  }

  async start(ctx) {
    this.automation.full.attach(this.runtime)
    this.budgets.attach(ctx)
    this.automation.github.restore()
    this.routines.arm()
    if (this.store.get('automationSettings', 'listener') || this.automation.people.oidc.enabled()) {
      await this.automation.start().catch(error => { this.automation.listenError = error.message })
    }
  }

  async close() {
    this.closing = true
    this.routines.close()
    try {
      const stopped = await Promise.allSettled([this.automation.close(), this.providerAccounts.close(), this.providerUsage.close()])
      const failed = stopped.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
    } finally {
      this.automation.full.detach?.()
      this.botTasks.dispose()
      this.budgets.close()
      this.database.close()
    }
  }
  accountWorkspace(accountProfileId, kind, cwd) {
    if (accountProfileId == null) return null
    if (typeof accountProfileId !== 'string' || !accountProfileId.trim()) throw new Error('请选择有效的沙箱账号。')
    if (!sandboxAccountsEnabled(this.stateDir)) throw new Error('请先在设置中启用多账号沙箱。')
    return getSandboxWorkspace({ accountId: accountProfileId, kind, cwd })
  }
  checkBinding(stored, workspace) {
    if (!stored || stored.bindingId !== workspace.bindingId || stored.hostCwd !== workspace.hostCwd || stored.guestCwd !== workspace.guestCwd)
      throw new Error('沙箱账号或工作区的绑定已改变，请新建会话。')
  }
  async sandboxTerminal(lease) {
    const kind = Object.keys(localRoutes).find(key => localRoutes[key] === lease.agent)
    if (!kind) throw new Error('未知的 Bot 原生终端类型。')
    const mapped = this.accountWorkspace(lease.accountProfileId, kind, lease.cwd)
    this.checkBinding(lease.sandboxBinding, mapped)
    if (mapped.readOnly) throw new Error('这个宿主挂载是只读的，无法接管交互终端。')
    const launch = await resolveSandboxLaunch({ accountId: lease.accountProfileId, kind, cwd: lease.cwd })
    try {
      this.checkBinding(lease.sandboxBinding, launch)
      this.checkBinding(lease.sandboxBinding, this.accountWorkspace(lease.accountProfileId, kind, lease.cwd))
      return launch
    } catch (error) {
      await launch.close()
      throw error
    }
  }
  async slashTarget(target) {
    if (!target?.botId || target.memberId || target.roomId) throw new Error('请选择当前 Bot 的私聊。')
    const rt = this.runtime
    await rt.refresh()
    const bot = rt.state.bots[target.botId]
    if (!bot || bot.id !== target.botId) throw new Error('Bot no longer exists')
    const route = rt.engineOfBot(bot)
    if ((target.sessionId && target.sessionId !== rt.chatOf(bot.id)) || (target.expectedRoute && target.expectedRoute !== route))
      throw new Error('Bot 的对话或运行方式已切换，请重新选择命令。')
    const cwd = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
    return { rt, bot, route, cwd, rows: await rt.slashCatalog(route, cwd, rt.chatOf(bot.id)) }
  }
  async claudeReportSession(target) {
    const { botId, sessionId, seq, messageId } = target ?? {}
    if (typeof botId !== 'string' || typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || seq < 0)
      throw new Error('请选择具体的 Claude Code 命令回执。')
    const rt = this.runtime
    await rt.refresh()
    const archived = rt.pastOwners.get(sessionId)
    const owner = rt.chatOwners.get(sessionId) ?? (archived && !archived.roomId ? archived.botId : undefined)
    if (!rt.state.bots[botId] || owner !== botId) throw new Error('该会话不属于当前 Bot 的私聊。')
    // Only inspect the exact persisted reply. Never resume an old session to
    // generate a new number for what was originally a historical snapshot.
    const page = await rt.ctx.sessionController.page({
      address: { kind: 'session', sessionId }, throughSeq: seq, maxMessages: 1,
    }, AbortSignal.timeout(5000))
    const event = page.records.find(row => row.event.seq === seq)?.event
    const message = event?.data?.message
    if (event?.type !== 'assistant/message' || (messageId && message?.id !== messageId) ||
        message?.source?.provider !== 'local-claude-code') return null
    const usage = message.source.replayState?.response?.godbotClaudeSessionUsage
    if (usage) return usage
    const binding = rt.state.localAgents?.sessions?.[sessionId]
    if (binding?.accountProfileId || rt.state.bots[botId]?.accountProfileId || binding?.route !== 'local-claude-code' || !binding.cwd || !binding.cliSessionId) return null
    if (message.content?.length !== 1 || message.content[0].type !== 'text') return null
    return readHistoricalClaudeUsage({ cwd: binding.cwd, configDir: claudeConfigDir(binding.cwd),
      nativeId: binding.cliSessionId, text: message.content[0].text, time: event.time })
  }
  async claudeStats(target) {
    const rt = this.runtime
    await rt.refresh()
    const bot = rt.botOf(target?.botId)
    if (!bot || rt.engineOfBot(bot) !== 'local-claude-code' || (target.sessionId && target.sessionId !== rt.chatOf(bot.id)))
      throw new Error('请选择当前 Claude Code Bot 的私聊。')
    if (bot.accountProfileId) return { available: false, reason: 'sandbox' }
    return readClaudeStats({ configDir: claudeConfigDir(rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()) })
  }
  async slashCommands(target) {
    return (await this.slashTarget(target)).rows
  }
  async submitSlash(req) {
    const { rt, bot, route, cwd, rows } = await this.slashTarget(req)
    const command = resolveSlash(rows, req.name, req.args)
    const current = rt.state.bots[bot.id]
    if (rt.readOnly()) throw new Error(rt.readOnly())
    if (!current || (req.sessionId && rt.chatOf(bot.id) !== req.sessionId) || rt.engineOfBot(current) !== route || (rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()) !== cwd)
      throw new Error('Bot settings have changed. Choose the command again.')
    await rt.sendUser({ sessionId: bot.id, requestId: teamSlashPrefix + route + ':' + (req.requestId || randomUUID()),
      content: [{ type: 'text', text: command.text }] })
    return true
  }

  dispatch(req) {
    if (this.closing) throw new Error('NativeCrew is shutting down')
    const { action } = req
    const rt = this.runtime
    if (rt.readOnly() && (!readActions.has(action) || req.refreshHistory)) throw new Error(rt.readOnly())
    if (action === 'team-workspace.management') return this.botTasks.snapshot()
    if (action.startsWith('team-workspace.')) return teamWorkspace(this, req)
    if (action === 'provider-usage' || action === 'provider-usage-refresh') return this.providerUsage.dispatch(req)
    if (action === 'local-provider-usage') return req.refreshHistory ? refreshLocalProviderUsage(this) : localProviderUsage(this)
    if (action === 'provider-accounts' || action.startsWith('provider-account-')) return this.providerAccounts.dispatch(req)
    if (action === 'sandbox-settings') return sandboxSettings(this.stateDir)
    if (action === 'sandbox-settings-set') {
      const settings = setSandboxEnabled(this.stateDir, req.enabled)
      return Promise.resolve(rt.syncSandboxRoutes?.()).then(() => settings)
    }
    if (action === 'sandbox-bot-bind') return rt.bindSandboxBot(req)
    if (action === 'connector.tools') return rt.connectorTools.view(req.botId, req.sessionId)
    if (action.startsWith('governance.')) return rt.governance.handle(req)
    if (action.startsWith('components.')) return rt.components.handle(req)
    if (action.startsWith('remote-agents.')) return rt.remoteAgentEndpoint(req)
    if (action === 'slash.run') return this.submitSlash(req)
    if (action === 'budget.view' || action === 'budget.configure') {
      const subject = req.subject || 'profile'
      if (subject !== 'profile' && !rt.botOf(subject)) throw new Error('请选择当前工作区的 Bot。')
      if (action === 'budget.configure') this.budgets.configure(subject, req.settings ?? {})
      return this.budgets.snapshot(subject)
    }
    if (req.teamId != null && req.teamId !== botWorkspaceId) throw new Error('请选择当前 Bot 团队。')
    const scoped = { ...req, teamId: botWorkspaceId }
    if (action === 'workflow.list') return this.botTasks.workflows()
    if (action.startsWith('automation.setup.')) return this.automationSetup.handle(scoped)
    if (action.startsWith('automation.routine.')) return this.routines.owner(scoped)
    if (action.startsWith('automation.')) return this.automation.owner(scoped)
    if (action.startsWith('task.') || action === 'workflow.save' || action === 'workflow.run') return this.botTasks.mutate(scoped)
    throw new Error('未知的 Bot 工作区操作。')
  }
}

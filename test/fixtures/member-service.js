import { teamWorkspace } from '../../src/host/team-workspace.js'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { readHistoricalClaudeUsage } from '../../src/host/claude-report-history.js'
import { readClaudeStats } from '../../src/host/claude-stats.js'
import { Store, collections } from './member-store.js'
import { listWorkflows, saveWorkflow, startWorkflow } from '../../src/host/workflows.js'
import { TeamActions, activeTeam, addMember, createTeam, now, profileChanges, record, required, teamMember } from './member-team.js'
import { MemberMcp } from './member-mcp.js'
import { prepareMemberWorkspace, workspaceBlocker } from './member-workspace.js'
import { buildId } from '../../src/host/build-id.js'
import { getSandboxWorkspace, resolveSandboxLaunch } from '../../src/host/sandbox-accounts.js'
import { sandboxAccountsEnabled, sandboxSettings, setSandboxEnabled } from '../../src/host/sandbox-settings.js'
import { assertProviderAccountSelectable, getDefaultProviderAccount, ProviderAccounts } from '../../src/host/provider-accounts.js'
import { ProviderUsage } from '../../src/host/provider-usage.js'
import { nativeUsageAdapters } from '../../src/host/native-provider-quota.js'
import { TeamImportBridge } from './team-import.js'
import { AutomationApi } from '../../src/host/automation-api.js'
import { NativeRoutines } from '../../src/host/native-routines.js'
import { UsagePolicy, nativeUsageBinding } from './member-usage.js'
import { localProviderUsage, refreshLocalProviderUsage } from '../../src/host/local-provider-usage.js'
import { listSlashCommands } from '../../src/host/slash-catalog.js'
import { parseSlash, resolveSlash, slashInput, teamSlashPrefix } from '../../src/host/slash.js'

const terminal = new Set(['completed', 'interrupted', 'failed', 'unknown'])
const errorText = (error) => String(error?.message ?? error)
const canonical = (input) =>
  JSON.stringify(input, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  )
const digest = (data) => 'sha256:' + createHash('sha256').update(data).digest('hex')

function claudeConfigDir(cwd, environment) {
  const home = process.platform === 'win32' ? environment?.USERPROFILE : environment?.HOME
  const folder = environment?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? (home && join(home, '.claude'))
  return folder ? resolve(cwd, folder) : undefined
}

function storedReply(interaction, decision, answer) {
  const secrets = (interaction.questions ?? []).filter((q) => q.isSecret).map((q) => q.id)
  if (!secrets.length) return { decision, answer }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer))
    return { decision: 'answered', answer: '[redacted]' }
  return {
    decision: 'answered',
    answer: Object.fromEntries(
      Object.entries(answer).map(([id, value]) => [id, secrets.includes(id) ? '[redacted]' : value]),
    ),
  }
}

export class NativeCrewService {
  constructor({ stateDir, openDriver, teamRuntime, subprocess, driverConfig = {}, config = {} }) {
    this.store = new Store(stateDir)
    this.automation = new AutomationApi(this, config.automation)
    this.routines = new NativeRoutines(this)
    this.budgets = new UsagePolicy(this)
    this.budgetTimers = new Map()
    this.stateDir = stateDir
    this.teamBridge = new TeamImportBridge(this, teamRuntime, config.importWorkspaceParent)
    this.stopTimers = new Map()
    this.textBuffers = new Map()
    this.stopTimeoutMs = config.stopTimeoutMs || 30000
    this.openDriver = openDriver
    this.driverConfig = Object.keys(driverConfig).length ? driverConfig : (config.drivers ?? {})
    this.providerUsage = new ProviderUsage(stateDir, this.driverConfig, { nativeProviders: nativeUsageAdapters(subprocess) })
    this.providerAccounts = new ProviderAccounts(stateDir, this.driverConfig, {
      inUse: (kind, id) => {
        if (this.store.all('members').some(m => m.kind === kind && (m.accountProfileId ?? null) === id)) return true
        const rt = this.teamBridge.rt
        const nativeRoutes = { antigravity: 'local-antigravity', claude: 'local-claude-code', codex: 'local-codex-cli' }
        return Object.values(rt?.state?.bots ?? {}).some(bot => (bot.accountProfileId ?? null) === id &&
          (id ? bot.sandboxKind === kind : rt.engineOfBot(bot) === nativeRoutes[kind]))
      },
    })
    this.team = new TeamActions(
      this.store,
      (req) => this.enqueue(req),
      (memberId, turnId) => this.stop(memberId, turnId),
    )
    this.terminalMembers = new Map()
    this.resident = new Map()
    this.opening = new Map()
    this.epochs = new Map()
    this.operations = new Set()
    this.scheduled = new Set()
    this.workerOps = new Map()
    this.closing = false
    this.initialized = false
  }
  get runtime() { return this.teamBridge.rt }
  async ready() {
    if (this.initialized) return
    this.initialized = true
    if (this.teamBridge.getRuntime) void this.teamBridge.connect().catch(() => {})
    const s = this.store
    s.transaction(() => {
      for (const row of s.all('receipts')) {
        if (row.fingerprint && !row.fingerprint.startsWith('sha256:'))
          s.update('receipts', row.id, { fingerprint: digest(row.fingerprint) })
      }
      for (const item of s.all('interactions')) {
        if (item.answer !== undefined && item.questions?.some((q) => q.isSecret))
          s.update('interactions', item.id, storedReply(item, item.decision, item.answer))
      }
      for (const m of s.all('members')) {
        if (m.role === undefined || m.memory === undefined) s.update('members', m.id, { role: m.role ?? '', memory: m.memory ?? '' })
        if (!m.activeTurnId) continue
        const turn = s.get('turns', m.activeTurnId)
        if (turn && !terminal.has(turn.status)) {
          s.update('turns', turn.id, { status: 'unknown', endedAt: now() })
          this.team.turnEnded({
            member: m,
            turn,
            status: 'unknown',
            reason: 'Host restarted before native completion',
            answer: '',
          })
        }
        s.update('members', m.id, { status: 'unknown', activeTurnId: null })
        this.event(m, turn?.id, {
          type: 'recovery',
          text: 'Host restarted before native completion could be verified',
        })
      }
      for (const cmd of s.all('commands')) {
        if (['writing', 'awaiting-stop', 'awaiting-ack'].includes(cmd.status))
          s.update('commands', cmd.id, { status: 'unknown' })
      }
      for (const item of s.all('interactions'))
        if (['pending', 'answering'].includes(item.status))
          s.update('interactions', item.id, { status: 'expired' })
    })
    for (const m of s.all('members')) {
      if (m.status === 'preparing') this.prepareWorkspace(m)
      else if (m.status === 'connecting') this.maintain(m)
      else this.schedule(m.id)
    }
    this.automation.github.restore()
    this.routines.arm()
    if (s.get('automationSettings', 'listener')) await this.automation.start().catch(error => {
      this.automation.listenError = error.message
    })
  }
  snapshot(options) {
    const metadata = collections
      .filter((name) => name !== 'events')
      .map((name) => [name, name === 'members'
        ? this.store.all(name).map(member => this.terminalMembers.has(member.id) ? { ...member, terminalOwned: true } : member.kind === 'dsh' ? { ...member, ...this.dshRouteSource(member) } : member)
        : this.store.all(name)])
    return {
      buildId,
      donorLinks: this.teamBridge.links(),
      ...Object.fromEntries(metadata),
      ...this.store.eventSnapshot(options?.afterEventSeq, options?.eventStreamId),
    }
  }
  dshRouteSource(member) {
    if (member.followProfileDefault === true) return { routeSource: 'profile', followProfileDefault: true }
    if (member.route) return { routeSource: 'member', followProfileDefault: false }
    const host = this.driverConfig.dsh
    if (host && (host.provider != null || host.model != null)) {
      return { routeSource: 'host', followProfileDefault: false, hostRoute: {
        ...(host.provider != null ? { provider: host.provider } : {}), ...(host.model != null ? { model: host.model } : {}),
        ...(host.reasoningEffort != null ? { reasoningEffort: host.reasoningEffort } : {}),
      } }
    }
    return { routeSource: 'profile', followProfileDefault: true }
  }
  accountWorkspace(accountProfileId, kind, cwd) {
    if (accountProfileId == null) return null
    if (typeof accountProfileId !== 'string' || !accountProfileId.trim()) throw new Error('请选择有效的沙箱账号。')
    if (!sandboxAccountsEnabled(this.stateDir)) throw new Error('请先在设置中启用多账号沙箱。')
    return getSandboxWorkspace({ accountId: accountProfileId, kind, cwd })
  }
  accountBinding(workspace) {
    return workspace && { bindingId: workspace.bindingId, hostCwd: workspace.hostCwd, guestCwd: workspace.guestCwd }
  }
  checkBinding(stored, workspace) {
    if (!stored || stored.bindingId !== workspace.bindingId || stored.hostCwd !== workspace.hostCwd || stored.guestCwd !== workspace.guestCwd)
      throw new Error('沙箱账号或工作区的绑定已改变，请新建会话。')
  }
  async sandboxTerminal(lease) {
    const kinds = { 'local-claude-code': 'claude', 'local-codex-cli': 'codex', 'local-antigravity': 'antigravity' }
    const kind = kinds[lease.agent] ?? lease.agent
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
  workspacePeers() {
    return this.store.all('members').map(member => this.terminalMembers.has(member.id)
      ? { ...member, terminalOwned: true } : member)
  }

  async claimMemberTerminal(memberId) {
    if (this.teamBridge.getRuntime) await this.teamBridge.nativeReady()
    const member = this.store.require('members', memberId)
    activeTeam(this.store, member.teamId)
    this.teamBridge.assertNativeWorkspace(member.cwd)
    this.teamBridge.assertNativeWorkspace(member.sourceRoot ?? member.workspaceRoot)
    if (!['claude', 'codex', 'antigravity'].includes(member.kind) || member.workspaceMode === 'shared-readonly')
      throw new Error('此成员的运行方式不支持交互终端。')
    if (this.closing || this.terminalMembers.has(member.id) || member.activeTurnId || member.maintenance ||
        member.status !== 'idle' || this.workerOps.has(member.id) || this.opening.has(member.id) ||
        this.store.all('commands').some(c => c.memberId === member.id && ['queued','writing','awaiting-ack','awaiting-stop'].includes(c.status)) ||
        workspaceBlocker(member, this.workspacePeers()))
      throw new Error('请等待或停止当前任务，待工作区空闲后再接手终端。')
    if (!member.nativeId) throw new Error('请先给这个 Bot 发一条消息，建立可接手的原生会话。')
    if (this.store.all('members').some(other => other.id !== member.id &&
        other.kind === member.kind && (other.accountProfileId ?? null) === (member.accountProfileId ?? null) && other.nativeId === member.nativeId))
      throw new Error('多个成员绑定了同一原生会话，无法独占接手。')
    if (member.accountProfileId) {
      const workspace = this.accountWorkspace(member.accountProfileId, member.kind, member.cwd)
      this.checkBinding(member.sandboxBinding, workspace)
      if (workspace.readOnly) throw new Error('这个宿主挂载是只读的，无法接管交互终端。')
    }
    const controller = new AbortController()
    this.terminalMembers.set(member.id, controller)
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.terminalMembers.delete(member.id)
      if (!this.closing) for (const other of this.store.all('members')) this.schedule(other.id)
    }
    try {
      await this.detach(member.id)
      return { agent: member.kind, cwd: member.cwd, sessionId: member.nativeId,
        ...(member.accountProfileId ? { accountProfileId: member.accountProfileId, sandboxBinding: member.sandboxBinding } : {}),
        config: { ...(member.accountProfileId ? {} : this.driverConfig[member.kind]), ...member.nativeSettings },
        stillCurrent: () => {
          const current = this.store.get('members', member.id)
          return current?.nativeId === member.nativeId && current.cwd === member.cwd &&
            current.accountProfileId === member.accountProfileId && current.sandboxBinding?.bindingId === member.sandboxBinding?.bindingId
        },
        signal: controller.signal, release }
    } catch (error) {
      release()
      throw error
    }
  }

  async slashTarget(target) {
    if (!target || !!target.botId === !!target.memberId || target.roomId) throw new Error('请选择一名 Agent 的私聊。')
    if (target.botId) {
      const rt = await this.teamBridge.connect()
      await rt.refresh()
      const bot = rt.state.bots[target.botId]
      if (!bot || bot.id !== target.botId) throw new Error('Bot no longer exists')
      const route = rt.engineOfBot(bot)
      if ((target.sessionId && target.sessionId !== rt.chatOf(bot.id)) || (target.expectedRoute && target.expectedRoute !== route))
        throw new Error('Bot 的对话或运行方式已切换，请重新选择命令。')
      const cwd = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
      return { rt, bot, route, cwd, rows: await rt.slashCatalog(route, cwd, rt.chatOf(bot.id)) }
    }
    const member = this.store.require('members', target.memberId)
    activeTeam(this.store, member.teamId)
    if (this.teamBridge.getRuntime) await this.teamBridge.nativeReady()
    this.teamBridge.assertNativeWorkspace(member.cwd)
    if (member.accountProfileId) this.accountWorkspace(member.accountProfileId, member.kind, member.cwd)
    const driver = this.resident.get(member.id)?.driver
    const commands = await driver?.slashMetadata?.()
    const rows = await listSlashCommands({ agent: member.kind, cwd: member.cwd, config: this.driverConfig[member.kind], commands, liveOnly: !!member.accountProfileId })
    return { member, rows }
  }
  async claudeReportSession(target) {
    if (target?.memberId) {
      if (target.botId || target.sessionId) throw new Error('请选择具体的 Claude Code 命令回执。')
      const member = this.store.require('members', target.memberId)
      const event = this.store.get('events', target.eventId)
      if (member.kind !== 'claude' || event?.type !== 'text' || event.memberId !== member.id) return null
      const turn = this.store.get('turns', event.turnId)
      const input = this.store.get('commands', turn?.commandId)
      if (!input || input.messageId || !/^\/(?:usage|cost|stats)$/u.test(input.text?.trim())) return null
      if (event.sessionUsage) return event.sessionUsage
      if (member.accountProfileId || event.accountProfileId) return null
      const nativeId = this.store.nativeIdAt(event)
      if (!nativeId) return null
      return readHistoricalClaudeUsage({ cwd: member.cwd, configDir: claudeConfigDir(member.cwd, this.driverConfig.claude?.env),
        nativeId, text: event.text, time: event.createdAt })
    }
    const { botId, sessionId, seq, messageId } = target ?? {}
    if (typeof botId !== 'string' || typeof sessionId !== 'string' || !Number.isSafeInteger(seq) || seq < 0)
      throw new Error('请选择具体的 Claude Code 命令回执。')
    const rt = await this.teamBridge.connect()
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
    if (!target || !!target.memberId === !!target.botId || target.roomId) throw new Error('请选择 Claude Code 的私聊。')
    let cwd, environment
    if (target.botId) {
      const rt = await this.teamBridge.connect()
      await rt.refresh()
      const bot = rt.state.bots[target.botId]
      if (!bot || bot.id !== target.botId || rt.engineOfBot(bot) !== 'local-claude-code' ||
          (target.sessionId && target.sessionId !== rt.chatOf(bot.id))) throw new Error('当前对话未使用 Claude Code。')
      if (bot.accountProfileId) return { available: false, reason: 'sandbox' }
      cwd = rt.workDirOf({ botId: bot.id }) ?? rt.teamFolder()
    } else {
      const member = this.store.require('members', target.memberId)
      if (member.kind !== 'claude') throw new Error('当前成员未使用 Claude Code。')
      if (member.accountProfileId) return { available: false, reason: 'sandbox' }
      cwd = member.cwd
      environment = this.driverConfig.claude?.env
    }
    // Follow the actual child configuration. Paths in an RPC payload have no
    // bearing on which user's CLI data is read.
    return readClaudeStats({ configDir: claudeConfigDir(cwd, environment) })
  }
  async slashCommands(target) {
    return (await this.slashTarget(target)).rows
  }
  async submitSlash(req) {
    const { rt, bot, route, cwd, member, rows } = await this.slashTarget(req)
    const command = resolveSlash(rows, req.name, req.args)
    if (!bot) {
      const current = this.store.require('members', member.id)
      if (current.cwd !== member.cwd || current.accountProfileId !== member.accountProfileId) throw new Error('The Agent workspace or account has changed')
      if (command.protocol && req.mode === 'steer') throw new Error('这条命令会开启独立回合，请选择排队或打断后发送。')
      return this.mutate(req, null, command)
    }
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
    // dispatch is called by the owner RPC. Agent tools only reach mutate with their actor.
    if (req?.action === 'provider-usage' || req?.action === 'provider-usage-refresh')
      return this.providerUsage.dispatch(req)
    if (req?.action === 'local-provider-usage')
      return req.refreshHistory === true ? refreshLocalProviderUsage(this) : localProviderUsage(this)
    if (req?.action === 'provider-accounts' && this.teamBridge.getRuntime && !this.teamBridge.rt && !this.teamBridge.disabled)
      return this.teamBridge.connect().catch(() => {}).then(() => this.providerAccounts.view())
    if (req?.action === 'provider-accounts' || req?.action?.startsWith('provider-account-'))
      return this.providerAccounts.dispatch(req)
    if (req?.action === 'sandbox-settings') return sandboxSettings(this.stateDir)
    if (req?.action === 'sandbox-settings-set') {
      const settings = setSandboxEnabled(this.stateDir, req.enabled)
      const syncing = this.teamBridge.rt?.syncSandboxRoutes?.()
      if (settings.enabled) for (const m of this.store.all('members')) if (m.accountProfileId) this.schedule(m.id)
      return syncing?.then ? syncing.then(() => settings) : settings
    }
    if (req?.action === 'sandbox-bot-bind') return this.teamBridge.connect().then(rt => rt.bindSandboxBot(req))
    if (req?.action?.startsWith('team-workspace.')) return teamWorkspace(this, req)
    if (req?.action === 'workflow.list') return listWorkflows(this.store, req.teamId)
    if (req?.action === 'automation.routine.list' || req?.action === 'automation.routine.history') return this.routines.owner(req)
    if (req?.action?.startsWith('automation.routine.')) return this.mutate(req, null)
    if (req?.action?.startsWith('automation.')) return this.automation.owner(req)
    if (req?.action === 'budget.view' || req?.action === 'budget.configure') {
      const subject = req.subject || 'profile'
      if (subject !== 'profile' && !this.store.get('members', subject) && !this.teamBridge.rt?.botOf(subject))
        throw new Error('Unknown budget subject')
      if (req.action === 'budget.configure') {
        this.budgets.configure(subject, req.settings ?? {})
        for (const member of this.store.all('members')) this.schedule(member.id)
      }
      return this.budgets.snapshot(subject)
    }
    if (req?.action === 'slash.run') return this.submitSlash(req)
    if (req?.action === 'member.send' || req?.action === 'queue.edit') {
      const parsed = parseSlash(req.text)
      const memberId = req.action === 'member.send' ? req.memberId : this.store.get('commands', req.commandId)?.memberId
      if (parsed && memberId && this.store.get('members', memberId)?.kind !== 'dsh') {
        return this.slashTarget({ memberId }).then(({ member, rows }) => {
          const current = this.store.require('members', memberId)
          if (current.cwd !== member.cwd || current.accountProfileId !== member.accountProfileId) throw new Error('The Agent workspace or account has changed')
          const row = rows.find(row => row.name === parsed.name && (parsed.prefix === '/' || row.kind === 'skill'))
          const command = row && resolveSlash(rows, parsed.name, parsed.args)
          if (command?.protocol && req.mode === 'steer') throw new Error('这条命令需要独立回合。')
          return this.mutate(req, null, command)
        })
      }
    }
    if (req?.action === 'connector.tools') return this.teamBridge.connect().then(rt => rt.connectorTools.view(req.botId, req.sessionId))
    if (req?.action === 'legacy.preview') return this.teamBridge.preview(req)
    if (req?.action === 'legacy.import') return this.teamBridge.import(req)
    if (req?.action === 'legacy.links') return this.teamBridge.connect().then(() => this.teamBridge.links())
    if (['legacy.sources', 'legacy.handoffPreview', 'legacy.handoffConfirm'].includes(req?.action)) return this.teamBridge.sources(req)
    if (this.teamBridge.getRuntime && !this.teamBridge.rt && !this.teamBridge.disabled &&
        ['member.add', 'team.create', 'member.profile'].includes(req?.action)) {
      return this.teamBridge.nativeReady().then(() => this.mutate(req, null))
    }
    return this.mutate(req, null)
  }
  mutate(req, actor, slash) {
    if (this.closing) throw new Error('NativeCrew is shutting down')
    if (!req || typeof req.action !== 'string') throw new Error('Missing NativeCrew action')
    const s = this.store
    if (this.teamBridge.running.size) {
      const teams = [req.teamId, s.get('members', req.memberId)?.teamId, s.get('tasks', req.taskId)?.teamId,
        s.get('commands', req.commandId)?.teamId, s.get('interactions', req.interactionId)?.teamId, actor?.teamId]
      if (teams.some(id => this.teamBridge.running.has(id))) throw new Error('Team import is in progress. Try again after it finishes.')
    }
    const receipt = req.requestId ? `${actor?.id ?? 'owner'}/${req.requestId}` : undefined
    if (receipt) {
      const previous = s.get('receipts', receipt)
      if (previous) {
        if (previous.fingerprint !== digest(canonical(req)))
          throw new Error('Request ID already used for different input')
        return previous.result
      }
    }
    const result = s.transaction(() => {
      const result = this.act(req, actor, slash)
      if (receipt) s.put('receipts', { id: receipt, fingerprint: digest(canonical(req)), result })
      return result
    })
    // Effects begin on a later microtask, after the write transaction commits.
    return result
  }
  act(req, actor, slash) {
    const s = this.store
    if (!actor && req.action === 'workflow.save') return saveWorkflow(s, req)
    if (!actor && req.action === 'workflow.run') return startWorkflow(this, req)
    if (!actor && req.action.startsWith('automation.routine.')) return this.routines.apply(req)
    if (req.memberId && this.terminalMembers.has(req.memberId) && req.action.startsWith('member.'))
      throw new Error('当前会话由原生终端控制，请先在终端中交还聊天。')
    switch (req.action) {
      case 'team.create':
        this.teamBridge.assertNativeWorkspace(req.cwd)
        return createTeam(s, req)
      case 'member.add': {
        if (!actor && !Object.hasOwn(req, 'accountProfileId')) {
          const preferred = getDefaultProviderAccount(this.stateDir, req.kind)
          if (preferred) req = { ...req, accountProfileId: preferred.id, cwd: req.cwd || preferred.workspaces[0].hostPath }
        }
        assertProviderAccountSelectable(this.stateDir, req.kind, req.accountProfileId)
        this.teamBridge.assertNativeWorkspace(req.cwd || s.require('teams', req.teamId).cwd)
        let member = addMember(s, req, this.stateDir)
        if (req.accountProfileId != null) {
          const workspace = this.accountWorkspace(req.accountProfileId, member.kind, member.cwd)
          member = s.update('members', member.id, { sandboxBinding: this.accountBinding(workspace) })
        }
        this.teamBridge.assertNativeWorkspace(member.sourceRoot ?? member.workspaceRoot)
        if (member.status === 'preparing') this.prepareWorkspace(member)
        return member
      }
      case 'member.profile': {
        const member = s.require('members', req.memberId)
        activeTeam(s, member.teamId)
        this.teamBridge.assertNativeWorkspace(req.cwd)
        const { fields, workspace } = profileChanges(s, member, req, this.stateDir)
        const accountChange = Object.hasOwn(req, 'accountProfileId') && (req.accountProfileId ?? null) !== (member.accountProfileId ?? null)
        if (accountChange) assertProviderAccountSelectable(this.stateDir, member.kind, req.accountProfileId)
        if (accountChange && (member.nativeId || this.resident.has(member.id) || this.opening.has(member.id) ||
            member.activeTurnId || member.maintenance || !['idle','disconnected'].includes(member.status) ||
            s.all('commands').some(cmd => cmd.memberId === member.id && cmd.status === 'queued')))
          throw new Error('已建立或正在使用的会话需要通过新建会话来更换账号。')
        const selection = workspace || accountChange
          ? this.accountWorkspace(Object.hasOwn(req, 'accountProfileId') ? req.accountProfileId : member.accountProfileId, member.kind, workspace?.cwd ?? member.cwd)
          : null
        this.teamBridge.assertNativeWorkspace(workspace?.sourceRoot ?? workspace?.workspaceRoot)
        // There is no prior session to disconnect in this branch. Publish the account and
        // workspace together, including a first binding on an existing local member.
        if (accountChange) return s.update('members', member.id, {
          ...fields, ...(workspace ?? {}), status: 'idle', lastError: null, nativeOptions: null, nativeSettings: null, sandboxBinding: this.accountBinding(selection),
        })
        const correctingWorkspace = member.status === 'disconnected' && member.maintenance?.kind === 'workspace'
        if (correctingWorkspace && !workspace && 'cwd' in req) {
          const updated = s.update('members', member.id, { ...fields, status: 'connecting', maintenance: { kind: 'resume' } })
          this.maintain(updated)
          return { id: member.id, status: 'connecting', cwd: member.cwd }
        }
        if (!workspace) return s.update('members', member.id, fields)
        if (member.activeTurnId || !['idle', 'disconnected'].includes(member.status) || (member.maintenance && !correctingWorkspace)) {
          throw new Error('Resolve current activity before changing the member workspace')
        }
        if (s.all('commands').some(cmd => cmd.memberId === member.id && cmd.status === 'queued')) {
          throw new Error('Finish or withdraw queued work before changing its destination directory')
        }
        const updated = s.update('members', member.id, { ...fields, status: 'connecting', maintenance: {
          kind: 'workspace', workspace, ...(selection ? { sandboxBinding: this.accountBinding(selection) } : {}),
        } })
        this.maintain(updated)
        return { id: member.id, status: 'connecting', cwd: workspace.cwd }
      }
      case 'member.model': {
        const member = s.require('members', req.memberId)
        activeTeam(s, member.teamId)
        if (
          member.kind !== 'dsh' ||
          member.activeTurnId ||
          !['idle', 'disconnected'].includes(member.status) || member.maintenance?.kind === 'workspace'
        )
          throw new Error('Select a model on an idle dsh member')
        if (req.useDefault === true && (req.provider != null || req.model != null || req.reasoningEffort != null)) {
          throw new Error('Select either the profile default or a specific DSH route')
        }
        const followProfileDefault = req.useDefault === true
        const route = followProfileDefault ? null : {
          provider: required(req.provider, 'Provider'), model: required(req.model, 'Model'),
          reasoningEffort: req.reasoningEffort == null ? null : required(req.reasoningEffort, 'Reasoning effort'),
        }
        this.maintain(
          s.update('members', member.id, { route, followProfileDefault, routeStatus: 'applying', status: 'connecting', maintenance: { kind: 'resume' } }),
        )
        return { id: member.id, status: 'connecting', route, followProfileDefault }
      }
      case 'member.options':
      case 'member.configure': {
        const member = s.require('members', req.memberId)
        activeTeam(s, member.teamId)
        if (member.kind === 'dsh' || member.status !== 'idle' || member.activeTurnId)
          throw new Error('Native CLI options can be inspected on an idle external member')
        const settings = {}
        if (req.model !== undefined) settings.model = req.model === null ? null : required(req.model, 'Native model')
        if (req.mode !== undefined) settings.mode = required(req.mode, 'Native mode')
        if (req.effort !== undefined) settings.effort = req.effort === null ? null : required(req.effort, 'Native effort')
        const configure = req.action === 'member.configure'
        if (configure && !Object.keys(settings).length) throw new Error('Select a native option')
        this.maintain(s.update('members', member.id, { status: 'connecting', maintenance: { kind: 'options', ...(configure ? { settings } : {}) } }))
        return { id: member.id, status: 'connecting' }
      }
      case 'team.lead': {
        activeTeam(s, req.teamId)
        return s.update('teams', req.teamId, {
          leadId: teamMember(s, req.teamId, req.memberId).id,
          leadSelected: true,
        })
      }
      case 'team.send':
        return this.team.send(req, actor)
      case 'task.create':
        return this.team.assign(req, actor)
      case 'task.report':
        return this.team.report(req, actor)
      case 'task.review':
        return this.team.review(req)
      case 'task.transfer':
        return this.team.transfer(req)
      case 'task.retry':
        return this.team.retry(req)
      case 'task.fail':
        return this.team.fail(req, actor)
      case 'slash.run':
        return this.enqueue({ ...req, text: slash.text }, slash)
      case 'member.send':
        return this.enqueue(slash ? { ...req, text: slash.text } : req, slash)
      case 'member.stop':
        return this.stop(req.memberId, req.expectedTurnId)
      case 'member.forceStop': {
        const member = s.require('members', req.memberId)
        if (!member.activeTurnId || member.activeTurnId !== req.expectedTurnId)
          throw new Error('Target turn changed')
        const turn = s.require('turns', member.activeTurnId)
        s.update('members', member.id, { status: 'stopping' })
        s.update('turns', turn.id, { status: 'stopping' })
        queueMicrotask(() => {
          if (this.closing) return
          const force = (async () => {
            await this.opening.get(member.id)
            if (s.require('members', member.id).activeTurnId !== turn.id) return
            await this.detach(member.id, true)
            this.finish(member, turn, 'interrupted', 'Owner terminated the managed member')
          })().catch((error) => this.finish(member, turn, 'unknown', errorText(error)))
          this.operations.add(force)
          force.finally(() => this.operations.delete(force))
        })
        return { id: member.id, status: 'stopping', turnId: turn.id }
      }
      case 'member.newSession': {
        const member = s.require('members', req.memberId)
        activeTeam(s, member.teamId)
        if (member.activeTurnId || this.opening.has(member.id) || ['connecting', 'preparing', 'workspace-error'].includes(member.status))
          throw new Error('Finish current activity first')
        const hasAccount = Object.hasOwn(req, 'accountProfileId')
        const changing = hasAccount || Object.hasOwn(req, 'cwd')
        const accountProfileId = hasAccount ? req.accountProfileId : member.accountProfileId
        if (accountProfileId !== member.accountProfileId) assertProviderAccountSelectable(this.stateDir, member.kind, accountProfileId)
        const workspace = Object.hasOwn(req, 'cwd') ? profileChanges(s, member, { cwd: req.cwd }, this.stateDir).workspace : undefined
        this.teamBridge.assertNativeWorkspace(workspace?.cwd ?? member.cwd)
        this.teamBridge.assertNativeWorkspace(workspace?.sourceRoot ?? workspace?.workspaceRoot ?? member.workspaceRoot)
        const selection = this.accountWorkspace(accountProfileId, member.kind, workspace?.cwd ?? member.cwd)
        if (selection && !changing && member.sandboxBinding) this.checkBinding(member.sandboxBinding, selection)
        const summary = changing && !req.summary ? '' : required(req.summary, 'Handoff summary')
        this.maintain(
          s.update('members', member.id, {
            status: 'connecting',
            maintenance: { kind: 'new-session', summary, ...(hasAccount ? { accountProfileId: accountProfileId ?? null } : {}),
              ...(workspace ? { workspace } : {}), ...(selection ? { sandboxBinding: this.accountBinding(selection) } : {}) },
          }),
        )
        return { id: member.id, status: 'connecting' }
      }
      case 'team.stop':
      case 'team.resume': {
        const stopped = req.action === 'team.stop'
        const team = s.update('teams', req.teamId, { stopped })
        for (const member of s.all('members').filter((m) => m.teamId === team.id)) {
          if (stopped) this.terminalMembers.get(member.id)?.abort(new Error('团队已停止。'))
          if (stopped && member.activeTurnId) this.stop(member.id, member.activeTurnId)
          if (!stopped) this.schedule(member.id)
        }
        if (!stopped) for (const t of s.all('tasks').filter((t) => t.teamId === team.id)) this.team.wake(t)
        return team
      }
      case 'queue.edit':
      case 'queue.remove': {
        const cmd = s.require('commands', req.commandId)
        if (cmd.status !== 'queued' && cmd.status !== 'retained')
          throw new Error('Only unsent messages may be edited or removed')
        return s.update(
          'commands',
          cmd.id,
          req.action === 'queue.remove' ? { status: 'withdrawn' } : { text: slash?.text ?? required(req.text, 'Message'), ...((slash || cmd.slash) ? { slash: slash ?? null } : {}) },
        )
      }
      case 'interaction.respond':
        return this.answer(req)
      case 'member.reconnect': {
        const member = s.require('members', req.memberId)
        activeTeam(s, member.teamId)
        if (member.activeTurnId) throw new Error('A turn is active')
        if (member.status === 'workspace-error') {
          s.update('members', member.id, { status: 'preparing' })
          this.prepareWorkspace(member)
          return { id: member.id, status: 'preparing' }
        }
        if (['connecting', 'preparing'].includes(member.status))
          throw new Error('Reconnect already in progress')
        this.maintain(
          s.update('members', member.id, {
            status: 'connecting',
            ...(member.kind === 'dsh' ? { routeStatus: 'applying' } : {}),
            maintenance: member.maintenance ?? { kind: 'resume' },
          }),
        )
        return { id: member.id, status: 'connecting' }
      }
      default:
        throw new Error('Unsupported NativeCrew action: ' + req.action)
    }
  }
  maintain(member) {
    this.defer(member.id, async () => {
      const s = this.store
      if (member.maintenance?.kind === 'options') {
        const settings = member.maintenance.settings
        try {
          const driver = await this.handle(member)
          const nativeOptions = settings ? await driver.configure(settings) : await driver.describe()
          const nativeSettings = { ...member.nativeSettings, ...settings }
          const defaults = member.accountProfileId ? undefined : this.driverConfig[member.kind]
          const priorModel = member.nativeOptions?.currentModel ?? member.nativeSettings?.model ?? defaults?.model
          const priorEffort = member.nativeSettings && Object.hasOwn(member.nativeSettings, 'effort')
            ? member.nativeSettings.effort : defaults?.effort
          if (settings && 'model' in settings && !('effort' in settings) &&
              settings.model !== priorModel && priorEffort != null) nativeSettings.effort = null
          s.update('members', member.id, { status: 'idle', maintenance: null, lastError: null, nativeOptions, nativeSettings })
        } catch (error) {
          const observed = { ...member.nativeSettings }
          const actual = error.actualOptions
          // A multi-setting operation can change one native setting before the
          // next is refused. Store only explicit, independently observed values.
          if (actual && settings) {
            for (const [key, current] of [['model', actual.currentModel], ['mode', actual.currentMode], ['effort', actual.currentEffort]]) {
              if (settings[key] != null && settings[key] === current) observed[key] = current
            }
          }
          s.update('members', member.id, { status: 'idle', maintenance: null, lastError: errorText(error),
            ...(actual ? { nativeOptions: actual, nativeSettings: observed } : {}) })
          this.event(member, null, { type: 'configuration_error', text: errorText(error) })
        }
        this.schedule(member.id)
        return
      }
      try {
        await this.detach(member.id)
        if (member.maintenance?.kind === 'workspace') {
          const next = member.maintenance.workspace
          if (member.workspaceMode === 'worktree') await prepareMemberWorkspace({ ...member, ...next }, this.stateDir)
          const selection = this.accountWorkspace(member.accountProfileId, member.kind, next.cwd)
          if (selection) this.checkBinding(member.maintenance.sandboxBinding, selection)
          s.transaction(() => {
            this.event(member, null, { type: 'workspace_changed', previousNativeId: member.nativeId, previousCwd: member.cwd, cwd: next.cwd })
            s.update('members', member.id, { ...next, status: 'idle', maintenance: null, nativeId: null, nativeOptions: null, ...(selection ? { sandboxBinding: member.maintenance.sandboxBinding } : {}),
              ...(member.kind === 'dsh' ? { appliedRoute: null, routeStatus: null } : {}), lastError: null })
          })
          for (const available of s.all('members')) this.schedule(available.id)
        } else if (member.maintenance?.kind === 'new-session') {
          s.transaction(() => {
            const { summary, workspace } = member.maintenance
            const hasAccount = Object.hasOwn(member.maintenance, 'accountProfileId')
            const accountProfileId = hasAccount ? member.maintenance.accountProfileId : member.accountProfileId
            const selection = this.accountWorkspace(accountProfileId, member.kind, workspace?.cwd ?? member.cwd)
            if (selection) this.checkBinding(member.maintenance.sandboxBinding, selection)
            this.event(member, null, { type: 'handoff', text: summary, previousNativeId: member.nativeId })
            for (const pending of s
              .all('commands')
              .filter((c) => c.memberId === member.id && c.status === 'queued'))
              s.update('commands', pending.id, { status: 'retained' })
            s.update('members', member.id, {
              status: 'idle',
              maintenance: null,
              nativeId: null,
              ...(hasAccount || member.accountProfileId ? { sandboxBinding: this.accountBinding(selection), nativeOptions: null } : {}),
              ...(workspace ?? {}), ...(hasAccount ? { accountProfileId } : {}),
              ...((member.accountProfileId ?? null) !== (accountProfileId ?? null) ? { nativeSettings: null } : {}),
              ...(member.kind === 'dsh' ? { appliedRoute: null, routeStatus: null } : {}),
              lastError: null,
            })
            if (summary) this.enqueue({ memberId: member.id, text: summary, mode: 'queue' })
          })
        } else {
          await this.handle(s.require('members', member.id))
          s.update('members', member.id, { status: 'idle', maintenance: null, lastError: null })
          for (const available of s.all('members')) this.schedule(available.id)
        }
      } catch (error) {
        this.connectionError(member, error)
      }
    })
  }
  memberTool(memberId, name, args = {}, nativeCallId) {
    const s = this.store
    const actor = s.require('members', memberId)
    activeTeam(s, actor.teamId)
    if (actor.workspaceMode === 'shared-readonly' && name === 'assign_task')
      throw new Error('Read-only members cannot delegate write tasks')
    if (name === 'list_members')
      return s
        .all('members')
        .filter((m) => m.teamId === actor.teamId)
        .map(({ id, name, kind, status, role }) => ({ id, name, kind, status, ...(role ? { role } : {}) }))
    if (name === 'list_tasks') return s.all('tasks').filter((t) => t.teamId === actor.teamId)
    const { teamId } = actor
    const requestId = args.requestId || nativeCallId
    if (name === 'send_message')
      return this.mutate(
        { action: 'team.send', teamId, requestId, to: [args.to], text: args.text, replyTo: args.replyTo },
        actor,
      )
    if (name === 'assign_task')
      return this.mutate(
        {
          action: 'task.create',
          requestId,
          teamId,
          ownerId: args.to,
          title: args.title,
          criteria: args.criteria,
          dependsOn: args.dependsOn,
        },
        actor,
      )
    if (name === 'report_result')
      return this.mutate(
        {
          action: 'task.report',
          requestId,
          taskId: args.taskId,
          evidence: args.evidence,
          assignmentId: args.assignmentId,
          expectedEvidenceRevision: args.expectedEvidenceRevision,
        },
        actor,
      )
    throw new Error('Unknown team tool')
  }
  prepareWorkspace(member) {
    this.defer(member.id, async () => {
      try {
        const values = await prepareMemberWorkspace(member, this.stateDir)
        this.store.update('members', member.id, { ...values, status: 'idle', lastError: null })
        this.schedule(member.id)
      } catch (error) {
        this.store.update('members', member.id, { status: 'workspace-error', lastError: errorText(error) })
        this.event(member, null, { type: 'error', text: errorText(error) })
      }
    })
  }
  enqueue(req, slash) {
    const s = this.store
    const member = s.require('members', req.memberId)
    activeTeam(s, member.teamId)
    if (member.accountProfileId) this.accountWorkspace(member.accountProfileId, member.kind, member.cwd)
    if (this.terminalMembers.has(member.id) && !req.taskId && !req.messageId)
      throw new Error('当前会话由原生终端控制，请先交还聊天。')
    const mode = req.mode ?? 'queue'
    if (!['queue', 'steer', 'interrupt-send'].includes(mode)) throw new Error('Invalid delivery mode')
    const text = required(req.text, 'Message')
    if (mode !== 'queue') {
      if (!req.expectedTurnId || req.expectedTurnId !== member.activeTurnId)
        throw new Error('Target turn has ended or changed; keep this message for another turn')
      if (mode === 'steer' && !member.capabilities.steer)
        throw new Error('This agent has no qualified same-turn steering')
      if (member.status === 'stopping') throw new Error('The turn is already stopping')
    }
    const cmd = s.put(
      'commands',
      record({
        teamId: member.teamId,
        memberId: member.id,
        text,
        mode,
        status: mode === 'queue' ? 'queued' : mode === 'steer' ? 'awaiting-ack' : 'awaiting-stop',
        ...(slash ? { slash } : {}),
        targetTurnId: req.expectedTurnId,
        messageId: req.messageId,
        taskId: req.taskId,
        runId: req.runId,
        contextTaskId: req.contextTaskId,
        unattended: req.unattended === true,
      }),
    )
    if (mode === 'queue') this.schedule(member.id)
    else if (mode === 'steer') this.defer(member.id, () => this.steer(member, cmd))
    else this.stop(member.id, req.expectedTurnId)
    return cmd
  }
  event(member, turnId, fields) {
    this.flushText(member.id)
    return this.store.put(
      'events',
      record({
        ...fields,
        ...(member.accountProfileId ? { accountProfileId: member.accountProfileId } : {}),
        id: randomUUID(),
        teamId: member.teamId,
        memberId: member.id,
        turnId,
        createdAt: now(),
      }),
    )
  }
  flushText(memberId) {
    const pending = this.textBuffers.get(memberId)
    if (!pending) return
    this.textBuffers.delete(memberId)
    clearTimeout(pending.timer)
    this.event(pending.member, pending.fields.turnId, pending.fields)
  }
  streamText(member, event, epoch) {
    const prior = this.textBuffers.get(member.id)
    if (
      prior &&
      prior.fields.turnId === event.turnId &&
      prior.fields.connectionEpoch === epoch &&
      prior.fields.messageId === event.messageId && !event.sessionUsage && !prior.fields.sessionUsage &&
      prior.fields.text.length + event.text.length < 4096
    ) {
      prior.fields.text += event.text
      return
    }
    this.flushText(member.id)
    const timer = setTimeout(() => this.flushText(member.id), 40)
    timer.unref?.()
    this.textBuffers.set(member.id, { member, fields: { ...event, connectionEpoch: epoch }, timer })
  }
  defer(memberId, work) {
    const previous = this.workerOps.get(memberId) ?? Promise.resolve()
    const run = previous
      .then(() => (this.closing ? undefined : work()))
      .catch((error) => {
        if (!this.closing)
          this.event(this.store.require('members', memberId), null, { type: 'error', text: errorText(error) })
      })
    this.workerOps.set(memberId, run)
    this.operations.add(run)
    run.finally(() => {
      this.operations.delete(run)
      if (this.workerOps.get(memberId) === run) this.workerOps.delete(memberId)
    })
    return run
  }
  holdForBudget(member, cmd) {
    const message = cmd.messageId && this.store.get('messages',cmd.messageId)
    const autonomous = Boolean(cmd.runId || cmd.unattended || (message && message.from !== 'user'))
    const denied = this.budgets.refusal(member.id, autonomous)
    if (!denied) return false
    this.store.update('commands', cmd.id, { budgetHold: denied })
    clearTimeout(this.budgetTimers.get(member.id))
    const ms = Math.max(10, Math.min(2_000_000_000, denied.resetsAt - this.budgets.clock()))
    const timer = setTimeout(() => { this.budgetTimers.delete(member.id); this.schedule(member.id) }, ms)
    timer.unref()
    this.budgetTimers.set(member.id, timer)
    return true
  }
  schedule(memberId) {
    if (this.closing || this.scheduled.has(memberId)) return
    this.scheduled.add(memberId)
    queueMicrotask(() => {
      this.scheduled.delete(memberId)
      if (this.closing) return
      const member = this.store.require('members', memberId)
      if (member.accountProfileId && !sandboxAccountsEnabled(this.stateDir)) return
      if (
        this.terminalMembers.has(member.id) || member.activeTurnId ||
        member.status !== 'idle' ||
        this.store.require('teams', member.teamId).stopped
      )
        return
      const queued = this.store
        .all('commands')
        .filter((c) => c.memberId === memberId && c.status === 'queued')
      const priority = queued.filter(c => c.mode === 'interrupt-send')
      const cmd = [...priority, ...queued.filter(c => c.mode !== 'interrupt-send')].find(c => !this.holdForBudget(member, c))
      if (!cmd) return
      const turn = this.store.transaction(() => {
        if (
          workspaceBlocker(
            member,
            this.workspacePeers(),
            (m) => m.kind === 'codex' && m.workspaceMode === 'shared-readonly',
          )
        )
          return
        const turn = this.store.put(
          'turns',
          record({
            memberId,
            teamId: member.teamId,
            usageBinding: nativeUsageBinding(member),
            status: 'starting',
            text: cmd.text,
            commandId: cmd.id,
            taskId: cmd.taskId,
            messageId: cmd.messageId,
            runId: cmd.runId,
            contextTaskId: cmd.contextTaskId,
          }),
        )
        this.store.update('members', memberId, { activeTurnId: turn.id, status: 'starting' })
        this.store.update('commands', cmd.id, { status: 'writing', turnId: turn.id, budgetHold: null })
        this.team.turnStarted(turn)
        return turn
      })
      if (!turn) return
      this.defer(member.id, () => this.start(member, turn, cmd))
    })
  }
  async handle(member) {
    if (this.teamBridge.getRuntime) {
      await this.teamBridge.nativeReady()
      this.teamBridge.assertNativeWorkspace(member.cwd)
      this.teamBridge.assertNativeWorkspace(member.sourceRoot ?? member.workspaceRoot)
    }
    const mapped = this.accountWorkspace(member.accountProfileId, member.kind, member.cwd)
    if (mapped && (member.nativeId || member.sandboxBinding)) this.checkBinding(member.sandboxBinding, mapped)
    if (this.resident.has(member.id)) return this.resident.get(member.id).driver
    if (this.opening.has(member.id)) return this.opening.get(member.id)
    const epoch = randomUUID()
    this.epochs.set(member.id, epoch)
    const open = (async () => {
      let bridge, driver, sandboxLaunch
      try {
        if (member.workspaceMode === 'worktree') await prepareMemberWorkspace(member, this.stateDir)
        if (member.kind !== 'dsh') {
          bridge = new MemberMcp(member, () => {
            if (this.epochs.get(member.id) !== epoch || this.closing) return
            const active = this.store.get('members', member.id)
            if (active?.status === 'running') return active.activeTurnId
          }, (name, input, callId) => this.memberTool(member.id, name, input, callId))
          await bridge.listen()
        }
        const mcp = bridge && { url: bridge.url, token: bridge.token }
        if (mapped) {
          sandboxLaunch = await resolveSandboxLaunch({ accountId: member.accountProfileId, kind: member.kind, cwd: member.cwd, mcp,
            readOnly: member.kind === 'codex' && member.workspaceMode === 'shared-readonly' })
          this.checkBinding(this.accountBinding(mapped), sandboxLaunch)
          this.checkBinding(this.accountBinding(mapped), this.accountWorkspace(member.accountProfileId, member.kind, member.cwd))
        }
        driver = await this.openDriver({
          kind: member.kind,
          cwd: member.cwd,
          resumeId: member.nativeId ?? undefined,
          memberId: member.id,
          config: {
            ...(mapped ? {} : this.driverConfig[member.kind]),
            ...member.route,
            ...member.nativeSettings,
            ...(member.kind === 'dsh' ? { followProfileDefault: this.dshRouteSource(member).followProfileDefault } : {}),
            readOnly: member.kind === 'codex' && member.workspaceMode === 'shared-readonly',
          },
          mcp, ...(sandboxLaunch ? { sandboxLaunch } : {}),
          onEvent: (e) => {
            if (this.epochs.get(member.id) === epoch && !this.closing) this.receive(member, e, epoch)
          },
        })
        if (member.nativeId && driver.nativeId && member.nativeId !== driver.nativeId)
          throw new Error('Agent returned a different session while resuming')
        this.store.update('members', member.id, {
          nativeId: driver.nativeId ?? this.store.get('members', member.id).nativeId,
          capabilities: driver.capabilities,
          ...(mapped ? { sandboxBinding: this.accountBinding(mapped) } : {}),
          ...(member.kind === 'dsh' && driver.appliedRoute ? { appliedRoute: driver.appliedRoute, routeStatus: 'applied' } : {}),
        })
        this.resident.set(member.id, { driver, bridge, epoch, sandboxLaunch })
        return driver
      } catch (error) {
        this.epochs.delete(member.id)
        try {
          await driver?.close()
        } finally {
          try { await sandboxLaunch?.close() } finally { await bridge?.close() }
        }
        throw error
      }
    })()
    this.opening.set(member.id, open)
    try {
      return await open
    } finally {
      this.opening.delete(member.id)
    }
  }
  async start(member, turn, cmd) {
    let driver
    try {
      driver = await this.handle(member)
      if (this.closing) return
      if (this.store.get('turns', turn.id)?.status === 'stopping') {
        this.finish(member, turn, 'interrupted', 'Stopped before native submission')
        return
      }
      if (this.holdForBudget(member, cmd)) {
        this.store.transaction(() => {
          this.store.update('turns', turn.id, { status: 'deferred', endedAt: now() })
          this.store.update('commands', cmd.id, { status: 'queued', turnId: null })
          this.store.update('members', member.id, { activeTurnId: null, status: 'idle' })
          const task = this.store.get('tasks', turn.taskId)
          if (task?.activeTaskTurnId === turn.id) this.team.change(task, { status: 'assigned', activeTaskTurnId: null })
        })
        return
      }
      this.store.update('turns', turn.id, { status: 'running' })
      this.store.update('members', member.id, { status: 'running' })
      // An explicitly cleared profile still supersedes older prompt prefixes
      // in this native conversation. Its historical messages remain intact.
      const text = member.role || member.memory || member.profileUpdatedAt
        ? [
          '[NativeCrew member: ' + member.name + ']\nCurrent profile, replacing any earlier profile in this conversation.',
          'Role instructions:\n' + (member.role || '(none)'),
          'Fixed memory for this member:\n' + (member.memory || '(none)'),
          '[Current task]\n' + cmd.text,
        ].join('\n\n')
        : cmd.text
      const bridge = this.resident.get(member.id)?.bridge
      const teamTurnKey = bridge && (!cmd.slash || cmd.slash.skillPath) ? bridge.beginTurn(turn.id) : undefined
      await driver.start({ turnId: turn.id, text: cmd.slash ? slashInput(cmd.slash, text) : text, teamTurnKey })
      if (member.kind === 'dsh' && driver.appliedRoute) {
        this.store.update('members', member.id, { appliedRoute: driver.appliedRoute, routeStatus: 'applied' })
      }
      if (this.store.get('commands', cmd.id)?.status === 'writing')
        this.store.update('commands', cmd.id, { status: 'written' })
    } catch (error) {
      this.finish(member, turn, driver && error.deliveryUnknown ? 'unknown' : 'failed', errorText(error))
      if (!driver || (member.kind === 'dsh' && error?.code === 'GODBOT_DSH_ROUTE')) this.connectionError(member, error)
    }
  }
  connectionError(member, error) {
    this.store.update('members', member.id, { status: 'disconnected', lastError: errorText(error),
      ...(member.kind === 'dsh' ? { routeStatus: 'failed' } : {}) })
    this.event(member, null, { type: 'error', text: errorText(error) })
  }
  receive(member, e, epoch) {
    const s = this.store
    if (e.type === 'text' && typeof e.text === 'string') {
      this.streamText(member, e, epoch)
      return
    }
    const current = s.require('members', member.id)
    if (e.nativeId && e.type === 'session') {
      if (current.nativeId && current.nativeId !== e.nativeId) {
        this.connectionError(member, new Error('Native session identity changed'))
        return
      }
      s.update('members', member.id, { nativeId: e.nativeId })
    }
    // Driver events that lack a turn identity may describe connection activity, never a newer turn's completion.
    const turn = e.turnId && s.get('turns', e.turnId)
    const row = this.event(member, e.turnId, { ...e, connectionEpoch: epoch })
    if (!e.turnId && e.type === 'error' && ['lost', 'disconnected'].includes(e.status)) {
      if (current.activeTurnId)
        this.finish(member, s.require('turns', current.activeTurnId), 'unknown', e.text)
      else this.connectionError(member, e.text || 'Native connection closed')
      return
    }
    if (!turn || turn.memberId !== member.id || turn.id !== current.activeTurnId || terminal.has(turn.status))
      return
    if (e.usage && e.usageId) this.budgets.native(member, turn, e)
    if (e.type === 'question' || e.type === 'permission') {
      if (!e.requestId) return
      const prior = s
        .all('interactions')
        .some((x) => x.memberId === member.id && x.turnId === turn.id && x.requestId === e.requestId)
      if (!prior)
        s.put(
          'interactions',
          record({
            teamId: member.teamId,
            memberId: member.id,
            turnId: turn.id,
            requestId: e.requestId,
            runId: turn.runId,
            type: e.type,
            text: e.text ?? '',
            options: e.options ?? [],
            details: e.details ?? e.detail,
            questions: e.questions,
            status: 'pending',
          }),
        )
      if (current.status !== 'stopping') s.update('members', member.id, { status: 'waiting' })
    }
    if (e.type === 'accepted' || e.type === 'started') {
      const cmd = s.get('commands', e.commandId || turn.commandId)
      if (cmd && ['writing', 'written', 'awaiting-ack'].includes(cmd.status))
        s.update('commands', cmd.id, { status: 'accepted', turnId: turn.id })
    }
    if (e.type === 'done' || e.type === 'error') {
      const status =
        e.type === 'error'
          ? e.deliveryUnknown || e.status === 'lost'
            ? 'unknown'
            : 'failed'
          : (e.status ?? 'completed')
      this.finish(member, turn, terminal.has(status) ? status : 'unknown', e.text, row)
    }
  }
  finish(member, turn, status, reason, terminalEvent) {
    const s = this.store
    if (
      s.get('members', member.id)?.activeTurnId !== turn.id ||
      terminal.has(s.get('turns', turn.id)?.status)
    )
      return
    clearTimeout(this.stopTimers.get(turn.id))
    this.stopTimers.delete(turn.id)
    s.transaction(() => {
      if (!terminalEvent)
        this.event(member, turn.id, { type: status === 'failed' ? 'error' : 'done', status, text: reason })
      this.budgets.finishNative(member, turn)
      s.update('turns', turn.id, { status, endedAt: now(), reason })
      s.update('members', member.id, {
        status: status === 'unknown' ? 'unknown' : 'idle',
        activeTurnId: null,
      })
      const first = s.require('commands', turn.commandId)
      if (['writing', 'written'].includes(first.status))
        s.update('commands', first.id, {
          status: status === 'unknown' ? 'unknown' : status === 'failed' ? 'failed' : 'settled',
        })
      for (const c of s
        .all('commands')
        .filter((c) => c.memberId === member.id && c.targetTurnId === turn.id)) {
        if (c.status === 'awaiting-stop')
          s.update('commands', c.id, {
            status: ['interrupted', 'completed'].includes(status) ? 'queued' : 'retained',
          })
        if (c.status === 'awaiting-ack') s.update('commands', c.id, { status: 'unknown' })
      }
      for (const i of s
        .all('interactions')
        .filter((i) => i.turnId === turn.id && ['pending', 'answering'].includes(i.status)))
        s.update('interactions', i.id, { status: 'expired' })
      const answer = s
        .all('events')
        .filter((e) => e.turnId === turn.id && e.type === 'text')
        .map((e) => e.text ?? '')
        .join('')
      this.team.turnEnded({ member, turn, status, reason, answer })
    })
    for (const m of s.all('members')) this.schedule(m.id)
  }
  stop(memberId, expectedTurnId) {
    const s = this.store
    const member = s.require('members', memberId)
    if (!member.activeTurnId) return { id: memberId, status: 'idle' }
    if (!expectedTurnId || member.activeTurnId !== expectedTurnId) throw new Error('Target turn has changed')
    if (member.status === 'stopping') return { id: memberId, status: 'stopping' }
    s.update('members', memberId, { status: 'stopping' })
    s.update('turns', expectedTurnId, { status: 'stopping' })
    const timer = setTimeout(() => {
      this.stopTimers.delete(expectedTurnId)
      if (this.closing || s.get('members', memberId)?.activeTurnId !== expectedTurnId) return
      this.event(member, expectedTurnId, {
        type: 'stop_timeout',
        text: 'Native stop is still unconfirmed. The replacement remains held; inspect tools or force-stop this member.',
      })
    }, this.stopTimeoutMs)
    timer.unref?.()
    this.stopTimers.set(expectedTurnId, timer)
    this.defer(memberId, async () => {
      if (s.require('members', memberId).activeTurnId !== expectedTurnId) return
      try {
        const driver = this.resident.get(memberId)?.driver
        if (!driver) throw new Error('Connection unavailable during cancellation')
        await driver.interrupt({ turnId: expectedTurnId })
        this.event(member, expectedTurnId, {
          type: 'interrupt',
          text: 'Stop requested; awaiting native completion',
        })
      } catch (error) {
        this.finish(member, s.require('turns', expectedTurnId), 'unknown', errorText(error))
      }
    })
    return { id: memberId, status: 'stopping', turnId: expectedTurnId }
  }
  async steer(member, cmd) {
    const s = this.store
    if (s.require('members', member.id).activeTurnId !== cmd.targetTurnId) {
      s.update('commands', cmd.id, { status: 'retained' })
      return
    }
    try {
      const driver = await this.handle(member)
      if (!driver.capabilities.steer) throw new Error('Native steer unavailable')
      const ack = await driver.steer({ turnId: cmd.targetTurnId, text: cmd.slash ? slashInput(cmd.slash) : cmd.text, commandId: cmd.id })
      const status = ack?.status === 'written' ? 'written' : 'accepted'
      s.update('commands', cmd.id, { status, turnId: cmd.targetTurnId })
      this.event(member, cmd.targetTurnId, { type: 'steer', status, text: cmd.text, commandId: cmd.id })
    } catch (error) {
      s.update('commands', cmd.id, {
        status: error.deliveryUnknown ? 'unknown' : 'retained',
        error: errorText(error),
      })
      this.event(member, cmd.targetTurnId, {
        type: 'delivery_error',
        text: errorText(error),
        commandId: cmd.id,
      })
    }
  }
  answer(req) {
    const s = this.store
    const i = s.require('interactions', req.interactionId)
    const member = s.require('members', i.memberId)
    if (i.status !== 'pending' || member.activeTurnId !== i.turnId || member.status === 'stopping')
      throw new Error('This request is no longer pending')
    const result = s.update('interactions', i.id, { status: 'answering' })
    this.defer(member.id, async () => {
      if (s.require('interactions', i.id).status !== 'answering') return
      const current = s.require('members', member.id)
      if (
        current.activeTurnId !== i.turnId ||
        current.status === 'stopping' ||
        s.require('teams', member.teamId).stopped
      ) {
        s.update('interactions', i.id, { status: 'expired' })
        return
      }
      try {
        const driver = await this.handle(member)
        await driver.respond({
          requestId: i.requestId,
          turnId: i.turnId,
          decision: req.decision,
          answer: req.answer,
        })
        s.update('interactions', i.id, { status: 'answered', ...storedReply(i, req.decision, req.answer) })
        if (
          s.get('members', member.id)?.activeTurnId === i.turnId &&
          !s.all('interactions').some((x) => x.turnId === i.turnId && x.status === 'pending')
        )
          s.update('members', member.id, { status: 'running' })
      } catch (error) {
        if (s.require('interactions', i.id).status === 'answering')
          s.update('interactions', i.id, { status: 'pending', error: errorText(error) })
      }
    })
    return result
  }
  async detach(memberId, force = false) {
    const live = this.resident.get(memberId)
    if (!live) return
    try {
      if (force && live.driver.forceClose) await live.driver.forceClose()
      else await live.driver.close()
    } catch (error) {
      if (force || !live.driver.forceClose) throw error
      await live.driver.forceClose()
    } finally {
      // Revoke the integration credential even if the provider cannot confirm process death.
      try {
        await live.sandboxLaunch?.close()
      } finally {
        await live.bridge?.close()
        live.bridge = undefined
      }
    }
    this.epochs.delete(memberId)
    this.resident.delete(memberId)
  }
  async close() {
    if (this.closing) return this.closed
    this.closing = true
    this.routines.close()
    this.closed = (async () => {
      await this.automation.close()
      for (const timer of this.budgetTimers.values()) clearTimeout(timer)
      for (const memberId of this.textBuffers.keys()) this.flushText(memberId)
      for (const timer of this.stopTimers.values()) clearTimeout(timer)
      await Promise.allSettled(this.opening.values())
      const released = await Promise.allSettled([...this.resident.keys()].map((id) => this.detach(id)))
      await Promise.allSettled(this.operations)
      await this.providerAccounts.close()
      await this.providerUsage.close()
      await this.teamBridge.close()
      this.budgets.close()
      this.store.close()
      const failures = released.filter((r) => r.status === 'rejected').map((r) => r.reason)
      if (failures.length)
        throw new AggregateError(failures, 'NativeCrew could not confirm all member processes closed')
    })()
    return this.closed
  }
}

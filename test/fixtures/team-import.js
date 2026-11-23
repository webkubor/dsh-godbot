import { createHash, randomUUID } from 'node:crypto'
import { NativeSources } from './native-sources.js'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const folded = value => process.platform === 'linux' ? value : value.toLowerCase()
const normalized = value => String(value ?? '').trim().toLowerCase()
const providers = { codex: 'local-codex-cli', claude: 'local-claude-code', antigravity: 'local-antigravity' }
const launches = { codex: ['codex', ['app-server', '--listen', 'stdio://']], claude: ['claude', []], antigravity: ['agy', ['acp']] }
const unfinished = new Set(['queued', 'writing', 'awaiting-stop', 'awaiting-ack'])

// Keep both spellings. A folder being created, including a future worktree,
// counts where the nearest existing ancestor resolves to.
function paths(path) {
  const full = resolve(path)
  let parent = full
  const rest = []
  while (!existsSync(parent) && dirname(parent) !== parent) {
    rest.unshift(basename(parent))
    parent = dirname(parent)
  }
  return [folded(full), folded(join(realpathSync(parent), ...rest))]
}

function overlaps(first, second) {
  const contains = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
  return paths(first).some(a => paths(second).some(b => contains(a, b) || contains(b, a)))
}

function desiredModel(member, route, rt, driver = {}) {
  if (member.kind === 'dsh') {
    const choice = member.route ?? route?.hostRoute ?? rt.ctx.get?.('agentDefaultModel')?.currentSelection?.()
    return choice?.provider && choice?.model ? choice.provider + '/' + choice.model : undefined
  }
  if (member.accountProfileId || Object.keys(driver.env ?? {}).length) return undefined
  if (member.kind === 'acp') {
    const matches = (rt.state.localAgents?.custom ?? []).filter(a =>
      a.command === driver.command && JSON.stringify(a.args ?? []) === JSON.stringify(driver.args ?? []))
    return matches.length === 1 ? 'local-acp-' + matches[0].id + '/' + (member.nativeSettings?.model || 'default') : undefined
  }
  const standard = launches[member.kind]
  if (!standard || (driver.command && driver.command !== standard[0]) ||
    (driver.args && JSON.stringify(driver.args) !== JSON.stringify(standard[1]))) return undefined
  return providers[member.kind] && providers[member.kind] + '/' + (member.nativeSettings?.model || 'default')
}

function existing(rt, collection, origin, receipt) {
  if (receipt?.targetId) {
    const row = rt.state[collection][receipt.targetId]
    return row?.godbotOrigin === origin ? row : undefined
  }
  return Object.values(rt.state[collection]).find(row => row.godbotOrigin === origin)
}

function isLinkedRoom(rt, room, origin) {
  if (!room || room.godbotOrigin !== origin) return false
  const prefix = origin + '/member/'
  const bots = room.members.map(id => rt.state.bots[id])
  return bots.some(bot => bot?.godbotOrigin?.startsWith(prefix)) &&
    bots.every(bot => bot && !bot.private && (!bot.godbotOrigin || bot.godbotOrigin.startsWith(prefix)))
}

export class TeamImportBridge {
  constructor(service, getRuntime, workspaceParent) {
    this.service = service
    this.store = service.store
    this.getRuntime = getRuntime
    this.workspaceParent = workspaceParent || join(homedir(), 'NativeCrew Workspaces')
    this.running = new Map()
    this.nativeSources = new NativeSources(this)
  }

  connect() {
    if (!this.getRuntime) throw new Error('The Bot team runtime is unavailable')
    this.connection ??= Promise.resolve().then(this.getRuntime).then(async rt => {
      if (!rt) throw new Error('The Bot team runtime is unavailable')
      await rt.load()
      if (this.service.closing) throw new Error('NativeCrew is shutting down')
      this.rt = rt
      this.service.budgets?.botBudget?.attach(rt)
      this.service.automation?.full?.attach(rt)
      this.guard = path => this.legacyOverlap(path) || this.legacyRoots().some(root => this.dataWorkspace(root))
      rt.godbotWorkspaceConflict = this.guard
      rt.ctx?.effect?.(() => () => {
        if (this.rt === rt) this.invalidate()
      }, 'NativeCrew native workspace guard')
      return rt
    }).catch(error => {
      this.connection = undefined
      this.disabled = error.code === 'GODBOT_TEAM_DISABLED'
      throw error
    })
    return this.connection
  }

  invalidate() {
    this.service.automation?.full?.detach?.()
    if (this.rt && this.rt.godbotWorkspaceConflict === this.guard) delete this.rt.godbotWorkspaceConflict
    this.rt = undefined
    this.connection = undefined
  }

  async nativeReady() {
    if (!this.getRuntime || this.disabled) return
    try { await this.connect() } catch (error) {
      if (error.code !== 'GODBOT_TEAM_DISABLED') throw error
    }
  }

  legacyRoots() {
    const members = this.store.all('members')
    return [
      ...this.store.all('teams').map(team => team.cwd),
      ...members.flatMap(m => [m, m.maintenance?.workspace].filter(Boolean))
        .flatMap(m => [m.cwd, m.workspaceRoot, m.sourceCwd, m.sourceRoot]),
    ].filter(Boolean)
  }

  legacyOverlap(path) {
    return [this.service.stateDir, ...this.legacyRoots()].some(root => overlaps(path, root))
  }

  dataWorkspace(path) {
    const rt = this.rt
    if (rt.home && overlaps(path, rt.home)) return true
    if (!rt.dshHome || !overlaps(path, rt.dshHome)) return false
    // Native managed checkouts are separate siblings of workspace state. A
    // checkout embedded elsewhere inside DSH's data has no such exemption.
    const managed = paths(join(this.service.stateDir, 'worktrees'))[1]
    return !paths(path)[1].startsWith(managed + sep)
  }

  assertPublic(path) {
    if (!this.getRuntime || this.disabled || !path) return
    if (!this.rt) throw new Error('The Bot privacy settings are loading. Try again shortly.')
    const state = this.rt.state
    const closed = [...Object.values(state.bots).filter(b => b.private), ...(state.privateArchives ?? [])]
    if (closed.length && (this.dataWorkspace(path) || closed.some(b => b.workDir && overlaps(path, b.workDir)))) {
      throw new Error('The selected directory overlaps private Bot files or session data')
    }
  }

  assertNativeWorkspace(path) {
    this.assertPublic(path)
    if (!path || !this.getRuntime || this.disabled) return
    if (this.store.all('donorTeamImports').some(r => overlaps(path, r.workspaceRoot))) {
      throw new Error('The selected directory belongs to an imported Bot team workspace')
    }
  }

  workspace(req, teamId) {
    const saved = this.store.get('donorTeamImports', teamId)?.workspaceRoot
    if (saved) return saved
    const parent = req.workspaceParent ?? this.workspaceParent
    if (typeof parent !== 'string' || !isAbsolute(parent)) throw new Error('Choose an absolute workspace parent directory')
    return join(resolve(parent), 'team-' + hash(teamId).slice(0, 20))
  }

  links() {
    if (!this.rt) {
      if (this.getRuntime && !this.disabled && !this.service.closing) void this.connect().catch(() => {})
      return []
    }
    const { state } = this.rt
    const links = []
    for (const row of this.store.all('donorBindings')) {
      if (row.memberId) {
        const bot = state.bots[row.targetId]
        if (!bot || bot.private || bot.godbotOrigin !== row.id || this.store.get('members', row.memberId)?.teamId !== row.teamId) continue
        links.push({ teamId: row.teamId, memberId: row.memberId, donorBotId: bot.id, donorSessionId: this.rt.chatOf(bot.id) })
      } else {
        const room = state.rooms[row.targetId]
        if (isLinkedRoom(this.rt, room, row.id) && this.store.get('teams', row.teamId)) {
          links.push({ teamId: row.teamId, donorRoomId: room.id })
        }
      }
    }
    return links
  }

  sources(req) {
    return this.nativeSources.handle(req)
  }

  async preview(req) {
    return this.plan(req, await this.connect())
  }

  plan(req, rt) {
    const s = this.store
    const team = s.require('teams', req.teamId)
    const source = s.all('members').filter(m => m.teamId === team.id)
    const workspaceRoot = this.workspace(req, team.id)
    const record = s.get('donorTeamImports', team.id)
    const issues = []
    const issue = (code, message, memberId) => issues.push({ code, message, ...(memberId ? { memberId } : {}) })
    const roomOrigin = 'godbot/team/' + team.id
    const roomReceipt = s.get('donorBindings', roomOrigin)
    const room = existing(rt, 'rooms', roomOrigin, roomReceipt)
    const roomName = team.name.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (rt.readOnly()) issue('read_only', 'Bot 团队状态为只读，无法导入。')
    if (!source.length || source.length > 12) issue('member_count', '可导入 1 至 12 名成员。')
    const complete = record?.complete === true
    if (record && source.map(m => m.id).join() !== record.memberIds.join()) issue('roster_changed', '原生成员已变更，请保留已有映射并在 Bot 团队中管理成员。')
    if (roomReceipt && !room) issue('room_missing', '关联的群组已移除，无法自动重新创建。')
    if (room && !isLinkedRoom(rt, room, roomOrigin)) issue('room_membership', '关联群组的成员归属已变更，请在 Bot 团队中查看和管理该群组。')
    if (source.length >= 2 && !room && Object.values(rt.state.rooms).some(r => normalized(r.name) === normalized(roomName))) {
      issue('room_name', 'Bot 团队中已有同名群组，请先调整名称。')
    }
    const names = new Set()
    const waiting = new Set([
      ...s.all('commands').filter(c => unfinished.has(c.status)).map(c => c.memberId),
      ...s.all('interactions').filter(q => ['pending', 'answering'].includes(q.status)).map(q => q.memberId),
    ])
    const members = source.map(m => {
      const origin = roomOrigin + '/member/' + m.id
      const receipt = s.get('donorBindings', origin)
      const bot = existing(rt, 'bots', origin, receipt)
      const workDir = join(workspaceRoot, 'bot-' + hash(m.id).slice(0, 20))
      const name = m.name.trim().slice(0, 40)
      if (!bot && receipt) issue('bot_missing', '关联的 Bot 已移除，无法自动重新创建。', m.id)
      if (bot?.private) issue('bot_private', '该成员的 Bot 入口目前不可从原生团队访问。', m.id)
      if (!bot && (names.has(normalized(name)) || Object.values(rt.state.bots).some(b => normalized(b.name) === normalized(name)))) {
        issue('bot_name', 'Bot 团队中已有同名成员，请先调整名称。', m.id)
      }
      names.add(normalized(name))
      if (!complete && (m.activeTurnId || !['idle', 'disconnected', 'workspace-error'].includes(m.status) || m.maintenance || waiting.has(m.id))) {
        issue('busy', '请先结束该成员的活动轮次、待办投递或审批，再开始导入。', m.id)
      }
      const visible = bot && !bot.private
      const model = desiredModel(m, m.kind === 'dsh' ? this.service.dshRouteSource(m) : undefined, rt, this.service.driverConfig[m.kind])
      if (!bot && m.accountProfileId) {
        issue('sandbox_account', '此成员绑定沙箱账号。请在 Bot 团队中选择对应账号和已挂载的目录。', m.id)
      } else if (!bot && m.kind !== 'dsh' && !model) {
        issue('custom_launch', '此成员使用自定义 CLI、参数或环境。请在 Bot 团队中配置相同的 ACP 启动项，或保留原生入口。', m.id)
      }
      return {
        memberId: m.id, name, kind: m.kind, workDir, nativeId: m.nativeId,
        model,
        effort: m.kind === 'dsh' ? m.route?.reasoningEffort : m.nativeSettings?.effort,
        status: visible ? 'imported' : bot || receipt ? 'unavailable' : 'ready',
        ...(visible ? { donorBotId: bot.id, donorSessionId: rt.chatOf(bot.id) } : {}),
      }
    })
    if (!complete) {
      if (this.legacyOverlap(workspaceRoot)) issue('workspace_overlap', '新目录与原生团队工作区重叠，请选择独立的上级目录。')
      try {
        this.assertPublic(workspaceRoot)
        if (!record && existsSync(workspaceRoot)) issue('workspace_exists', '新目录已存在，请选择其他上级目录。')
      } catch {
        issue('workspace_private', '新目录与私密 Bot 的工作区重叠。')
      }
    }
    const status = issues.length ? 'blocked' : complete ? 'imported' : record ? 'partial' : 'ready'
    const sourceSignature = hash([team.id, team.name, team.leadId, workspaceRoot,
      members.map(({ memberId, name, kind, model, effort }) => [memberId, name, kind, model, effort]),
      source.map(m => [m.role, m.workspaceMode])])
    return {
      teamId: team.id, name: team.name, memberCount: source.length, members, issues, status, workspaceRoot,
      sourceSignature,
      ...(isLinkedRoom(rt, room, roomOrigin) ? { donorRoomId: room.id } : {}),
      previewId: hash([team.id, team.name, team.leadId, members, source.map(m => [m.role, m.workspaceMode]), workspaceRoot, status, issues]),
    }
  }

  async import(req) {
    const rt = await this.connect()
    if (this.service.closing) throw new Error('NativeCrew is shutting down')
    const active = this.running.get(req.teamId)
    if (active) {
      if (active.previewId !== req.previewId) throw new Error('Another import is in progress. Refresh the preview.')
      return active.promise
    }
    const plan = this.plan(req, rt)
    const saved = this.store.get('donorTeamImports', plan.teamId)
    const confirmedBefore = req.previewId === saved?.previewId && (saved?.complete || plan.sourceSignature === saved?.sourceSignature)
    if (!req.previewId || (req.previewId !== plan.previewId && !confirmedBefore)) throw new Error('The import preview changed. Refresh it before confirming.')
    if (plan.status === 'blocked') throw new Error(plan.issues.map(i => i.message).join(' '))
    if (plan.status === 'imported') return plan
    const promise = Promise.resolve().then(() => this.commit(rt, plan))
    this.running.set(req.teamId, { previewId: req.previewId, promise })
    try { return await promise } finally { this.running.delete(req.teamId) }
  }

  async commit(rt, plan) {
    const s = this.store
    const team = s.require('teams', plan.teamId)
    const origin = 'godbot/team/' + team.id
    const assertOwner = () => {
      if (this.rt !== rt || rt.readOnly() || this.service.closing) throw new Error('The host changed during import. Open a new preview and continue.')
    }
    assertOwner()
    const previous = s.get('donorTeamImports', team.id)
    const reservation = previous ?? s.put('donorTeamImports', {
      id: team.id, workspaceRoot: plan.workspaceRoot, memberIds: plan.members.map(m => m.memberId),
      previewId: plan.previewId, sourceSignature: plan.sourceSignature, marker: randomUUID(), complete: false,
    })
    // Reserve a fresh team folder before creating any workspace Sessions. A retry
    // reuses its own directory. Never import a pre-existing user's directory.
    mkdirSync(dirname(plan.workspaceRoot), { recursive: true, mode: 0o700 })
    if (!existsSync(plan.workspaceRoot)) {
      if (reservation.folderReady) throw new Error('The reserved Bot team workspace is missing')
      mkdirSync(plan.workspaceRoot, { mode: 0o700 })
    }
    if (!lstatSync(plan.workspaceRoot).isDirectory()) throw new Error('The reserved Bot team workspace has moved')
    const marker = join(plan.workspaceRoot, '.godbot-import')
    if (!existsSync(marker) && !reservation.folderReady && !readdirSync(plan.workspaceRoot).length) {
      writeFileSync(marker, reservation.marker, { flag: 'wx', mode: 0o600 })
    }
    const root = realpathSync(plan.workspaceRoot)
    const validate = () => {
      if (this.legacyOverlap(root)) throw new Error('The destination overlaps a native workspace')
      this.assertPublic(root)
      if (realpathSync(plan.workspaceRoot) !== root || !lstatSync(marker).isFile()
        || readFileSync(marker, 'utf8') !== reservation.marker || (reservation.realRoot && reservation.realRoot !== root)) {
        throw new Error('The reserved Bot team workspace changed')
      }
    }
    validate()
    s.update('donorTeamImports', team.id, { realRoot: root, folderReady: true })
    const prepare = dir => {
      validate()
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 })
      if (!lstatSync(dir).isDirectory() || readdirSync(dir).length) throw new Error('The destination must be a new empty directory')
    }
    const ids = new Map()
    const reserve = key => {
      const saved = s.get('donorSessions', key) ?? s.put('donorSessions', { id: key, sessionId: randomUUID() })
      return {
        id: saved.sessionId,
        claim: sessionId => {
          if (typeof sessionId !== 'string' || !sessionId) throw new Error('The Bot runtime did not return a Session identity')
          if (sessionId !== saved.sessionId) s.update('donorSessions', key, { sessionId })
        },
      }
    }
    for (const target of plan.members) {
      assertOwner()
      const m = s.require('members', target.memberId)
      const key = origin + '/member/' + m.id
      const receipt = s.get('donorBindings', key)
      let bot = existing(rt, 'bots', key, receipt)
      if (!bot) {
        if (receipt || m.teamId !== team.id) throw new Error('The source or target member changed')
        prepare(target.workDir)
        bot = await rt.importNativeCrewMember({
          origin: key, name: target.name, instructions: m.role ?? '', role: m.role ?? '', workDir: target.workDir,
          pickModel: true, model: target.model, effort: target.effort ?? null, readOnly: m.workspaceMode === 'shared-readonly', reservation: reserve(key),
        })
      }
      if (rt.state.bots[bot.id] !== bot || bot.godbotOrigin !== key || bot.private) throw new Error('The linked Bot is unavailable')
      assertOwner()
      ids.set(m.id, bot.id)
      s.put('donorBindings', { id: key, teamId: team.id, memberId: m.id, targetId: bot.id })
    }
    if (ids.size >= 2) {
      assertOwner()
      const receipt = s.get('donorBindings', origin)
      let room = existing(rt, 'rooms', origin, receipt)
      if (!room) {
        if (receipt) throw new Error('The linked group was removed')
        const dir = join(plan.workspaceRoot, 'room')
        prepare(dir)
        room = await rt.importNativeCrewRoom({
          origin, name: team.name, members: [...ids.values()], admin: ids.get(team.leadId) ?? null, workDir: dir, reservation: reserve(origin),
        })
      }
      if (room.godbotOrigin !== origin) throw new Error('The linked group is unavailable')
      assertOwner()
      s.put('donorBindings', { id: origin, teamId: team.id, targetId: room.id })
    }
    s.update('donorTeamImports', team.id, { complete: true })
    return this.plan({ teamId: team.id }, rt)
  }

  async close() {
    await Promise.allSettled([...this.running.values()].map(r => r.promise).concat([...this.nativeSources.sending.values()]))
    this.invalidate()
  }
}

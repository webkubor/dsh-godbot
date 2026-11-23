import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NativeCrewService } from '../fixtures/member-service.js'
import { install as installRoster } from '../../src/host/team-runtime/roster.js'
import { install as installPrivacy } from '../../src/host/team-runtime/privacy.js'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-import-')))
  const cwd = join(root, 'old'), home = join(root, 'donor-data'), stateDir = join(root, 'state')
  await Promise.all([mkdir(cwd), mkdir(home)])
  const sessions = [], opened = [], emitted = [], selections = []
  const bots = {}, rooms = {}, state = { bots, rooms, mainBotIds: [], privateArchives: [] }
  const rt = {
    config: { godbotStateDir: stateDir }, defaults: {}, home, state, readOnly: () => undefined, load: async () => {}, save: async () => {},
    ctx: {
      on() {}, workspaceRegistry: { resolveByPath: async () => undefined, archiveSession: async () => {} },
      llm: { resolveCallConfig: async route => route },
      sessionController: { async create(place) {
        if (!sessions.some(s => s.sessionId === place.sessionId)) sessions.push(place)
        return { sessionId: place.sessionId }
      } },
      sessionTitle: { rename: async () => {} }, sessions: { async flush() {} },
    },
    isFolder: async path => (await stat(path)).isDirectory(), cleanWorkDir: realpath, realBeyond: async path => realpath(path).catch(() => path),
    resolveAgent: async id => ({ session: { id }, model: { select: route => selections.push({ id, ...route }) } }), selectRoomSession: async () => {},
    resolveModel: async ref => ref, chatOf: id => bots[id]?.part ?? id, botOf: id => bots[id], chatOwners: new Map(),
    findBot: name => Object.values(bots).find(b => b.name.toLowerCase() === name.toLowerCase()),
    findRooms: name => Object.values(rooms).filter(r => r.name.toLowerCase() === name.toLowerCase()),
    isMain: () => false, teamFolder: () => join(home, 'shared'),
    waitForModel: async () => {}, applyModel: async () => {}, deliver: async msg => emitted.push(msg), warn() {},
  }
  installPrivacy(rt)
  installRoster(rt)
  const create = () => new NativeCrewService({
    stateDir, teamRuntime: () => rt, config: { importWorkspaceParent: join(root, 'imports') },
    openDriver: async request => {
      opened.push(request)
      return { nativeId: request.resumeId, start() {}, close() {} }
    },
  })
  let service = create()
  await service.ready()
  await service.teamBridge.connect()
  const act = (action, args = {}) => service.dispatch({ action, ...args })
  const team = await act('team.create', { name: 'Docs', cwd })
  const add = (name, fields) => act('member.add', { teamId: team.id, name, kind: 'codex', ...fields })
  const preview = (fields) => act('legacy.preview', { teamId: team.id, ...fields })
  const confirm = (p, fields) => act('legacy.import', { teamId: team.id, previewId: p.previewId, ...fields })
  async function restart() {
    await service.close()
    service = create()
    await service.ready()
    await service.teamBridge.connect()
  }
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  return { root, home, cwd, rt, team, add, act, preview, confirm, restart, bots, rooms, sessions, opened, emitted, selections, get s() { return service } }
}

test('a confirmed import creates fresh, quiet Bot and group Sessions with stable owner links; retry preserves originals', async t => {
  const f = await fixture(t)
  const alice = f.add('A', { role: 'Review documents', memory: 'private-legacy-note', workspaceMode: 'shared-readonly' })
  const bob = f.add('B', { kind: 'dsh' })
  f.s.store.update('members', alice.id, { nativeId: 'old-exact-session' })
  const originals = f.s.snapshot()
  const p = await f.preview()
  assert.equal(p.status, 'ready')
  assert.equal(existsSync(p.workspaceRoot), false)
  assert.equal(f.sessions.length, 0)
  const [done, duplicate] = await Promise.all([f.confirm(p), f.confirm(p)])
  assert.deepEqual(done, duplicate)
  assert.equal(done.status, 'imported')
  assert.equal(f.sessions.length, 3)
  assert.ok(f.sessions.every(s => s.cwd.startsWith(p.workspaceRoot + '/')))
  for (const key of ['members', 'teams', 'turns', 'messages', 'tasks', 'interactions', 'commands']) assert.deepEqual(f.s.snapshot()[key], originals[key])
  const [a, b] = Object.values(f.bots)
  assert.equal(a.model, 'local-codex-cli/default')
  assert.deepEqual(f.selections, [{ id: a.id, provider: 'local-codex-cli', model: 'default' }])
  assert.equal(a.permission, 'read-only')
  assert.equal(a.instructions, 'Review documents')
  assert.equal(b.model, undefined)
  assert.ok(!a.kickoff && !b.kickoff)
  assert.doesNotMatch(JSON.stringify(f.rt.state), /private-legacy-note|old-exact-session/)
  assert.deepEqual(f.opened, [])
  assert.deepEqual(f.emitted, [])
  assert.equal(f.rooms[done.donorRoomId].admin, b.id)
  assert.equal(f.s.snapshot().donorLinks.length, 3)
  b.part = 'donor-new-part'
  await f.restart()
  assert.equal((await f.confirm(p)).status, 'imported')
  assert.equal(f.sessions.length, 3)
  assert.equal(f.s.snapshot().donorLinks.find(l => l.memberId === bob.id).donorSessionId, 'donor-new-part')
  assert.throws(() => f.s.memberTool(alice.id, 'legacy.import', { teamId: f.team.id }), /unknown|available|unsupported/i)
  f.bots.foreign = { id: 'foreign', godbotOrigin: 'godbot/team/another/member/foreign' }
  f.rooms[done.donorRoomId].members.push('foreign')
  assert.equal((await f.preview()).issues[0].code, 'room_membership')
  assert.ok(!f.s.snapshot().donorLinks.some(l => l.donorRoomId))
})

test('a partial commit retried after process restart reconciles the donor origin even if its SQLite receipt never landed', async t => {
  const f = await fixture(t)
  f.add('Solo', { kind: 'claude' })
  const put = f.s.store.put.bind(f.s.store)
  let torn = true
  f.s.store.put = (collection, row) => {
    if (collection === 'donorBindings' && torn) { torn = false; throw new Error('simulated crash after donor save') }
    return put(collection, row)
  }
  const p = await f.preview()
  await assert.rejects(f.confirm(p), /simulated crash/)
  assert.equal(f.sessions.length, 1)
  await f.restart()
  assert.equal((await f.preview()).status, 'partial')
  const result = await f.confirm(p)
  assert.equal(result.status, 'imported')
  assert.ok(!result.donorRoomId)
  assert.equal(f.sessions.length, 1)
  assert.equal(f.s.snapshot().donorLinks.length, 1)
  delete f.bots[result.members[0].donorBotId]
  assert.equal((await f.preview()).status, 'blocked')
  assert.deepEqual(f.s.snapshot().donorLinks, [])
  await assert.rejects(f.confirm(p), /移除/)
  assert.equal(f.sessions.length, 1)
})

test('active turns, unacknowledged orders, collisions and stale or cross-team previews cannot trigger creation', async t => {
  const f = await fixture(t)
  const m = f.add('Worker', {})
  const p = await f.preview()
  const other = await f.act('team.create', { name: 'Other', cwd: f.cwd })
  await assert.rejects(f.act('legacy.import', { teamId: other.id, previewId: p.previewId }), /preview/)
  f.s.store.update('members', m.id, { activeTurnId: 'old-running', status: 'running' })
  assert.equal((await f.preview()).issues[0].code, 'busy')
  await assert.rejects(f.confirm(p), /preview/)
  f.s.store.update('members', m.id, { activeTurnId: null, status: 'idle' })
  f.s.store.put('commands', { id: 'q', memberId: m.id, status: 'awaiting-ack' })
  assert.equal((await f.preview()).status, 'blocked')
  f.s.store.update('commands', 'q', { status: 'acknowledged' })
  f.bots.unrelated = { id: 'unrelated', name: 'worker' }
  assert.ok((await f.preview()).issues.some(i => i.code === 'bot_name'))
  delete f.bots.unrelated
  f.act('member.profile', { memberId: m.id, name: 'Writer' })
  await assert.rejects(f.confirm(p), /preview/)
  assert.equal(f.sessions.length, 0)
})

test('the first attempt reserves the DSH Session before donor persistence, so an interruption while naming it reuses the blank identity', async t => {
  const f = await fixture(t)
  f.add('Solo', { kind: 'claude' })
  let interrupted = true
  f.rt.ctx.sessionTitle.rename = async () => {
    if (interrupted) { interrupted = false; throw new Error('interrupted after creation') }
  }
  const p = await f.preview()
  await assert.rejects(f.confirm(p), /interrupted after creation/)
  assert.equal(f.sessions.length, 1)
  assert.equal(Object.keys(f.bots).length, 0)
  await f.restart()
  const complete = await f.confirm(p)
  assert.equal(f.sessions.length, 1)
  assert.equal(complete.members[0].donorBotId, f.sessions[0].sessionId)
})

test('custom ACP imports require one matching launch definition already owned by the donor', async t => {
  const f = await fixture(t)
  f.add('Custom', { kind: 'acp' })
  f.s.driverConfig.acp = { command: 'my-acp', args: ['--stdio'] }
  f.rt.state.localAgents = { custom: [{ id: 'different', command: 'my-acp', args: [] }] }
  assert.equal((await f.preview()).issues[0].code, 'custom_launch')
  f.rt.state.localAgents.custom.push({ id: 'configured', command: 'my-acp', args: ['--stdio'] })
  const p = await f.preview()
  assert.equal(p.members[0].model, 'local-acp-configured/default')
  f.s.driverConfig.acp.env = { EXAMPLE: 'private-local-credential' }
  const blocked = await f.preview()
  assert.equal(blocked.status, 'blocked')
  assert.doesNotMatch(JSON.stringify(blocked), /private-local-credential/)
  delete f.s.driverConfig.acp.env
  await f.confirm(p)
  assert.equal(f.selections[0].provider, 'local-acp-configured')
})

test('native folders and private donor folders, archives, and memory directories are checked both ways including symlinks', async t => {
  const f = await fixture(t)
  const member = f.add('Solo', {})
  const completed = await f.confirm(await f.preview())
  const bot = f.bots[completed.members[0].donorBotId]
  const dataDir = f.rt.config.godbotStateDir
  const inside = join(dataDir, 'nested'), alias = join(f.root, 'alias')
  await mkdir(inside)
  await symlink(dataDir, alias)
  for (const folder of [dataDir, inside, alias]) {
    await assert.rejects(f.rt.checkPrivacyChange(bot, { flag: true, moving: true, workDir: folder }), /NativeCrew data directory/)
  }
  await assert.rejects(f.rt.updateBot(bot.id, { private: true }, member.id), /Only the user/)
  await f.rt.updateBot(bot.id, { private: true })
  assert.equal((await f.preview()).status, 'blocked')
  assert.equal(f.s.snapshot().donorLinks.length, 0)
  assert.ok(!(await f.preview()).members[0].donorSessionId)
  const aliasPrivate = join(f.root, 'alias-private')
  await symlink(bot.workDir, aliasPrivate)
  for (const dir of [bot.workDir, aliasPrivate, completed.workspaceRoot, f.home]) {
    assert.throws(() => f.act('team.create', { name: 'Public', cwd: dir }), /private Bot/)
    assert.throws(() => f.act('member.profile', { memberId: member.id, cwd: dir }), /private Bot/)
  }
  f.rt.state.privateArchives.push({ id: bot.id, workDir: bot.workDir })
  delete f.bots[bot.id]
  assert.throws(() => f.add('Other', { cwd: aliasPrivate }), /private Bot/)
  assert.equal(f.opened.length, 0)
})

test('source pages bind the member, linked audience and evidence revisions; confirmation survives lost flush and restart', async t => {
  const f = await fixture(t)
  const a = f.add('Writer', { memory: 'private notebook' })
  const b = f.add('Reviewer', {})
  const legacy = await f.confirm(await f.preview())
  const botId = legacy.members.find(m => m.memberId === a.id).donorBotId
  const roomId = legacy.donorRoomId
  f.rt.sessionOfRoom = room => room.id
  f.rt.ensureCapabilities = async () => {}
  const events = []
  let failFlush = true
  f.rt.resolveAgent = async id => ({ session: { id, snapshotEvents: () => events },
    followup: message => events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } }) })
  f.rt.ctx.sessions = { async flush() { if (failFlush) { failFlush = false; throw new Error('flush interrupted') } } }
  const s = f.s.store
  const fields = { teamId: f.team.id, ownerId: a.id, taskId: 'task-a' }
  s.put('tasks', { ...fields, id: fields.taskId, title: 'Article', criteria: 'Source evidence', status: 'completed' })
  for (const [rev, status] of [[1, 'rework'], [2, 'accepted']]) {
    s.put('messages', { ...fields, id: 'result-' + rev, kind: 'report', text: 'R-' + rev, evidenceRevision: rev })
    s.put('messages', { ...fields, id: 'review-' + rev, kind: 'ack', acknowledges: 'review', replyTo: 'result-' + rev, status, text: status })
  }
  s.put('messages', { ...fields, teamId: 'other-team', id: 'unrelated', kind: 'report', text: 'outside', evidenceRevision: 5 })
  const own = { targetId: botId, sessionId: botId }
  const room = { targetId: roomId, sessionId: roomId }
  const page = await f.act('legacy.sources', { ...own, limit: 1 })
  assert.deepEqual(page.rows.map(r => [r.id, r.status]), [['result-2', 'accepted']])
  const older = await f.act('legacy.sources', { ...own, limit: 1, before: page.next })
  assert.deepEqual(older.rows.map(r => [r.id, r.status]), [['result-1', 'rework']])
  assert.deepEqual((await f.act('legacy.sources', room)).rows.map(r => r.id), ['result-2'])
  await assert.rejects(f.act('legacy.sources', { ...room, section: 'memory' }), /不可访问/)
  await assert.rejects(f.act('legacy.handoffPreview', { ...room, selected: [{ section: 'evidence', id: 'result-1' }] }), /不可访问/)
  const selected = [{ section: 'evidence', id: 'result-2' }]
  const prepare = target => f.act('legacy.handoffPreview', { ...target, selected })
  const send = (target, preview) => f.act('legacy.handoffConfirm', { ...target, selected, previewId: preview.previewId })
  const p = await prepare(own)
  assert.match(p.text, /证据 R2/)
  assert.doesNotMatch(p.text, /private notebook|outside|R-1/)
  await assert.rejects(send(own, p), /flush interrupted/)
  assert.equal(events.length, 1)
  await f.restart()
  const [one, retry] = await Promise.all([send(own, p), send(own, p)])
  assert.equal(one.requestId, retry.requestId)
  assert.equal(events.length, 1)
  const shared = await prepare(room)
  f.rooms[roomId].members = [b.id] // stale membership cannot retain the original source
  await assert.rejects(send(room, shared), /不可访问/)
  f.bots[botId].private = true
  await assert.rejects(send(own, p), /不可访问/)
  assert.equal(events.length, 1)
})

test('a private change during asynchronous preparation prevents the selected memory entering the Bot inbox', async t => {
  const f = await fixture(t)
  const m = f.add('Solo', { memory: 'selected memory' })
  const done = await f.confirm(await f.preview())
  const bot = f.bots[done.members[0].donorBotId]
  const req = { targetId: bot.id, sessionId: bot.id, selected: [{ section: 'memory', id: m.id }] }
  const plan = await f.act('legacy.handoffPreview', req)
  let sends = 0
  f.rt.resolveAgent = async () => ({ session: { id: bot.id }, followup() { sends++ } })
  f.rt.ensureCapabilities = async () => { await f.rt.updateBot(bot.id, { private: true }) }
  await assert.rejects(f.act('legacy.handoffConfirm', { ...req, previewId: plan.previewId }), /不可访问/)
  assert.equal(sends, 0)
  assert.equal(f.s.store.all('nativeHandoffs').length, 0)
})

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { NativeCrewService } from '../fixtures/member-service.js'
import { profileChanges } from '../fixtures/member-team.js'

async function until(read) {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value) return value
    await sleep(5)
  }
  throw new Error('Timed out waiting for member state')
}

async function setup(t, driverConfig = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-member-profile-')))
  const cwd = join(root, 'repo'), other = join(root, 'next')
  await mkdir(cwd); await mkdir(other)
  const connected = [], starts = [], configurations = [], unavailable = new Set()
  const stateDir = join(root, 'state')
  const create = () => new NativeCrewService({ stateDir, driverConfig, openDriver: async options => {
    connected.push(options)
    if (unavailable.has(options.config.model)) throw new Error('Configured model unavailable')
    let nativeOptions = { currentModel: 'model-a', currentEffort: 'low' }
    return {
      capabilities: { steer: true }, nativeId: options.resumeId || 'session-' + connected.length,
      ...(options.kind === 'dsh' ? { appliedRoute: options.config.followProfileDefault
        ? { provider: 'profile', model: 'default' }
        : { provider: options.config.provider, model: options.config.model } } : {}),
      async start(request) { starts.push({ ...request, options }) },
      async close() {},
      async configure(patch) {
        configurations.push(patch)
        nativeOptions = { currentModel: patch.model ?? 'cli-model', currentEffort: patch.effort ?? 'cli-effort' }
        return nativeOptions
      },
      async describe() { return nativeOptions },
    }
  } })
  let service = create()
  await service.ready()
  const team = service.dispatch({ action: 'team.create', name: 'Team', cwd })
  const act = (action, options) => service.dispatch({ action, ...options })
  const add = (name, options = {}) => act('member.add', { teamId: team.id, name, kind: 'codex', ...options })
  const member = id => service.store.get('members', id)
  async function restart() { await service.close(); service = create(); await service.ready() }
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }) })
  return { cwd, other, stateDir, connected, starts, configurations, unavailable, team, add, act, member, restart, get service() { return service } }
}

test('profile identity and notes persist, only the matching member receives them on its next turn', async t => {
  const s = await setup(t)
  const writer = s.add('Writer', { role: 'Write executable examples', memory: 'owner-note-42' })
  const reviewer = s.add('Reviewer', { cwd: s.other })
  s.act('member.send', { memberId: writer.id, text: 'First task' })
  s.act('member.send', { memberId: reviewer.id, text: 'Review docs' })
  await until(() => s.starts.length === 2)
  const first = s.starts.find(x => x.options.memberId === writer.id)
  const peer = s.starts.find(x => x.options.memberId === reviewer.id)
  assert.match(first.text, /Role instructions:\nWrite executable examples/)
  assert.match(first.text, /Fixed memory for this member:\nowner-note-42/)
  assert.match(first.text, /\[Current task\]\nFirst task/)
  assert.equal(peer.text, 'Review docs')
  assert.doesNotMatch(JSON.stringify(s.service.memberTool(reviewer.id, 'list_members')), /owner-note-42/)
  assert.throws(() => s.act('member.profile', { memberId: writer.id, name: 'reviewer' }), /already in use/)
  assert.throws(() => s.act('member.profile', { memberId: writer.id, cwd: s.other }), /current activity/)
  s.act('member.profile', { memberId: writer.id, name: 'Implementation', role: 'Improve the tests', memory: '' })
  assert.equal(s.member(writer.id).activeTurnId, first.turnId)
  first.options.onEvent({ type: 'done', turnId: first.turnId, status: 'completed' })
  peer.options.onEvent({ type: 'done', turnId: peer.turnId, status: 'completed' })
  await s.restart()
  assert.equal(s.member(writer.id).name, 'Implementation')
  assert.equal(s.member(writer.id).memory, '')
  assert.throws(() => s.act('member.profile', { memberId: writer.id, role: '🙃'.repeat(4001) }), /4000/)
  s.act('member.send', { memberId: writer.id, text: 'Next task' })
  await until(() => s.starts.length === 3)
  assert.match(s.starts[2].text, /Improve the tests/)
  assert.doesNotMatch(s.starts[2].text, /owner-note-42|Write executable examples/)
  s.starts[2].options.onEvent({ type: 'done', turnId: s.starts[2].turnId, status: 'completed' })
  s.act('member.profile', { memberId: writer.id, role: '' })
  s.act('member.send', { memberId: writer.id, text: 'No overrides' })
  await until(() => s.starts.length === 4)
  assert.match(s.starts[3].text, /Role instructions:\n\(none\)\n\nFixed memory for this member:\n\(none\)/)
  assert.doesNotMatch(s.starts[3].text, /Improve the tests|owner-note-42/)
  s.starts[3].options.onEvent({ type: 'done', turnId: s.starts[3].turnId, status: 'completed' })
})

test('a cwd change preserves the old session record and starts fresh at the new real directory', async t => {
  const s = await setup(t)
  const member = s.add('Coder')
  s.act('member.send', { memberId: member.id, text: 'Original task' })
  const first = await until(() => s.starts[0])
  const originalId = s.member(member.id).nativeId
  first.options.onEvent({ type: 'done', turnId: first.turnId, status: 'completed' })
  s.act('member.profile', { memberId: member.id, cwd: s.other })
  await until(() => s.member(member.id).cwd === s.other)
  const event = s.service.store.all('events').find(e => e.type === 'workspace_changed')
  assert.equal(event.previousNativeId, originalId)
  assert.equal(event.previousCwd, s.cwd)
  s.act('member.send', { memberId: member.id, text: 'New directory' })
  const next = await until(() => s.starts[1])
  assert.equal(next.options.cwd, s.other)
  assert.equal(next.options.resumeId, undefined)
  next.options.onEvent({ type: 'done', turnId: next.turnId, status: 'completed' })
  const worktree = { ...member, workspaceMode: 'worktree', workspaceRoot: s.cwd, cwd: s.cwd }
  const nested = join(s.cwd, 'nested')
  await mkdir(nested)
  assert.deepEqual(profileChanges(s.service.store, worktree, { cwd: nested }, s.stateDir).workspace, { cwd: nested, workspaceRoot: s.cwd })
  assert.throws(() => profileChanges(s.service.store, worktree, { cwd: s.other }, s.stateDir), /own managed worktree/)
})

test('native reasoning and explicit CLI default resets persist across restart and override profile launch settings', async t => {
  const s = await setup(t, { codex: { model: 'installed-override', effort: 'configured-override' } })
  const m = s.add('Coder')
  const configure = async settings => {
    s.act('member.configure', { memberId: m.id, ...settings })
    await until(() => s.member(m.id).status === 'idle')
  }
  await configure({ model: 'model-a', effort: 'high' })
  assert.deepEqual(s.member(m.id).nativeSettings, { model: 'model-a', effort: 'high' })
  await configure({ model: 'model-b' })
  assert.equal(s.member(m.id).nativeSettings.effort, null)
  await configure({ model: null, effort: null })
  assert.deepEqual(s.configurations.at(-1), { model: null, effort: null })
  await s.restart()
  s.act('member.send', { memberId: m.id, text: 'Use CLI settings' })
  const turn = await until(() => s.starts[0])
  assert.equal(turn.options.config.effort, null)
  assert.equal(turn.options.config.model, null)
  turn.options.onEvent({ type: 'done', turnId: turn.turnId, status: 'completed' })
})

test('implicit DSH settings follow the profile, preserve a Host route and retain the last confirmed route after failure', async t => {
  const ordinary = await setup(t)
  const implicit = ordinary.add('Default', { kind: 'dsh' })
  const implicitView = ordinary.service.snapshot().members.find(member => member.id === implicit.id)
  assert.equal(implicitView.routeSource, 'profile')
  assert.equal(implicitView.followProfileDefault, true)
  ordinary.act('member.send', { memberId: implicit.id, text: 'Hello' })
  const defaultTurn = await until(() => ordinary.starts[0])
  assert.equal(defaultTurn.options.config.followProfileDefault, true)
  defaultTurn.options.onEvent({ type: 'done', turnId: defaultTurn.turnId, status: 'completed' })

  const host = { provider: 'host', model: 'host-model' }
  const s = await setup(t, { dsh: host })
  const m = s.add('Worker', { kind: 'dsh' })
  const view = () => s.service.snapshot().members.find(member => member.id === m.id)
  assert.deepEqual(view().hostRoute, host)
  assert.equal(view().routeSource, 'host')
  s.act('member.send', { memberId: m.id, text: 'Hello' })
  const turn = await until(() => s.starts[0])
  turn.options.onEvent({ type: 'done', turnId: turn.turnId, status: 'completed' })
  const nativeId = view().nativeId
  assert.deepEqual(view().appliedRoute, host)
  s.unavailable.add('temporarily-missing')
  const choice = { provider: 'private', model: 'temporarily-missing' }
  s.act('member.model', { memberId: m.id, ...choice })
  assert.equal(view().routeStatus, 'applying')
  await until(() => view().routeStatus === 'failed')
  assert.equal(view().routeSource, 'member')
  assert.equal(view().route.model, choice.model)
  assert.match(view().lastError, /unavailable/)
  assert.deepEqual(view().appliedRoute, host)
  s.unavailable.clear()
  s.act('member.reconnect', { memberId: m.id })
  await until(() => view().routeStatus === 'applied')
  assert.deepEqual(view().appliedRoute, choice)
  assert.equal(view().nativeId, nativeId)
  s.act('member.model', { memberId: m.id, useDefault: true })
  await until(() => view().routeStatus === 'applied')
  assert.equal(view().routeSource, 'profile')
  assert.equal(view().appliedRoute.model, 'default')
})

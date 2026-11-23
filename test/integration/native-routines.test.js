import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'
import { nextRoutineTime, normalizeRoutineTiming } from '../../src/host/routine-timing.js'
import { Store } from '../../src/host/store.js'
import { workspaceCommand } from '../../src/host/workspace-archive.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-routine-'))
  let service
  const starts = []
  async function restart() {
    await service?.close()
    service = new NativeCrewService({ stateDir: dir, openDriver: async ({ memberId, onEvent }) => ({
      nativeId: memberId, capabilities: {}, close: async () => {},
      start: async turn => { starts.push({ ...turn, finish: () => onEvent({ type: 'done', status: 'completed', turnId: turn.turnId }) }) },
    }) })
    await service.ready()
  }
  await restart()
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }) })
  const team = service.dispatch({ action: 'team.create', name: 'Engineering', cwd: dir })
  const member = service.dispatch({ action: 'member.add', teamId: team.id, kind: 'dsh', name: 'Release', cwd: dir })
  const call = (name, args = {}) => service.dispatch({ action: 'automation.routine.' + name, teamId: team.id, ...args })
  const form = { title: 'Read the release notes', criteria: 'Summarize delivered changes', ownerId: member.id,
    schedule: { kind: 'interval', minutes: 5 } }
  return { call, form, team, member, dir, restart, starts, get service() { return service } }
}

async function until(fn) {
  for (let i = 0; i < 300; i++) {
    const value = fn()
    if (value) return value
    await delay(10)
  }
  assert.fail('Timed out waiting for scheduled delivery')
}

test('a native host timer dispatches, records a receipt and follows the ordinary review lifecycle', async t => {
  const f = await fixture(t)
  const at = Date.now() + 150
  const routine = f.call('create', { ...f.form, schedule: { kind: 'once', at: new Date(at).toISOString() } })
  const turn = await until(() => f.starts[0])
  const delivered = f.call('list').routines[0]
  assert.equal(delivered.id, routine.id)
  assert.equal(delivered.status, 'finished')
  const history = () => f.call('history', { id: routine.id }).items
  const [entry] = history()
  assert.equal(entry.trigger, 'scheduled')
  assert.equal(entry.dueAt, at)
  const task = f.service.store.require('tasks', entry.rootTaskId)
  assert.ok(task.unattended)
  assert.equal(task.runId, entry.runId)
  assert.equal(task.criteria, f.form.criteria)
  f.service.memberTool(f.member.id, 'report_result', { taskId: task.id, evidence: 'Four changes reviewed' })
  turn.finish()
  assert.equal(history()[0].state, 'needs_input')
  f.service.dispatch({ action: 'task.review', taskId: task.id, approve: true })
  assert.equal(history()[0].state, 'completed')
  await f.restart()
  assert.equal(history().length, 1)
  assert.equal(f.starts.length, 1)
  assert.equal(f.service.snapshot().tasks.length, 1)
})

test('missed slots coalesce across restart and retries preserve the original assignment and cadence', async t => {
  const f = await fixture(t)
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const create = { ...f.form, requestId: randomUUID() }
  const initial = f.call('create', create)
  assert.equal(f.call('create', create).id, initial.id)
  const overdue = initial.nextAt
  clock += 22 * 60000
  await f.restart()
  await until(() => f.starts.length)
  const { id } = initial
  const current = () => f.call('list').routines[0]
  assert.equal(current().nextAt, overdue + 20 * 60000)
  let items = f.call('history', { id }).items
  assert.deepEqual(items.map(i => i.dueAt), [overdue])
  const run = { id, requestId: randomUUID() }
  const manual = f.call('run', run)
  const changed = f.call('update', { id, ...f.form, title: 'New instructions', revision: initial.revision })
  assert.equal(changed.nextAt, current().nextAt)
  assert.deepEqual(f.call('run', run), manual)
  assert.throws(() => f.call('update', { id, ...f.form, revision: initial.revision }), /刷新/)
  f.call('pause', { id, revision: changed.revision })
  clock += 93 * 60000
  f.service.routines.runDue()
  assert.equal(f.call('history', { id }).items.length, 2)
  assert.ok(f.call('run', { id, requestId: randomUUID() }).runId)
  assert.equal(current().status, 'paused')
  assert.equal(current().nextAt, null)
  const resumed = f.call('resume', { id })
  assert.ok(resumed.nextAt > clock)
  assert.equal((resumed.nextAt - overdue) % (5 * 60000), 0)
  f.service.dispatch({ action: 'team.stop', teamId: f.team.id })
  clock = resumed.nextAt
  f.service.routines.runDue()
  items = f.call('history', { id }).items
  assert.equal(items[0].state, 'skipped')
  assert.equal(items[0].runId, undefined)
  assert.equal(f.service.snapshot().tasks.length, 3)
  const other = f.service.dispatch({ action: 'team.create', name: 'Outside', cwd: f.dir })
  assert.equal(f.call('list', { teamId: other.id }).routines.length, 0)
  assert.throws(() => f.call('history', { id, teamId: other.id }))
  assert.throws(() => f.call('delete', { id, teamId: other.id }))
  f.call('delete', { id })
  await f.restart()
  assert.equal(f.call('list').routines.length, 0)
  assert.equal(f.service.snapshot().tasks.length, 3)
})

test('a timer runs the pinned workflow revision and retains node receipts after repinning the schedule', async t => {
  const f = await fixture(t)
  const act = (action, args) => f.service.dispatch({ action, teamId: f.team.id, ...args })
  const reviewer = act('member.add', { kind: 'dsh', name: 'Reviewer', cwd: f.dir })
  const nodes = [
    { id: 'draft', title: 'Prepare notes', ownerId: f.member.id, criteria: 'Provide notes' },
    { id: 'publish', title: 'Check notes', ownerId: reviewer.id, criteria: 'Verify evidence' },
  ]
  const flow = act('workflow.save', { name: 'Release workflow', nodes, edges: [{ from: 'draft', to: 'publish', when: 'accepted' }] })
  const config = { title: 'Review release', target: 'workflow', workflowId: flow.id, workflowRevision: 1,
    schedule: { kind: 'once', at: new Date(Date.now() + 250).toISOString() } }
  const plan = f.call('create', config)
  assert.deepEqual(f.call('list').workflows, [{ id: flow.id, name: flow.name, revision: 1 }])
  assert.equal(plan.workflowSnapshot, undefined)
  const v2 = act('workflow.save', { id: flow.id, expectedRevision: 1, name: flow.name, nodes: [nodes[0]], edges: [] })
  assert.throws(() => f.call('create', config), /版本已更新/)
  const other = act('team.create', { name: 'Elsewhere', cwd: f.dir })
  assert.throws(() => f.call('create', { ...config, teamId: other.id, workflowRevision: v2.revision }), /不属于当前团队/)
  const history = () => f.call('history', { id: plan.id }).items
  const firstTurn = await until(() => f.starts[0])
  const first = history()[0]
  assert.equal(first.trigger, 'scheduled')
  assert.equal(first.workflowRevision, 1)
  assert.deepEqual(first.nodes.map(n => n.nodeId), ['draft', 'publish'])
  assert.equal(first.nodes[1].status, 'waiting')
  assert.equal(f.service.store.require('automationRuns', first.runId).principalId, plan.id)
  const drafts = first.nodes[0].taskId, checks = first.nodes[1].taskId
  act('task.report', { taskId: drafts, evidence: 'release notes ready' })
  firstTurn.finish()
  assert.equal(history()[0].state, 'needs_input')
  act('task.review', { taskId: drafts, approve: true })
  const secondTurn = await until(() => f.starts[1])
  act('task.report', { taskId: checks, evidence: 'checks passed' })
  secondTurn.finish()
  act('task.review', { taskId: checks, approve: true })
  await until(() => history()[0].state === 'completed')
  assert.ok(history()[0].nodes.every(node => node.reviewedEvidenceRevision === 1))
  const id = plan.id
  await f.restart()
  assert.equal(history().length, 1)
  const edited = f.call('update', { ...config, id, title: 'Weekly checks', schedule: f.form.schedule })
  assert.equal(edited.workflowRevision, 1)
  const manualRequest = { id, requestId: randomUUID() }
  const manual = f.call('run', manualRequest)
  assert.deepEqual(f.call('run', manualRequest), manual)
  assert.equal(history()[0].workflowRevision, 1)
  assert.equal(history()[0].nodes.length, 2)
  f.call('update', { ...config, id, workflowRevision: v2.revision, schedule: f.form.schedule, revision: edited.revision })
  f.call('run', { id, requestId: randomUUID() })
  assert.deepEqual(history().map(entry => [entry.workflowRevision, entry.nodes.length]), [[2, 1], [1, 2], [1, 2]])
  f.call('update', { id, ...f.form, target: 'member' })
  assert.equal(f.call('list').routines[0].workflowId, undefined)
  f.call('run', { id, requestId: randomUUID() })
  assert.equal(history()[0].workflowId, undefined)
  assert.equal(history()[1].workflowId, flow.id)
})

test('a failed scheduled assignment rolls back its task, records the failure and advances', async t => {
  const f = await fixture(t)
  const plan = f.call('create', f.form)
  const assign = f.service.team.assign.bind(f.service.team)
  const mocked = t.mock.method(f.service.team, 'assign', (...args) => {
    assign(...args)
    throw new Error('Assignment interrupted')
  })
  f.service.routines.runDue(plan.nextAt)
  mocked.mock.restore()
  assert.equal(f.service.snapshot().tasks.length, 0)
  const [failed] = f.call('history', { id: plan.id }).items
  assert.equal(failed.state, 'failed')
  assert.match(failed.reason, /interrupted/)
  const [next] = f.call('list').routines
  assert.equal(next.nextAt, plan.nextAt + 5 * 60000)
  f.service.routines.runDue(next.nextAt)
  assert.equal(f.service.snapshot().tasks.length, 1)
})

async function archiveProfile(t, directory) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  new Store(dir).close()
  const home = join(dir, directory)
  await mkdir(join(home, 'workspace'), { recursive: true })
  await writeFile(join(home, 'state.json'), JSON.stringify({ folder: join(home, 'workspace') }))
  return { dir, home }
}

test('restoring a Bot workspace keeps schedules paused and supports rollback', async t => {
  const source = await archiveProfile(t, 'ds-bot'), target = await archiveProfile(t, 'team-workspace')
  const schedule = { id: 'board-schedule', teamId: 'godbot-workspace', status: 'active', revision: 1 }
  const store = new Store(source.dir)
  store.put('nativeRoutines', schedule)
  store.close()
  const archive = join(source.dir, 'workspace.enc'), password = join(source.dir, 'pass')
  await writeFile(password, randomUUID())
  await writeFile(join(source.home, 'workspace', 'team.txt'), 'original workspace')
  const args = (verb, dir) => [verb, '--home', dir, '--state-dir', dir, '--file', archive, '--password-file', password]
  await workspaceCommand(args('backup', source.dir))
  await workspaceCommand(args('restore', target.dir))
  const restored = new Store(target.dir)
  try {
    assert.equal(restored.get('nativeRoutines', schedule.id).status, 'paused')
    assert.equal(restored.get('nativeRoutines', schedule.id).nextAt, null)
  } finally { restored.close() }
  assert.equal(JSON.parse(await readFile(join(target.home, 'state.json'))).folder, await realpath(join(target.home, 'workspace')))
  assert.equal(await readFile(join(target.home, 'workspace', 'team.txt'), 'utf8'), 'original workspace')
  await workspaceCommand(args('rollback', target.dir))
  await assert.rejects(readFile(join(target.home, 'workspace', 'team.txt')), { code: 'ENOENT' })
})

test('restore checkpoints a crashed destination WAL and rollback recovers its last committed task', async t => {
  const source = await archiveProfile(t, 'team-workspace'), target = await archiveProfile(t, 'team-workspace')
  const sourceStore = new Store(source.dir)
  sourceStore.put('tasks', { id: 'source-task', teamId: 'godbot-workspace' })
  sourceStore.close()
  const archive = join(source.dir, 'workspace.enc'), password = join(source.dir, 'password')
  await writeFile(password, randomUUID())
  const args = (verb, dir) => [verb, '--home', dir, '--state-dir', dir, '--file', archive, '--password-file', password]
  await workspaceCommand(args('backup', source.dir))

  const targetDb = join(target.dir, 'godbot.sqlite3')
  const writer = new DatabaseSync(targetDb)
  try {
    writer.exec('BEGIN IMMEDIATE')
    await assert.rejects(workspaceCommand(args('restore', target.dir)), /Stop active SQLite/)
    await assert.rejects(stat(join(target.dir, '.godbot-restore.json')), { code: 'ENOENT' })
  } finally { writer.close() }
  const crash = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1])
    db.exec('PRAGMA wal_autocheckpoint=0')
    db.prepare('INSERT INTO records(collection,id,data) VALUES(?,?,?)').run(
      'tasks', 'destination-task', JSON.stringify({ id: 'destination-task', teamId: 'godbot-workspace' }))
    process.kill(process.pid, 'SIGKILL')
  `, targetDb])
  assert.equal(crash.signal, 'SIGKILL', crash.stderr.toString())
  assert.ok((await stat(targetDb + '-wal')).size > 32)
  await workspaceCommand(args('restore', target.dir))
  const readIds = () => {
    const db = new DatabaseSync(targetDb, { readOnly: true })
    try { return db.prepare("SELECT id FROM records WHERE collection='tasks'").all().map(row => row.id) }
    finally { db.close() }
  }
  assert.deepEqual(readIds(), ['source-task'])
  await workspaceCommand(args('rollback', target.dir))
  assert.deepEqual(readIds(), ['destination-task'])
})

test('calendar timing respects ISO weekdays, non-hour offsets and daylight-saving gaps/folds', () => {
  const next = (schedule, after) => new Date(nextRoutineTime(normalizeRoutineTiming(schedule), Date.parse(after))).toISOString()
  const daily = { kind: 'daily', time: '02:30', timeZone: 'America/New_York' }
  assert.equal(next(daily, '2026-03-07T08:00:00Z'), '2026-03-09T06:30:00.000Z')
  const fold = { ...daily, time: '01:30' }
  assert.equal(next(fold, '2026-11-01T04:00:00Z'), '2026-11-01T05:30:00.000Z')
  assert.equal(next(fold, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z')
  const weekly = { kind: 'weekly', weekdays: [7], time: '00:00', timeZone: 'Asia/Kathmandu' }
  assert.equal(next(weekly, '2026-11-20T00:00:00Z'), '2026-11-21T18:15:00.000Z')
  for (const invalid of [{ ...weekly, weekdays: [] }, { ...weekly, timeZone: 'wrong' },
    { ...daily, time: '25:00' }, { kind: 'once', at: '2026-01-01T00:00:00' }, { kind: 'once', at: '2027-02-29T00:00Z' },
    { kind: 'interval', minutes: 0 }])
    assert.throws(() => normalizeRoutineTiming(invalid))
})

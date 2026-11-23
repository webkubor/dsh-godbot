import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-workflow-'))
  const turns = new Map()
  const open = () => new NativeCrewService({
    stateDir: join(dir, 'state'),
    openDriver: async ({ memberId, onEvent }) => ({
      nativeId: memberId, capabilities: {},
      async start(cmd) {
        turns.set(memberId, { ...cmd, end: () => onEvent({ type: 'done', turnId: cmd.turnId, status: 'completed' }) })
        onEvent({ type: 'started', turnId: cmd.turnId })
      },
      async close() {},
    }),
  })
  let service = open()
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }) })
  await service.ready()
  const team = service.dispatch({ action: 'team.create', name: 'Editors', cwd: dir })
  const act = (action, input = {}) => service.dispatch({ action, teamId: team.id, ...input })
  const add = (name, teamId = team.id) => {
    const cwd = join(dir, name)
    mkdirSync(cwd)
    return act('member.add', { name, cwd, kind: 'dsh', teamId }).id
  }
  const author = add('Writer'), editor = add('Reviewer'), lead = add('Publisher')
  const node = (id, ownerId = author, mode = 'all') => ({ id, title: id, ownerId, criteria: 'Supply evidence', join: mode })
  const save = (nodes, edges) => act('workflow.save', { name: 'Publishing', nodes, edges })
  const run = (def, requestId = randomUUID()) => act('workflow.run', { id: def.id, expectedRevision: def.revision, requestId })
  const tasks = run => Object.fromEntries(service.store.forRun('tasks', run.id).map(task => [task.workflowNodeId, task]))
  const report = (task, evidence) => act('task.report', { taskId: task.id, evidence })
  const review = (task, approve = true, evidence) => act('task.review', { taskId: task.id, approve, evidence })
  return { act, get service() { return service }, turns, team, author, editor, lead, add, node, save, run, tasks, report, review,
    async restart() { await service.close(); service = open(); await service.ready() } }
}
const edge = (from, to, when = 'accepted', value) => ({ from, to, when, ...(value === undefined ? {} : { value }) })

test('workflow validates references, preserves graph order and requires the revision for edits and runs', async t => {
  const f = await fixture(t)
  const a = f.node('a'), b = f.node('b')
  const another = f.act('team.create', { name: 'Other', cwd: tmpdir() })
  const outsider = f.add('Outsider', another.id)
  for (const [nodes, edges, issue] of [
    [[], [], /at least one/], [[a, a], [], /Duplicate/],
    [[a, b], [edge('a', 'b'), edge('b', 'a')], /cycle/], [[a], [edge('a', 'a')], /itself/],
    [[a, b], [edge('a', 'missing')], /unknown node/], [[a, b], [edge('a', 'b'), edge('a', 'b')], /Duplicate/],
    [[a, b], [edge('a', 'b', 'contains', '  ')], /value/], [[a, b], [edge('a', 'b', 'execute')], /condition/],
    [[{ ...a, ownerId: outsider }], [], /this team/], [[{ ...b, join: 'sometimes' }], [], /join/],
  ]) assert.throws(() => f.save(nodes, edges), issue)
  const def = f.save([b, a], [edge('a', 'b')])
  assert.deepEqual(def.nodes, [b, a])
  const edits = { id: def.id, name: 'Second edition', nodes: [a], edges: [] }
  assert.throws(() => f.act('workflow.save', edits), /revision/)
  assert.throws(() => f.act('workflow.run', { id: def.id, requestId: randomUUID() }), /revision/)
  assert.throws(() => f.act('workflow.run', { id: def.id, expectedRevision: def.revision }), /request ID/)
  assert.throws(() => f.act('workflow.save', { ...edits, teamId: another.id, expectedRevision: def.revision }), /this team/)
  assert.throws(() => f.act('workflow.run', { id: def.id, teamId: another.id, expectedRevision: def.revision, requestId: randomUUID() }), /this team/)
  assert.deepEqual(f.act('workflow.list', { teamId: another.id }), { workflows: [], runs: [] })
  const id = randomUUID()
  const first = f.run(def, id)
  const updated = f.act('workflow.save', { ...edits, expectedRevision: 1 })
  assert.equal(updated.revision, 2)
  assert.throws(() => f.run(def), /revision/)
  assert.throws(() => f.run(updated, id), /different input/)
  assert.equal(f.run(def, id).id, first.id)
  const second = f.run(updated)
  assert.deepEqual(f.act('workflow.list').runs.map(r => [r.id, r.workflowRevision, r.definition.nodes.map(n => n.id)]),
    [[second.id, 2, ['a']], [first.id, 1, ['b', 'a']]])
})

test('parallel native nodes feed only accepted matching evidence into all/any joins and keep skipped branches closed', async t => {
  const f = await fixture(t)
  const graph = f.save([
    f.node('any', f.lead, 'any'), f.node('all', f.lead), f.node('through-skip', f.lead, 'any'),
    f.node('never', f.lead), f.node('if-no-error', f.lead), f.node('no-matches', f.lead, 'any'),
    f.node('a'), f.node('b', f.editor),
  ], [
    edge('a', 'any', 'contains', 'GREEN'), edge('b', 'any', 'not-contains', 'RED'),
    edge('a', 'all'), edge('b', 'all', 'contains', 'green'),
    edge('all', 'through-skip'), edge('a', 'through-skip'), edge('all', 'never'),
    edge('a', 'if-no-error', 'not-contains', 'ERROR'),
    edge('a', 'no-matches', 'contains', 'green'), edge('b', 'no-matches', 'not-contains', 'RED'),
  ])
  const run = f.run(graph)
  const read = () => f.tasks(run)
  for (let i = 0; f.turns.size < 2 && i < 100; i++) await delay(5)
  assert.ok(f.turns.has(f.author) && f.turns.has(f.editor))
  f.report(read().a, 'GREEN approved for print')
  f.turns.get(f.author).end()
  assert.equal(read().any.status, 'waiting')
  f.review(read().a)
  assert.equal(read().any.status, 'waiting')
  f.report(read().b, 'RED withheld until Friday')
  f.turns.get(f.editor).end()
  assert.equal(f.act('workflow.list').runs[0].status, 'needs-review')
  f.review(read().b)
  const tasks = read()
  assert.equal(tasks.all.status, 'skipped')
  assert.equal(tasks.never.status, 'skipped')
  assert.equal(tasks['no-matches'].status, 'skipped')
  assert.equal(tasks.never.attempt, 0)
  assert.throws(() => f.act('task.transfer', { taskId: tasks.never.id, ownerId: f.editor, expectedRevision: tasks.never.revision }), /cannot be transferred/)
  const assignments = f.service.store.all('messages').filter(m => m.kind === 'assignment')
  for (const id of ['any', 'through-skip', 'if-no-error']) {
    assert.equal(tasks[id].status, 'assigned')
    const [message] = assignments.filter(m => m.taskId === tasks[id].id)
    assert.match(message.text, /GREEN approved for print/)
    assert.doesNotMatch(message.text, /withheld until Friday/)
    f.report(tasks[id], 'published')
    f.review(tasks[id])
  }
  assert.equal(f.act('workflow.list').runs[0].status, 'completed')
  assert.equal(assignments.length, 5)
})

test('failed prerequisites block even any joins; retry, review and durable restart release downstream once', async t => {
  const f = await fixture(t)
  const def = f.save([f.node('a'), f.node('b', f.editor), f.node('c', f.lead, 'any')], [edge('a', 'c'), edge('b', 'c')])
  const requestId = randomUUID()
  const run = f.run(def, requestId)
  const tasks = () => f.tasks(run)
  f.report(tasks().b, 'second report')
  f.review(tasks().b)
  f.act('task.fail', { taskId: tasks().a.id, reason: 'try again' })
  assert.equal(tasks().c.status, 'blocked')
  assert.equal(f.act('workflow.list').runs[0].status, 'blocked')
  f.act('task.retry', { taskId: tasks().a.id, expectedRevision: tasks().a.revision })
  assert.equal(tasks().c.status, 'waiting')
  f.report(tasks().a, 'outdated')
  f.review(tasks().a, false, 'fix the report')
  assert.equal(tasks().c.status, 'waiting')
  f.report(tasks().a, 'ready after edit')
  await f.restart()
  assert.equal(f.run(def, requestId).id, run.id)
  assert.equal(tasks().a.status, 'reported')
  f.review(tasks().a)
  const messages = f.service.store.all('messages').filter(m => m.kind === 'assignment' && m.taskId === tasks().c.id)
  assert.equal(messages.length, 1)
  assert.match(messages[0].text, /ready after edit/)
  assert.match(messages[0].text, /second report/)
  assert.doesNotMatch(messages[0].text, /outdated/)
  assert.deepEqual(f.act('workflow.list').runs.map(row => row.id), [run.id])
})

test('partial submission rolls back the run, initialized tasks, dispatches and idempotency receipt', async t => {
  const f = await fixture(t)
  const def = f.save([f.node('a'), f.node('b', f.editor)], [])
  const id = randomUUID()
  const enqueue = f.service.team.enqueue
  f.service.team.enqueue = input => {
    if (input.memberId === f.editor) throw new Error('fixture refused dispatch')
    return enqueue(input)
  }
  assert.throws(() => f.run(def, id), /refused dispatch/)
  f.service.team.enqueue = enqueue
  assert.deepEqual(f.act('workflow.list').runs, [])
  for (const collection of ['tasks', 'commands', 'messages']) assert.deepEqual(f.service.store.all(collection), [])
  assert.equal(f.run(def, id).nodes.length, 2)
  assert.equal(f.service.store.all('commands').length, 2)
})

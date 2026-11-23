import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate as drain } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'

function location(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'godbot-service-review-'))
  const stateDir = join(cwd, 'state')
  const attached = []
  t.after(async () => {
    try {
      for (const service of attached.reverse()) await service.close()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  return {
    cwd,
    stateDir,
    attach(service) {
      attached.push(service)
      return service
    },
  }
}

async function rig(t) {
  const paths = location(t)
  const connections = new Map()
  const service = paths.attach(
    new NativeCrewService({
      stateDir: paths.stateDir,
      openDriver: async ({ memberId, onEvent, resumeId }) => {
        const handle = {
          nativeId: resumeId || `native-${memberId}`,
          capabilities: { steer: true, interrupt: true, resume: true },
          starts: [],
          approvals: [],
          stops: [],
          onEvent,
          async start(request) {
            this.starts.push(request)
            onEvent({ type: 'started', turnId: request.turnId })
          },
          async respond(request) {
            this.approvals.push(request)
          },
          async interrupt(request) {
            this.stops.push(request)
          },
          async close() {},
        }
        connections.set(memberId, handle)
        return handle
      },
    }),
  )
  await service.ready()
  const dispatch = (action, fields) => service.dispatch({ action, ...fields })
  const team = dispatch('team.create', { name: 'test team', cwd: paths.cwd })
  const add = (name) => {
    const cwd = join(paths.cwd, name)
    mkdirSync(cwd)
    return dispatch('member.add', { teamId: team.id, name, kind: 'dsh', cwd })
  }
  const start = async (member) => {
    dispatch('member.send', { memberId: member.id, text: 'initial input' })
    await drain()
    const handle = connections.get(member.id)
    assert.ok(handle?.starts.length)
    return { handle, turnId: handle.starts[0].turnId }
  }
  return { ...paths, service, team, dispatch, connections, add, start }
}

test('a host restart during reconnect leaves the member recoverable without resending an input', async (t) => {
  const paths = location(t)
  const moduleUrl = new URL('../fixtures/member-service.js', import.meta.url).href
  const child = `import { NativeCrewService } from ${JSON.stringify(moduleUrl)}
    import { writeFileSync } from 'node:fs'
    const [stateDir,cwd] = process.argv.slice(1)
    const host = new NativeCrewService({stateDir,openDriver:async()=>{throw new Error('must not be needed')}})
    await host.ready()
    const team = host.dispatch({action:'team.create',cwd,name:'restored'})
    const member = host.dispatch({action:'member.add',teamId:team.id,kind:'dsh',name:'restored'})
    host.dispatch({action:'member.reconnect',memberId:member.id})
    writeFileSync(1,member.id)
    process.exit(0)`
  const memberId = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', child, paths.stateDir, paths.cwd],
    { encoding: 'utf8' },
  )
  const host = paths.attach(
    new NativeCrewService({
      stateDir: paths.stateDir,
      openDriver: async () => {
        throw new Error('Test adapter unavailable')
      },
    }),
  )
  await host.ready()
  await drain()
  const member = host.snapshot().members.find((m) => m.id === memberId)
  assert.notEqual(member.status, 'connecting', 'a stale connecting flag prevents every recovery action')
  assert.equal(host.snapshot().commands.length, 0)
  assert.doesNotThrow(() => host.dispatch({ action: 'member.reconnect', memberId }))
})

test('opening another host with the same store cannot mark a live owner turn lost', async (t) => {
  const { stateDir, attach, service, add, start } = await rig(t)
  const member = add('one')
  const { turnId, handle } = await start(member)
  // A host may reject a second writer at construction or readiness; either preserves the active owner's execution.
  try {
    const other = attach(
      new NativeCrewService({
        stateDir,
        openDriver: async () => {
          throw new Error('No work should be started')
        },
      }),
    )
    await other.ready()
  } catch (error) {
    assert.ok(error instanceof Error)
  }
  assert.equal(service.snapshot().members[0].activeTurnId, turnId)
  handle.onEvent({ type: 'done', turnId, status: 'completed' })
  assert.equal(service.snapshot().turns[0].status, 'completed')
})

test('an idle agent disconnect holds new messages or reopens the transport before writing', async (t) => {
  const { service, dispatch, connections, add, start } = await rig(t)
  const member = add('one')
  const { turnId, handle } = await start(member)
  handle.onEvent({ type: 'done', turnId, status: 'completed' })
  handle.onEvent({
    type: 'error',
    status: 'disconnected',
    deliveryUnknown: true,
    text: 'Agent process exited while idle',
  })
  const cmd = dispatch('member.send', { memberId: member.id, text: 'after process exit' })
  await drain()
  assert.equal(handle.starts.length, 1, 'a second prompt was written to the dead transport')
  assert.ok(
    connections.get(member.id) !== handle ||
      ['queued', 'retained'].includes(service.snapshot().commands.find((c) => c.id === cmd.id).status),
  )
})

test('stopping a team before a staged permission reply is written suppresses that reply', async (t) => {
  const { service, team, dispatch, add, start } = await rig(t)
  const member = add('one')
  const { turnId, handle } = await start(member)
  handle.onEvent({
    type: 'permission',
    turnId,
    requestId: 'permission',
    text: 'Run local tool?',
    options: [{ optionId: 'allow' }],
  })
  dispatch('interaction.respond', { interactionId: service.snapshot().interactions[0].id, decision: 'allow' })
  dispatch('team.stop', { teamId: team.id })
  await drain()
  assert.equal(handle.stops.length, 1)
  assert.equal(handle.approvals.filter((response) => response.decision === 'allow').length, 0)
  handle.onEvent({ type: 'done', turnId, status: 'interrupted' })
  assert.notEqual(service.snapshot().interactions[0].status, 'pending')
})

test('an assigned member’s evidence returns through its original task and exchange', async (t) => {
  const { service, add } = await rig(t)
  const lead = add('lead'),
    worker = add('worker')
  const task = service.memberTool(lead.id, 'assign_task', {
    to: worker.id,
    title: 'Run checks',
    criteria: 'record result',
  })
  await drain()
  const assignment = service
    .snapshot()
    .messages.find((message) => message.taskId === task.id && message.to.includes(worker.id))
  service.memberTool(worker.id, 'report_result', { taskId: task.id, evidence: 'All three checks passed.' })
  const returned = service
    .snapshot()
    .messages.find((message) => message.from === worker.id && message.to.includes(lead.id))
  assert.equal(returned.taskId, task.id)
  assert.equal(returned.replyTo, assignment.id)
  assert.equal(returned.exchangeId, assignment.exchangeId)
})

test('native cancellation confirms the urgent replacement before any older end-of-turn queue item', async (t) => {
  const { dispatch, add, start } = await rig(t)
  const member = add('primary')
  const { handle, turnId } = await start(member)
  dispatch('member.send', { memberId: member.id, text: 'ordinary follow-up' })
  dispatch('member.send', {
    memberId: member.id,
    text: 'urgent correction',
    mode: 'interrupt-send',
    expectedTurnId: turnId,
  })
  await drain()
  handle.onEvent({ type: 'done', status: 'interrupted', turnId })
  await drain()
  assert.deepEqual(
    handle.starts.map((item) => item.text),
    ['initial input', 'urgent correction'],
  )
})

test('the event cursor returns append-only deltas and restarts with a full snapshot on another host opening', async (t) => {
  const { service, stateDir, attach, add } = await rig(t)
  const member = add('event-member')
  const first = service.event(member, null, { type: 'text', text: 'one' })
  const snapshot = service.snapshot()
  const cursor = { afterEventSeq: snapshot.lastEventSeq, eventStreamId: snapshot.eventStreamId }
  assert.deepEqual(
    snapshot.events.map((e) => e.id),
    [first.id],
  )
  assert.equal(snapshot.eventAfter, null)
  const second = service.event(member, null, { type: 'text', text: 'two' })
  const delta = service.snapshot(cursor)
  assert.equal(delta.eventAfter, first.seq)
  assert.equal(delta.lastEventSeq, second.seq)
  assert.deepEqual(
    delta.events.map((e) => e.id),
    [second.id],
  )
  assert.equal(delta.members[0].id, member.id)
  assert.deepEqual(
    service.snapshot({ afterEventSeq: second.seq, eventStreamId: snapshot.eventStreamId }).events,
    [],
  )
  assert.equal(
    service.snapshot({ afterEventSeq: second.seq + 1, eventStreamId: snapshot.eventStreamId }).eventAfter,
    null,
  )
  assert.throws(() => service.snapshot({ afterEventSeq: -1 }), /afterEventSeq/)
  await service.close()
  const reopened = attach(new NativeCrewService({ stateDir }))
  await reopened.ready()
  const reset = reopened.snapshot(cursor)
  assert.notEqual(reset.eventStreamId, snapshot.eventStreamId)
  assert.equal(reset.eventAfter, null)
  assert.deepEqual(
    reset.events.map((e) => e.id),
    [first.id, second.id],
  )
  const different = attach(new NativeCrewService({ stateDir: join(stateDir, 'separate-profile') }))
  await different.ready()
  const replacement = different.snapshot(cursor)
  assert.equal(replacement.eventAfter, null)
  assert.deepEqual(replacement.events, [])
})

test('native secret answers reach their request but are absent from persisted results and receipt fingerprints', async (t) => {
  const { service, dispatch, add, start } = await rig(t)
  const member = add('secret-member'),
    { handle, turnId } = await start(member)
  handle.onEvent({
    type: 'question',
    turnId,
    requestId: 'q',
    text: 'fixture test field',
    questions: [
      { id: 's', question: 'fixture field', isSecret: true },
      { id: 'p', question: 'public field' },
    ],
  })
  const id = service.snapshot().interactions[0].id
  const answer = { s: ['not-a-real-secret-unique-test-value'], p: ['public answer'] }
  dispatch('interaction.respond', { interactionId: id, decision: 'answer', answer, requestId: 'secret-request' })
  await drain()
  assert.deepEqual(handle.approvals[0].answer, answer)
  assert.equal(JSON.stringify(service.snapshot()).includes(answer.s[0]), false)
  assert.equal(JSON.stringify(service.store.all('receipts')).includes(answer.s[0]), false)
  assert.equal(JSON.stringify(service.snapshot().interactions).includes('public answer'), true)
})

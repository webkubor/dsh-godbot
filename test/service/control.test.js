import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NativeCrewService } from '../fixtures/member-service.js'

async function until(check) {
  for (let n = 0; n < 100; n++) {
    const result = check()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 4))
  }
  throw new Error('Timed out awaiting test state')
}

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-control-'))
  const handles = new Map()
  const service = new NativeCrewService({
    stateDir: join(dir, 'state'),
    openDriver: async ({ onEvent, memberId, resumeId }) => {
      const calls = []
      const handle = {
        nativeId: resumeId ?? 'native-' + memberId,
        capabilities: { steer: true, interrupt: true, resume: true },
        start: async (cmd) => {
          calls.push(['start', cmd])
          onEvent({ type: 'started', turnId: cmd.turnId })
        },
        interrupt: async (cmd) => {
          calls.push(['stop', cmd])
        },
        steer: async (cmd) => {
          calls.push(['steer', cmd])
          return { status: 'accepted' }
        },
        respond: async (cmd) => {
          calls.push(['answer', cmd])
        },
        close: async () => {},
        calls,
        onEvent,
      }
      handles.set(memberId, handle)
      return handle
    },
  })
  t.after(async () => {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await service.ready()
  const act = (action, req) => service.dispatch({ action, ...req })
  const team = act('team.create', { name: 'Control', cwd: dir })
  function add(name, kind = 'dsh') {
    mkdirSync(join(dir, name))
    return act('member.add', { name, kind, teamId: team.id, cwd: join(dir, name) })
  }
  return { service, act, team, handles, add }
}

test('an interrupt ACK holds the replacement; late events never end a newer turn', async (t) => {
  const { service, act, handles, add } = await fixture(t)
  const member = add('primary')
  const first = act('member.send', { memberId: member.id, text: 'first' })
  await until(() => handles.get(member.id)?.calls.length)
  const h = handles.get(member.id),
    old = h.calls[0][1].turnId
  const steer = {
    memberId: member.id,
    text: 'correct',
    mode: 'steer',
    expectedTurnId: old,
    requestId: 'only-once',
  }
  const a = act('member.send', steer)
  assert.equal(act('member.send', steer).id, a.id)
  assert.throws(() => act('member.send', { ...steer, text: 'different' }), /different input/)
  const follow = act('member.send', {
    memberId: member.id,
    text: 'replacement',
    mode: 'interrupt-send',
    expectedTurnId: old,
  })
  await until(() => h.calls.some(([kind]) => kind === 'stop'))
  assert.equal(h.calls.filter(([kind]) => kind === 'start').length, 1)
  h.onEvent({ type: 'done', status: 'interrupted', turnId: old })
  await until(() => h.calls.filter(([kind]) => kind === 'start').length === 2)
  const next = h.calls.at(-1)[1].turnId
  h.onEvent({ type: 'done', status: 'completed', turnId: old })
  const s = service.snapshot()
  assert.equal(s.members[0].activeTurnId, next)
  assert.equal(s.turns.find((t) => t.commandId === first.id).status, 'interrupted')
  assert.equal(s.turns.find((t) => t.commandId === follow.id).id, next)
  assert.throws(() => act('member.send', { ...steer, requestId: 'old' }), /target turn/i)
})

test('queued editing, withdrawal, stop-team scope and stale permission answers', async (t) => {
  const { service, act, handles, team, add } = await fixture(t)
  const member = add('main')
  act('member.send', { memberId: member.id, text: 'first' })
  await until(() => handles.get(member.id)?.calls.length)
  const h = handles.get(member.id),
    turnId = h.calls[0][1].turnId
  h.onEvent({
    type: 'permission',
    turnId,
    requestId: 'p',
    text: 'test tool',
    options: [{ optionId: 'allow' }],
  })
  const interaction = service.snapshot().interactions[0]
  const dropped = act('member.send', { memberId: member.id, text: 'later' })
  const queued = act('member.send', { memberId: member.id, text: 'next' })
  act('queue.edit', { commandId: queued.id, text: 'edited' })
  act('queue.remove', { commandId: dropped.id })
  act('team.stop', { teamId: team.id })
  await until(() => h.calls.some(([kind]) => kind === 'stop'))
  h.onEvent({ type: 'done', status: 'interrupted', turnId })
  assert.throws(
    () => act('interaction.respond', { interactionId: interaction.id, decision: 'allow' }),
    /no longer pending/,
  )
  assert.equal(h.calls.filter(([k]) => k === 'start').length, 1)
  act('team.resume', { teamId: team.id })
  await until(() => h.calls.filter(([k]) => k === 'start').length === 2)
  assert.equal(h.calls.at(-1)[1].text, 'edited')
})

test('member tools constrain recipients and task evidence; dependent tasks wake only after review', async (t) => {
  const { service, act, team, add } = await fixture(t)
  const lead = add('lead'),
    worker = add('writer'),
    reviewer = add('reviewer')
  const other = act('team.create', { name: 'separate', cwd: team.cwd })
  const outsider = act('member.add', { teamId: other.id, name: 'elsewhere', kind: 'dsh' })
  assert.throws(
    () => service.memberTool(worker.id, 'send_message', { to: outsider.id, text: 'cross team' }),
    /does not belong/,
  )
  const task = service.memberTool(lead.id, 'assign_task', {
    to: worker.name,
    title: 'change',
    criteria: 'test',
  })
  const later = act('task.create', {
    teamId: team.id,
    ownerId: reviewer.id,
    title: 'review',
    criteria: 'prove',
    dependsOn: [task.id],
  })
  assert.equal(later.status, 'waiting')
  assert.throws(
    () => service.memberTool(reviewer.id, 'report_result', { taskId: task.id, evidence: 'other' }),
    /assigned member/,
  )
  assert.equal(
    service.memberTool(worker.id, 'report_result', { taskId: task.id, evidence: 'passed test A' }).status,
    'reported',
  )
  assert.equal(service.snapshot().tasks.find((t) => t.id === later.id).status, 'waiting')
  act('task.review', { taskId: task.id, approve: true })
  assert.equal(service.snapshot().tasks.find((t) => t.id === later.id).status, 'assigned')
  const message = act('team.send', { teamId: team.id, text: '@writer and @reviewer please check' })
  assert.deepEqual(message.to, [worker.id, reviewer.id])
})

test('native slash delivery preserves its CLI spelling, validated skill path and queued edits', async (t) => {
  const { service, act, add, handles } = await fixture(t)
  const member = add('artist', 'codex')
  const rows = [
    { name: 'draw', kind: 'skill', insertText: '$draw', skillPath: join(member.cwd, 'SKILL.md') },
    { name: 'exit', kind: 'terminal' },
  ]
  service.slashTarget = async () => ({ member, rows })
  act('member.profile', { memberId: member.id, role: 'artist' })
  await assert.rejects(act('slash.run', { memberId: member.id, name: 'exit' }), /终端/)
  await assert.rejects(act('member.send', { memberId: member.id, text: '/exit' }), /终端/)
  const request = { memberId: member.id, name: 'draw', args: 'a tree', requestId: 'slash-retry' }
  const cmd = await act('slash.run', request)
  assert.equal((await act('slash.run', request)).id, cmd.id)
  const h = await until(() => handles.get(member.id)?.calls.length && handles.get(member.id))
  assert.match(h.calls[0][1].text[0].text, /Role instructions.*artist[\s\S]*\$draw a tree/su)
  assert.deepEqual(h.calls[0][1].text[1], { type: 'skill', name: 'draw', path: rows[0].skillPath })
  const queued = await act('slash.run', { memberId: member.id, name: 'draw', args: 'two' })
  const edited = await act('queue.edit', { commandId: queued.id, text: '$draw three' })
  assert.equal(edited.slash.text, '$draw three')
  assert.equal((await act('queue.edit', { commandId: queued.id, text: 'ordinary message' })).slash, null)
})

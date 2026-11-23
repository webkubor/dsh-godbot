import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'

async function until(read) {
  for (let n = 0; n < 100; n++) {
    const value = read()
    if (value) return value
    await delay(5)
  }
  throw new Error('Expected host transition did not arrive')
}

test('host keeps ownership until native stop, then correlates retry, returned evidence and owner acceptance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-task-integrated-'))
  const handles = new Map()
  const service = new NativeCrewService({
    stateDir: join(dir, 'state'),
    openDriver: async ({ memberId, onEvent }) => {
      const fake = {
        onEvent,
        turns: [],
        stops: [],
        nativeId: memberId,
        capabilities: { interrupt: true },
        start: async (cmd) => {
          fake.turns.push(cmd)
          onEvent({ type: 'started', turnId: cmd.turnId })
        },
        interrupt: async (cmd) => {
          fake.stops.push(cmd)
        },
        close: async () => {},
      }
      handles.set(memberId, fake)
      return fake
    },
  })
  t.after(async () => {
    await service.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await service.ready()
  const act = (action, args) => service.dispatch({ action, ...args })
  const team = act('team.create', { name: 'team', cwd: dir })
  const members = ['lead', 'worker', 'other'].map((name) => {
    const cwd = join(dir, name)
    mkdirSync(cwd)
    return act('member.add', { name, cwd, kind: 'dsh', teamId: team.id })
  })
  const [lead, worker, other] = members
  const task = service.memberTool(lead.id, 'assign_task', {
    to: worker.id,
    title: 'write',
    criteria: 'pass tests',
  })
  const current = () => service.snapshot().tasks.find((t) => t.id === task.id)
  const first = await until(() => handles.get(worker.id)?.turns[0])
  act('task.transfer', { taskId: task.id, ownerId: other.id, expectedRevision: current().revision })
  await until(() => handles.get(worker.id)?.stops.length)
  assert.equal(current().status, 'transferring')
  assert.equal(handles.has(other.id), false)
  handles.get(worker.id).onEvent({ type: 'done', turnId: first.turnId, status: 'interrupted' })
  const second = await until(() => handles.get(other.id)?.turns[0])
  handles.get(other.id).onEvent({ type: 'error', turnId: second.turnId, text: 'test failure' })
  assert.equal(current().failure.kind, 'failed')
  act('task.retry', { taskId: task.id, expectedRevision: current().revision, expectedOwnerId: other.id })
  const third = await until(() => handles.get(other.id)?.turns[1])
  const original = current().assignmentId
  service.memberTool(other.id, 'report_result', {
    taskId: task.id,
    assignmentId: original,
    evidence: 'green: integration',
  })
  handles.get(other.id).onEvent({ type: 'done', turnId: third.turnId, status: 'completed' })
  const leadTurn = await until(() => handles.get(lead.id)?.turns[0])
  handles.get(lead.id).onEvent({ type: 'text', turnId: leadTurn.turnId, text: 'seen' })
  handles.get(lead.id).onEvent({ type: 'done', turnId: leadTurn.turnId, status: 'completed' })
  assert.equal(current().status, 'reported')
  const report = current().reportMessageId
  const accepted = act('task.review', {
    taskId: task.id,
    approve: true,
    expectedRevision: current().revision,
    expectedEvidenceRevision: current().evidenceRevision,
  })
  const messages = service.snapshot().messages
  assert.equal(accepted.status, 'completed')
  assert.equal(messages.find((m) => m.id === report).replyTo, original)
  assert.ok(messages.some((m) => m.replyTo === report && m.kind === 'ack' && m.text === 'seen'))
  assert.equal(messages.find((m) => m.id === accepted.reviewMessageId).replyTo, report)
  assert.equal(handles.get(other.id).turns.length, 2)
})

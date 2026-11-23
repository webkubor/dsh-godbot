import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { NativeCrewService } from '../../src/host/service.js'
import { botWorkspaceId } from '../../src/host/bot-task-workspace.js'

test('CI, webhooks, GitHub events and scheduled workflows dispatch to the registered Bot chat', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'godbot-workspace-automation-'))
  const bot = { id: 'actual-bot', name: 'Reviewer' }
  const room = { id: 'review-room', members: [bot.id], name: 'Reviewers' }
  const deliveries = []
  const runtime = {
    state: { bots: { [bot.id]: bot }, rooms: { [room.id]: room } }, readOnly: () => false,
    chatOf: id => 'current-session/' + id, botOf(id) { return this.state.bots[id] },
    openWork() {}, async deliver(request) { deliveries.push(request) },
  }
  const service = new NativeCrewService({ stateDir, runtime })
  t.after(async () => { await service.close(); await rm(stateDir, { recursive: true, force: true }) })
  const owner = (action, payload) => service.dispatch({ action, teamId: botWorkspaceId, ...payload })
  const api = service.automation
  api.start = async () => 'http://127.0.0.1:0'
  api.github.fetchPage = async () => Response.json([{ id: 'event', type: 'IssuesEvent', payload: { action: 'opened' } }])
  const post = (url, body, headers) => api.handle(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url, method: 'POST', headers,
  }))
  const settings = { title: 'Review this build', criteria: 'Return the build receipt' }
  const grant = await owner('automation.grant', { label: 'runner', scopes: ['run', 'inspect', 'export'] })
  const auth = { authorization: 'Bearer ' + grant.token }
  assert.deepEqual((await owner('automation.list')).targets.map(target => target.id), ['bot/' + bot.id, 'room/' + room.id])
  const ci = await post('/runs', { ...settings, ownerId: bot.name, requestId: 'ci-1' }, auth)
  const repeated = await post('/runs', { ...settings, ownerId: bot.name, requestId: 'ci-1' }, auth)
  assert.equal(repeated.data.runId, ci.data.runId)

  const hook = await owner('automation.hook', { ...settings, ownerId: bot.id, label: 'hook' })
  const event = { sequence: 1 }
  const sig = createHmac('sha256', hook.secret).update('delivery-1\n' + JSON.stringify(event)).digest('hex')
  const hookRun = await post('/hooks/' + hook.id, event, { 'x-godbot-delivery': 'delivery-1', 'x-godbot-signature': sig })
  const github = await owner('automation.githubCreate', { ...settings, ownerId: bot.id, label: 'issues',
    repo: 'example/project', eventType: 'IssuesEvent', includeLatest: true })
  const workflow = owner('workflow.save', { name: 'Build', nodes: [{ id: 'review', ownerId: bot.id, ...settings }], edges: [] })
  const spec = { requestId: randomUUID(), target: 'workflow', title: 'Weekly review', workflowId: workflow.id,
    workflowRevision: 1, schedule: { kind: 'interval', minutes: 60 } }
  const routine = owner('automation.routine.create', spec)
  assert.equal(owner('automation.routine.create', spec).id, routine.id)
  service.routines.runDue(routine.nextAt)
  const scheduled = owner('automation.routine.history', { id: routine.id }).items[0]
  const manual = { requestId: randomUUID(), id: routine.id }
  const triggered = owner('automation.routine.run', manual)
  assert.deepEqual(owner('automation.routine.run', manual), triggered)
  const runIds = [ci.data.runId, hookRun.data.runId, github.lastRunId, scheduled.runId, triggered.runId]
  assert.equal(new Set(runIds).size, 5)
  for (const [index, id] of runIds.entries()) {
    await setImmediate()
    const task = service.store.forRun('tasks', id)[0]
    const delivery = deliveries[index]
    assert.equal(task.ownerId, bot.id)
    assert.equal(delivery.toId, bot.id)
    assert.equal(delivery.sessionId, runtime.chatOf(bot.id))
    assert.equal(delivery.exchangeId, task.assignmentId)
    service.botTasks.botReply(delivery.exchangeId, 'Build evidence ' + index)
  }
  assert.deepEqual(service.database.all('teams'), [])
  assert.deepEqual(service.database.all('members'), [])
  const exportCi = () => api.handle({ url: '/runs/' + ci.data.runId + '/export', method: 'GET', headers: auth })
  assert.equal((await exportCi()).data.reports[0].evidence, 'Build evidence 0')
  bot.private = true
  assert.deepEqual((await owner('automation.list')).targets, [])
  await assert.rejects(exportCi, /no longer accessible/)
})

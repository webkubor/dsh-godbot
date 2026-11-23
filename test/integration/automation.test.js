import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'

const cliFile = new URL('../../bin/godbot.mjs', import.meta.url).pathname
const exec = promisify(execFile)
async function waitFor(read) {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value) return value
    await delay(10)
  }
  throw new Error('Timed out waiting for driver')
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'godbot-ci-'))
  const starts = []
  let service
  async function restart() {
    if (service) await service.close()
    service = new NativeCrewService({
      stateDir: join(dir, 'state'),
      openDriver: async ({ memberId, onEvent }) => ({
        nativeId: memberId,
        capabilities: {},
        close: async () => {},
        start: async (turn) => {
          starts.push({ ...turn, memberId, emit: (e) => onEvent({ turnId: turn.turnId, ...e }) })
        },
      }),
    })
    await service.ready()
  }
  await restart()
  t.after(async () => {
    await service.close()
    await rm(dir, { recursive: true, force: true })
  })
  const act = (action, req = {}) => service.dispatch({ action, ...req })
  const team = act('team.create', { name: 'Developers', cwd: dir })
  const members = []
  for (const name of ['Writer', 'Reviewer', 'Other']) {
    const cwd = join(dir, name)
    await mkdir(cwd)
    members.push(act('member.add', { teamId: team.id, kind: 'dsh', name, cwd }))
  }
  const grant = await act('automation.grant', {
    teamId: team.id,
    label: 'CI',
    scopes: ['run', 'inspect', 'export'],
  })
  const env = { ...process.env, GODBOT_URL: grant.url, GODBOT_TOKEN: grant.token, GODBOT_TOKEN_FILE: '' }
  async function cli(...args) {
    try {
      return { code: 0, data: JSON.parse((await exec(process.execPath, [cliFile, ...args], { env })).stdout) }
    } catch (error) {
      return { code: error.code, data: JSON.parse(error.stdout || error.stderr) }
    }
  }
  const data = () => service.snapshot()
  return { dir, restart, act, data, team, members, grant, cli, env, starts, service: () => service }
}

test('installed command semantics: delegated native tasks stay in one run through return, approval and review', async (t) => {
  const f = await fixture(t)
  const [writer, reviewer] = f.members
  const args = ['run', '--title', 'Report', '--criteria', 'Unique evidence', '--request-id', 'ci-build-123']
  const [first, second] = await Promise.all([f.cli(...args), f.cli(...args)])
  assert.equal(first.code, 0)
  const run = first.data.runId
  assert.equal(second.data.runId, run)
  assert.equal((await f.cli(...args.map((a) => (a === 'Report' ? 'Changed' : a)))).code, 2)
  const unrelated = await f.cli(
    'run',
    '--title',
    'Do not export',
    '--criteria',
    'Other proof',
    '--member',
    'Other',
  )
  assert.notEqual(unrelated.data.runId, run)
  const parentTurn = await waitFor(() => f.starts.find((s) => s.memberId === writer.id))
  const child = f
    .service()
    .memberTool(writer.id, 'assign_task', { to: reviewer.id, title: 'Check', criteria: 'Review proof' })
  const root = f.data().tasks.find((task) => task.runId === run && !task.parentTaskId)
  assert.equal(child.parentTaskId, root.id)
  f.service().memberTool(writer.id, 'report_result', { taskId: root.id, evidence: 'Root result' })
  parentTurn.emit({ type: 'done', status: 'completed' })
  f.act('task.review', { taskId: root.id, approve: true })
  const workerTurn = await waitFor(() => f.starts.find((s) => s.memberId === reviewer.id))
  assert.equal((await f.cli('wait', run, '--timeout', '0')).code, 4)
  workerTurn.emit({ type: 'permission', requestId: 'w1', text: 'Check report?' })
  assert.equal((await f.cli('wait', run)).code, 3)
  const firstEvidence = randomUUID()
  f.service().memberTool(reviewer.id, 'report_result', { taskId: child.id, evidence: firstEvidence })
  workerTurn.emit({ type: 'done', status: 'completed' })
  assert.equal((await f.cli('wait', run)).code, 3)
  f.act('task.review', { taskId: child.id, approve: false, evidence: 'Add the timestamp' })
  const revision = await waitFor(() => f.starts.filter((s) => s.memberId === reviewer.id)[1])
  const latest = randomUUID()
  f.service().memberTool(reviewer.id, 'report_result', {
    taskId: child.id,
    evidence: latest,
    assignmentId: f.data().tasks.find((task) => task.id === child.id).assignmentId,
  })
  revision.emit({ type: 'done', status: 'completed' })
  f.act('task.review', { taskId: child.id, approve: true })
  // The parent also receives reports. Finishing a task alone must not hide those live turns.
  for (let i = 0; i < 2; i++) {
    const response = await waitFor(() => f.starts.filter((s) => s.memberId === writer.id)[i + 1])
    response.emit({ type: 'done', status: 'completed' })
  }
  assert.equal((await f.cli('wait', run)).code, 0)
  const exported = (await f.cli('export', run)).data
  assert.deepEqual(
    exported.tasks.map((t) => t.id),
    [root.id, child.id],
  )
  assert.ok(exported.reports.some((row) => row.evidence === latest && row.revision === 2))
  assert.ok(exported.reports.some((row) => row.evidence === firstEvidence && row.revision === 1))
  assert.ok(!JSON.stringify(exported).includes('Do not export'))
  const mcp = spawn(process.execPath, [cliFile, 'mcp'], { env: f.env })
  const received = []
  mcp.stdout.on('data', (chunk) => received.push(chunk))
  const closed = once(mcp, 'close')
  mcp.stdin.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'inspect', arguments: { runId: run } },
    }) + '\n',
  )
  await closed
  const reply = JSON.parse(Buffer.concat(received).toString())
  assert.equal(JSON.parse(reply.result.content[0].text).state, 'completed')
  await f.act('automation.revoke', { teamId: f.team.id, id: f.grant.id })
  assert.equal((await f.cli('inspect', run)).code, 2)
})

test('installed CLI and MCP share a scoped workflow receipt and wait for returned work beyond the saved graph', async t => {
  const f = await fixture(t)
  const [writer, reviewer] = f.members
  const def = f.act('workflow.save', { teamId: f.team.id, name: 'Review build',
    nodes: [
      { id: 'review', title: 'Review', criteria: 'Quality verdict', ownerId: writer.id },
      { id: 'revise', title: 'Revise', criteria: 'Updated report', ownerId: reviewer.id },
    ], edges: [{ from: 'review', to: 'revise', when: 'contains', value: 'REVISE' }] })
  const prefix = join(f.dir, 'cli-install')
  await exec('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit',
    '--no-fund', '--legacy-peer-deps', '--install-links=false', '--no-save', new URL('../..', import.meta.url).pathname])
  const binary = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'godbot.cmd' : 'godbot')
  const installed = (...args) => exec(binary, args, { env: f.env })
  const callMcp = async (name, args) => {
    const child = spawn(binary, ['mcp'], { env: f.env })
    const output = []
    child.stdout.on('data', bytes => output.push(bytes))
    const closed = once(child, 'close')
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n')
    await closed
    return JSON.parse(Buffer.concat(output)).result
  }
  const id = randomUUID()
  const input = { workflowId: def.id, revision: def.revision, requestId: id }
  const args = ['run', '--workflow', def.id, '--revision', '1', '--request-id', id]
  const [cli, mcp] = await Promise.all([installed(...args), callMcp('run_workflow', input)])
  const submitted = JSON.parse(cli.stdout)
  assert.deepEqual(JSON.parse(mcp.content[0].text), submitted)
  assert.equal(submitted.workflowRevision, 1)
  const runId = submitted.runId
  const view = () => f.act('workflow.list', { teamId: f.team.id }).runs.find(r => r.id === runId)
  const first = await waitFor(() => f.starts.find(s => s.memberId === writer.id))
  const child = f.service().memberTool(writer.id, 'assign_task', { to: reviewer.id, title: 'Collect source', criteria: 'An attributable note' })
  const root = view().nodes.find(n => n.nodeId === 'review').taskId
  f.service().memberTool(writer.id, 'report_result', { taskId: root, evidence: 'ACCEPT' })
  first.emit({ type: 'done', status: 'completed' })
  f.act('task.review', { taskId: root, approve: true })
  assert.equal(view().nodes.find(n => n.nodeId === 'revise').status, 'skipped')
  assert.equal(view().status, 'running')
  await assert.rejects(installed('wait', runId, '--timeout', '0'), e => e.code === 4)
  const work = await waitFor(() => f.starts.find(s => s.memberId === reviewer.id))
  f.service().memberTool(reviewer.id, 'report_result', { taskId: child.id, evidence: 'Build abc123' })
  work.emit({ type: 'done', status: 'completed' })
  assert.equal(view().status, 'needs-review')
  f.act('task.review', { taskId: child.id, approve: true })
  const returned = await waitFor(() => f.starts.filter(s => s.memberId === writer.id)[1])
  assert.equal(view().status, 'running')
  returned.emit({ type: 'done', status: 'completed' })
  const finished = JSON.parse((await installed(...args, '--wait')).stdout)
  assert.equal(finished.state, 'completed')
  assert.equal(view().status, 'completed')
  assert.deepEqual(finished.rootTaskIds, [root])
  assert.equal(finished.tasks.find(task => task.id === child.id).parentTaskId, root)
  const exported = JSON.parse((await callMcp('export', { runId })).content[0].text)
  assert.ok(exported.reports.some(report => report.taskId === child.id && report.evidence === 'Build abc123'))
  assert.equal(exported.workflowId, def.id)
  assert.deepEqual(exported.workflowDefinition, { nodes: def.nodes, edges: def.edges })

  for (const mixed of [['--title', 'extra'], ['--criteria', 'unused'], ['--member', writer.id]])
    await assert.rejects(installed(...args, ...mixed), e => e.code === 2)
  assert.ok((await callMcp('run_workflow', { ...input, title: 'mixed' })).isError)
  assert.ok((await callMcp('run', { ...input, title: 'wrong tool' })).isError)
  await assert.rejects(installed('run', '--title', 'Standalone', '--criteria', 'Proof', '--request-id', id), /different input/)
  const changed = f.act('workflow.save', { ...def, expectedRevision: 1, name: 'New edition', teamId: f.team.id })
  assert.equal(changed.revision, 2)
  assert.equal(JSON.parse((await installed(...args)).stdout).runId, runId)
  await assert.rejects(installed('run', '--workflow', def.id, '--revision', '1', '--request-id', 'different'), /revision changed/)
  assert.equal(view().workflowRevision, 1)

  const other = f.act('team.create', { name: 'Isolated', cwd: f.dir })
  const another = await f.act('automation.grant', { teamId: other.id, label: 'Other', scopes: ['run', 'inspect'] })
  const reader = await f.act('automation.grant', { teamId: f.team.id, label: 'Read only', scopes: ['inspect'] })
  const post = token => fetch(f.grant.url + '/runs', { method: 'POST', headers: { authorization: 'Bearer ' + token },
    body: JSON.stringify({ ...input, revision: 2, requestId: randomUUID() }) })
  assert.equal((await post(another.token)).status, 404)
  assert.equal((await post(reader.token)).status, 403)
  // Stand in for a bound full-team grant; submission must refuse before contacting its runtime.
  f.service().store.update('automationGrants', f.grant.id, { targetId: 'bot/bound' })
  assert.equal((await post(f.grant.token)).status, 403)
  assert.equal(f.act('workflow.list', { teamId: f.team.id }).runs.length, 1)
})

test('saved workflows report a failed provider and an unconfirmed post-acceptance turn across restart', async t => {
  const f = await fixture(t)
  const def = f.act('workflow.save', { teamId: f.team.id, name: 'Validation',
    nodes: [{ id: 'check', ownerId: f.members[0].id, title: 'Check', criteria: 'Tests pass' }], edges: [] })
  const run = (await f.cli('run', '--workflow', def.id, '--revision', '1', '--request-id', 'known')).data.runId
  const first = await waitFor(() => f.starts[0])
  first.emit({ type: 'error', text: 'Driver failed' })
  assert.equal((await f.cli('wait', run)).code, 1)
  const latest = () => f.act('workflow.list', { teamId: f.team.id }).runs[0]
  assert.equal(latest().status, 'blocked')
  const task = f.data().tasks.find(task => task.runId === run)
  f.act('task.retry', { taskId: task.id, expectedRevision: task.revision })
  await waitFor(() => f.starts[1])
  f.service().memberTool(f.members[0].id, 'report_result', { taskId: task.id, evidence: 'Proof before final exit' })
  f.act('task.review', { taskId: task.id, approve: true })
  assert.equal(latest().status, 'running')
  await f.restart()
  assert.equal((await f.cli('wait', run)).code, 5)
  assert.equal(latest().status, 'unknown')
  assert.equal(latest().nodes[0].status, 'completed')
  assert.equal(f.starts.length, 2)
})

test('hook receipt and queue commit together; an uncertain native action stays unknown after restart', async (t) => {
  const f = await fixture(t)
  const hook = await f.act('automation.hook', {
    teamId: f.team.id,
    label: 'Hook',
    ownerId: f.members[0].id,
    title: 'Review build',
    criteria: 'Record build result',
  })
  const body = JSON.stringify({ build: randomUUID() })
  async function deliver(raw = body, id = 'one', key = hook.secret) {
    const sig = createHmac('sha256', key).update(id).update('\n').update(raw).digest('hex')
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: { connection: 'close', 'x-godbot-signature': sig, 'x-godbot-delivery': id },
      body: raw,
    })
    return { status: res.status, data: await res.json() }
  }
  assert.equal((await deliver(body, 'invalid', 'wrong')).status, 401)
  const [a, b] = await Promise.all([deliver(), deliver()])
  assert.equal(a.status, 202)
  assert.deepEqual(a, b)
  assert.equal((await deliver('{}')).status, 409)
  await waitFor(() => f.starts.length)
  await f.restart()
  assert.deepEqual(await deliver(), a)
  assert.equal((await f.cli('wait', a.data.runId)).code, 5)
  assert.equal(f.starts.length, 1)
  await f.act('automation.pauseHook', { teamId: f.team.id, id: hook.id, paused: true })
  assert.equal((await deliver(body, 'two')).status, 404)
  assert.equal(f.data().tasks.length, 1)
})

test('external credentials limit teams and operations, and owner snapshots never return the secret', async (t) => {
  const f = await fixture(t)
  const other = f.act('team.create', { name: 'Separate team', cwd: f.dir })
  f.act('member.add', { teamId: other.id, name: 'Another', cwd: f.dir, kind: 'dsh' })
  const read = await f.act('automation.grant', { teamId: other.id, label: 'Reader', scopes: ['inspect'] })
  const submit = await f.cli(
    'run',
    '--title',
    'Team A only',
    '--criteria',
    'Private evidence',
    '--request-id',
    'stable',
  )
  const base = read.url + '/runs/' + submit.data.runId
  const options = { headers: { authorization: 'Bearer ' + read.token } }
  assert.equal((await fetch(base, options)).status, 404)
  assert.equal((await fetch(base + '/export', options)).status, 403)
  assert.equal((await fetch(read.url + '/runs', { ...options, method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(read.url + '/approvals', { ...options, method: 'POST' })).status, 404)
  const grants = await f.act('automation.list', { teamId: other.id })
  assert.ok(!JSON.stringify(grants).includes(read.token.split('.')[1]))
  assert.ok(!JSON.stringify(f.data()).includes(read.token.split('.')[1]))
})

test('wait bounds a slow status request by its own deadline', async (t) => {
  const { createServer } = await import('node:http')
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    const done = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await done
  })
  const env = {
    ...process.env,
    GODBOT_URL: 'http://127.0.0.1:' + server.address().port,
    GODBOT_TOKEN: 'fixture',
    GODBOT_TOKEN_FILE: '',
  }
  const started = Date.now(),
    id = randomUUID()
  await assert.rejects(
    exec(process.execPath, [cliFile, 'wait', id, '--timeout', '0.3'], { env, timeout: 2500 }),
    (error) => {
      assert.equal(error.code, 4)
      assert.equal(JSON.parse(error.stdout).runId, id)
      return true
    },
  )
  assert.ok(Date.now() - started < 2000)
})

test('an active member cannot attach evidence to another CI run it also owns', async (t) => {
  const f = await fixture(t)
  const runId = (await f.cli('run', '--title', 'Current', '--criteria', 'First')).data.runId
  await waitFor(() => f.starts.length === 1)
  const queued = (await f.cli('run', '--title', 'Queued', '--criteria', 'Second')).data.runId
  const target = f.data().tasks.find((task) => task.runId === queued)
  assert.notEqual(target.runId, runId)
  assert.throws(
    () =>
      f.service().memberTool(f.members[0].id, 'report_result', { taskId: target.id, evidence: 'wrong run' }),
    /different run/,
  )
  assert.equal(f.data().tasks.find((task) => task.id === target.id).evidenceRevision, 0)
  const outside = f.members[2]
  f.act('member.send', { memberId: outside.id, text: 'Independent manual task' })
  await waitFor(() => f.starts.some((turn) => turn.memberId === outside.id))
  assert.throws(
    () => f.service().memberTool(outside.id, 'send_message', {
      to: f.members[0].id, text: 'Unrelated thread', replyTo: target.assignmentId,
    }),
    /another run/,
  )
})

test('an exhausted member defers autonomous handoffs and still receives a manual message', async (t) => {
  const f = await fixture(t),
    [lead, worker] = f.members
  const service = f.service()
  service.budgets.native(
    worker,
    { id: 'prior' },
    { usage: { inputTokens: 1, outputTokens: 0 }, usageId: 'one' },
  )
  service.budgets.configure(worker.id, { dailyTokens: 1, stops: 'unattended' })
  const delegated = service.memberTool(lead.id, 'assign_task', {
    to: worker.id,
    title: 'delegation',
    criteria: 'Review',
  })
  await waitFor(() => f.data().commands.find((c) => c.taskId === delegated.id && c.budgetHold))
  f.act('member.send', { memberId: worker.id, text: 'Manual request' })
  const active = await waitFor(() => f.starts.find((turn) => turn.memberId === worker.id))
  assert.equal(active.text, 'Manual request')
  assert.ok(!f.data().turns.some((turn) => turn.taskId === delegated.id))
})

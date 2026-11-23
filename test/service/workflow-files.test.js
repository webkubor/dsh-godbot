import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { templateAction } from '../../src/host/team-templates.js'
import { Store } from '../../src/host/store.js'
import { BotTaskWorkspace, botWorkspaceId } from '../../src/host/bot-task-workspace.js'
import { mapWorkflow, readWorkflowFile, workflowFile } from '../../src/team/workflow-file.js'

const flow = {
  name: 'Release check',
  nodes: [
    { id: 'source', title: 'Review change', criteria: 'Attach evidence', join: 'all', ownerId: 'old1' },
    { id: 'report', title: 'Write report', criteria: 'Attach report', join: 'any', ownerId: 'old2' },
  ],
  edges: [{ from: 'source', to: 'report', when: 'contains', value: 'APPROVED' }],
}

test('workflow file remaps members without including run evidence, and rejects invalid graphs', () => {
  const file = workflowFile({ ...flow, id: 'private-id', evidence: 'private-evidence' }, [
    { id: 'old1', name: 'Reviewer' }, { id: 'old2', name: 'Writer' }, { id: 'unused', name: 'Other' }])
  const text = JSON.stringify(file)
  for (const privateField of ['old1', 'old2', 'private-evidence', 'private-id', 'Other']) assert.ok(!text.includes(privateField))
  const parsed = readWorkflowFile(text)
  const restored = mapWorkflow(parsed.workflows[0], new Map([['bot-0', 'new1'], ['bot-1', 'new2']]))
  assert.deepEqual(restored.edges, flow.edges)
  assert.deepEqual(restored.nodes.map(n => n.ownerId), ['new1', 'new2'])
  assert.throws(() => mapWorkflow(parsed.workflows[0], new Map()))
  file.workflows[0].edges.push({ from: 'report', to: 'source', when: 'accepted' })
  assert.throws(() => readWorkflowFile(JSON.stringify(file)), /cycle/)
})

test('team templates install runnable public workflows owned by the newly created Bots exactly once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-workflow-file-'))
  const store = new Store(dir)
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  const saved = { ...mapWorkflow(flow, new Map([['old1', 'a'], ['old2', 'b']])), teamId: botWorkspaceId }
  store.put('workflows', { ...saved, id: 'flow' })
  store.put('workflows', { ...saved, id: 'private', name: 'Private flow', nodes: [{ ...flow.nodes[0], ownerId: 'c' }] })
  const rt = {
    state: { bots: { a: { id: 'a', name: 'Reviewer' }, b: { id: 'b', name: 'Writer' }, c: { id: 'c', name: 'Private', private: true } }, rooms: {} },
    botOf(id) { return this.state.bots[id] }, chatOf: id => id,
    expandCapabilities: () => [], scheduleEndpoint: async () => ({ tasks: [] }), readOnly: () => false,
    async ensureWorkspace() {}, async save() {},
    async importNativeCrewMember({ origin, name, reservation }) {
      const bot = { id: reservation.id, name, godbotOrigin: origin }
      this.state.bots[bot.id] = bot
      return bot
    },
  }
  const service = new BotTaskWorkspace(store, rt)
  const call = (action, args) => templateAction(rt, service, { action: 'team-workspace.template' + action, ...args })
  const first = await call('Export')
  const parsed = readWorkflowFile(JSON.stringify(first))
  assert.equal(parsed.workflows.length, 1)
  assert.deepEqual(parsed.workflows[0].edges, flow.edges)
  rt.state.bots = {}
  const requestId = randomUUID()
  const imported = await call('Import', { template: first, requestId })
  assert.deepEqual(await call('Import', { template: first, requestId }), imported)
  assert.equal(Object.keys(rt.state.bots).length, 2)
  assert.equal(imported.workflows.length, 1)
  const installed = store.require('workflows', imported.workflows[0])
  assert.equal(installed.teamId, botWorkspaceId)
  assert.deepEqual(installed.nodes.map(node => node.ownerId), Object.values(imported.mapping))
  assert.equal(installed.revision, 1)
  assert.equal(store.all('workflows').length, 3)
  assert.deepEqual(store.all('members'), [])
  assert.deepEqual((await call('Export')).workflows, first.workflows)
  rt.state.bots[imported.mapping['bot-0']].private = true
  assert.equal((await call('Export')).workflows, undefined)
  assert.deepEqual(store.all('workflowRuns'), [])
})

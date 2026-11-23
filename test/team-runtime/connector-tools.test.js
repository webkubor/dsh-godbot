import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectorTools, connectorSchema } from '../../src/host/team-runtime/connector-tools.js'
import { WorkspaceAgentAdapter } from '../../src/host/team-runtime/local-agents.js'

test('connector declarations preserve nested optionals, property names and local refs without weakening unrepresentable constraints', () => {
  const ref = { type: 'object', required: ['const'], properties: { const: { $ref: '#/definitions/option' } },
    definitions: { option: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, optional: { const: 'a' } } } } }
  const expanded = JSON.parse(JSON.stringify(connectorSchema(ref)))
  assert.deepEqual(expanded.properties.const.required, ['id'])
  assert.deepEqual(expanded.properties.const.properties.optional, { enum: ['a'] })
  assert.deepEqual(JSON.parse(JSON.stringify(connectorSchema({ type:'object', dependencies:{
    ifPresent:{ $ref:'#/definitions/rule' }, names:['requiredName'] }, definitions:{ rule:{ required:['expected'] } },
  }))).dependencies, { ifPresent:{ required:['expected'] }, names:['requiredName'] })
  assert.throws(() => connectorSchema({ ...ref, properties: { input: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }), /anyOf/)
  assert.throws(() => connectorSchema({ ...ref, properties: { input: { $ref: '#/properties/input' } } }), /递归/)
})

test('a session bridge checks the granted registration again on list, call and after pending approval', async t => {
  const sessionId = 'a-session'
  const agent = { session: { id: sessionId } }
  const scoped = new Map()
  const rt = {
    ctx: { tools: { get: name => scoped.get(name) }, get: () => ({ get: () => agent }) },
    connectorsInternals: { mounts: new Map([['work', { fiber: {} }]]), statuses: new Map() },
    selfOf: id => id === sessionId ? 'a-bot' : undefined, isBotSession: id => id === sessionId, botOf: id => id === 'a-bot',
    state: { connectors: { work: { offFor: [], account: 'first' } } },
  }
  const catalog = rt.connectorTools = new ConnectorTools(rt)
  const registry = { register(def) { scoped.set(def.name, def); return () => scoped.delete(def.name) } }
  const name = 'mcp__work__read'
  const offered = { name, description: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false } }
  let executed = 0
  catalog.register('work', registry, { ...offered, execute: async () => ++executed })
  const options = { sessionId, tools: [offered, { name: 'mcp__work__other' }, { name: 'bash' }] }
  const noted = []
  const live = { state: 'running', sessionId, route: 'local-codex-cli', pending: new Map(), push: event => noted.push(event) }
  const adapter = new WorkspaceAgentAdapter({ rt })
  const bridge = await adapter.ensureMcp(live, () => catalog.forStep(options, new Set()))
  t.after(() => bridge.close())
  function list() { return bridge.answer({ id: 1, method: 'tools/list' }).result.tools.map(tool => tool.name) }
  assert.deepEqual(list(), [name])
  const call = bridge.onCall({ name, arguments: {}, callId: 'pending' })
  assert.equal(noted.length, 1)
  const exec = { name, callId: noted[0].dshCallId, agent }
  assert.equal(catalog.denyPending(exec), undefined)
  rt.state.connectors.work.offFor = ['a-bot']
  assert.deepEqual(list(), [])
  assert.ok(catalog.denyPending(exec))
  assert.ok((await bridge.onCall({ name, callId: 'revoked' })).isError)
  await assert.rejects(scoped.get(name).execute({}, exec), /授权/)
  assert.equal(executed, 0)
  rt.state.connectors.work.offFor = []
  rt.state.connectors.work.account = 'other'
  assert.deepEqual(list(), [])
  rt.state.connectors.work.account = 'first'
  await scoped.get(name).execute({}, exec)
  assert.equal(executed, 1)
  live.pending.get(exec.callId).resolve({ text: 'reply' })
  assert.equal((await call).text, 'reply')
  assert.equal(catalog.calls.size, 0)
  scoped.set(name, { ...scoped.get(name) })
  assert.deepEqual(list(), [])
})

test('the memory keeper and other tagged NativeCrew requests keep a round catalog and its call receipts', () => {
  const cli = 'cli-session', dsh = 'dsh-session'
  const tagged = new WeakSet()
  const rt = {
    isBotSession: id => id === cli || id === dsh,
    ownRequest: options => tagged.has(options.messages),
    isLocalAgentRoute: route => route === 'local-codex-cli',
  }
  const catalog = new ConnectorTools(rt)
  const registry = { register: () => () => {} }
  const name = 'mcp__work__read'
  catalog.register('work', registry, { name, description: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' })
  const read = (sessionId, callId) => {
    catalog.event(sessionId, { type: 'tool/call', data: { name, callId } })
    catalog.event(sessionId, { type: 'tool/result', time: 1, data: { message: { toolCallId: callId, isError: false } } })
  }
  // The keeper names the Bot's Session and uses a DSH model even for a CLI member.
  const keeper = sessionId => {
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'New in its own chat' }] }]
    tagged.add(messages)
    return { provider: 'deepseek-official', model: 'deepseek-flash', sessionId, messages }
  }

  // A CLI member lists its tools through the MCP bridge, calls one, and the keeper runs after the turn.
  catalog.listed(cli, 'local-codex-cli', [{ name }])
  read(cli, 'cli-call')
  catalog.step(keeper(cli))
  assert.equal(catalog.observed.get(cli).route, 'local-codex-cli')
  assert.deepEqual(catalog.observed.get(cli).names, [name])
  assert.equal(catalog.observed.get(cli).results.get(name)?.callId, 'cli-call')

  // A DSH member's own round lists its tools; the keeper's request on the same route leaves them.
  catalog.step({ provider: 'deepseek-official', sessionId: dsh, messages: [], tools: [{ name }, { name: 'bash' }] })
  read(dsh, 'dsh-call')
  catalog.step(keeper(dsh))
  assert.deepEqual(catalog.observed.get(dsh).names, [name])
  assert.equal(catalog.observed.get(dsh).results.get(name)?.callId, 'dsh-call')

  // Purposeful calls and CLI routes stay out; the member's next untagged round replaces its catalog.
  catalog.step({ provider: 'deepseek-official', sessionId: dsh, purpose: 'compaction', messages: [] })
  catalog.step({ provider: 'local-codex-cli', sessionId: dsh, messages: [], tools: [] })
  assert.deepEqual(catalog.observed.get(dsh).names, [name])
  catalog.step({ provider: 'deepseek-official', sessionId: dsh, messages: [], tools: [] })
  assert.deepEqual(catalog.observed.get(dsh).names, [])
})

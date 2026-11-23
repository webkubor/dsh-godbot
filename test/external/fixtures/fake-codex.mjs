// Modified for NativeCrew to emit questions and asynchronous interrupted outcomes. See THIRD_PARTY_NOTICES.
// A fake Codex app-server for tests: `codex app-server --listen stdio://`
// dialect, newline JSON-RPC. The turn's first text picks the behavior:
//   "ask"      -> an approval request the client must answer
//   "elicit <server> <kind>" -> an MCP tool-call approval (mcpServer/elicitation/request)
//                 from <server>, with _meta.codex_approval_kind <kind>; the answer
//                 comes back as the agentMessage, as JSON
//   "late-elicit <server> <kind>" -> the same request, sent before the turn completes:
//                 the answer then arrives after the turn already ended
//   "late-ask" -> an approval request whose answer likewise arrives after the turn ended
//   "hold-ask" -> an approval request that keeps its turn alive, so the answer steers it
//   otherwise  -> an activity item, an agentMessage, thread/tokenUsage/updated,
//                 turn/completed
// thread/compact/start condenses in a turn of its own. Usage and compaction take the
// shapes Codex 0.166 sends (test/fixtures/recorded/codex-app-server-0.166.json).
// `--exit-after-turn` exits once a turn completes, and `--text-only` sends no
// activity items first: a test can then tell whether the one text event reached
// the client. `--record <file>` appends the params of thread/start and thread/resume,
// so a test can check the shape the client sent without a model call.
import { appendFileSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const exitAfterTurn = process.argv.includes('--exit-after-turn')
const textOnly = process.argv.includes('--text-only')
const holdCompact = process.argv.includes('--hold-compact')
const recordAt = process.argv.indexOf('--record')
const recordPath = recordAt === -1 ? undefined : process.argv[recordAt + 1]
const record = (method, params) => {
  if (recordPath !== undefined) appendFileSync(recordPath, `${JSON.stringify({ method, params })}\n`)
}
// The fields Codex 0.166's app-server takes on thread/start and thread/resume
// (from `codex app-server generate-json-schema`). The real server drops any
// other field without a word, so the fake refuses it instead.
const THREAD_START = ['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd', 'developerInstructions', 'ephemeral', 'model', 'modelProvider', 'personality', 'sandbox', 'serviceName', 'serviceTier', 'sessionStartSource', 'threadSource']
const THREAD_RESUME = ['approvalPolicy', 'approvalsReviewer', 'baseInstructions', 'config', 'cwd', 'developerInstructions', 'excludeTurns', 'model', 'modelProvider', 'personality', 'sandbox', 'serviceTier', 'threadId']
const unknownField = (params, known) => {
  const extra = Object.keys(params ?? {}).filter(key => !known.includes(key))
  return extra.length === 0 ? undefined : `unknown field ${extra.join(', ')}`
}
const threads = new Map()
let nextId = 0
const requests = new Map()

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const replyError = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32602, message } })
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32601, message } })
const notice = (method, params) => send({ jsonrpc: '2.0', method, params })
const ask = (method, params) => new Promise((resolve) => {
  const id = `srv-${++nextId}`
  requests.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})

// The shape Codex sends before an MCP tool call when approval_policy is on-request.
async function elicitTurn(thread, turnId, text) {
  const [, serverName, kind, toolName] = text.match(/elicit (\S+) (\S+)(?: (\S+))?/)
  const answer = await ask('mcpServer/elicitation/request', {
    threadId: thread.id, turnId, serverName, mode: 'form',
    message: 'Allow the godbot MCP server to run tool "list_bots"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: kind, tool_name: toolName ?? 'list_bots' },
  })
  const shown = answer.error !== undefined ? { error: answer.error.code } : answer.result
  notice('item/completed', { threadId: thread.id, turnId, item: { id: 'i1', type: 'agentMessage', text: JSON.stringify(shown) } })
  thread.turn = undefined
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
}

async function delegate({ rpc }, bridge, [, agent, requestId, to]) {
  const result = await rpc(bridge, 'tools/call', { name: 'message_bot', arguments: {
    to, message: `GODBOT-${agent}-EXECUTION-TRACE ${requestId}`, reply_to: 'me', when: 'queue', request_id: requestId,
  } })
  return (result.isError ? 'FIXTURE_ERROR ' : '') + result.content.map(block => block.text).join('\n')
}

function runTurn(thread, turnId, text, effort, images = []) {
  const delegation = text.match(/GODBOT-CODEX-DELEGATE (CLAUDE|CODEX|ACP) ([a-f\d-]+) ([^\r\n]+)/u)
  if (process.env.GODBOT_E2E_GATE_DIR && (delegation || text.includes('GODBOT-TICKET '))) {
    const bridge = thread.params.config.mcp_servers.godbot
    void import('../../e2e/fixtures/ticket-client.mjs').then(helper =>
      delegation ? delegate(helper, bridge, delegation) : helper.exerciseTicket(bridge, text))
      .catch(err => 'FIXTURE_ERROR ' + err.message).then(reply => {
        notice('item/completed', { threadId: thread.id, turnId, item: { id: delegation ? 'delegation' : 'ticket', type: 'agentMessage', text: reply } })
        thread.turn = undefined
        notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
      })
    return
  }
  const dir = process.env.GODBOT_E2E_GATE_DIR
  const trace = dir && text.match(/GODBOT-CODEX-EXECUTION-TRACE ([a-f\d-]+)/u)
  if (trace) {
    const emit = (method, payload) => notice(method, { threadId: thread.id, turnId, ...payload })
    const textItem = (id, text) => {
      emit('item/agentMessage/delta', { itemId: id, delta: text })
      emit('item/completed', { item: { id, type: 'agentMessage', text } })
    }
    textItem('trace-before', 'Codex fixture progress before the command.')
    const item = { id: 'trace-command', type: 'commandExecution', command: 'cat fixture-trace.txt', cwd: thread.params.cwd,
      commandActions: [{ type: 'read', path: 'fixture-trace.txt' }] }
    emit('item/started', { item: { ...item, status: 'inProgress' } })
    textItem('trace-during', 'Codex fixture progress while the command runs.')
    void (async () => {
      while (!existsSync(join(dir, 'codex-execution-trace-release'))) await delay(60)
      emit('item/commandExecution/outputDelta', { itemId: item.id, delta: 'Codex fixture ' })
      emit('item/commandExecution/outputDelta', { itemId: item.id, delta: 'command output' })
      emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0, durationMs: 250 } })
      const report = 'TRACE_COMPLETE ' + trace[1] + '\n\n## Fixture verification report\n\nTool results and final checks are included.'
      emit('item/completed', { item: { id: 'trace-result', type: 'agentMessage', text: report } })
      thread.turn = undefined
      notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    })()
    return
  }
  if (/elicit \S+ \S+/.test(text)) return void elicitTurn(thread, turnId, text)
  // An approval request whose turn stays alive: an answer has to steer this turn.
  if (text.includes('late-double')) {
    for (let i = 0; i < 2; i++) void ask('item/commandExecution/requestApproval', { threadId: thread.id, turnId, reason: `Action ${i}`, availableDecisions: ['accept', 'decline'] })
    thread.turn = undefined
    notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    return
  }
  if (text.includes('ordinary-approval')) {
    void ask('item/commandExecution/requestApproval',{threadId:thread.id,turnId,command:'pwd'}).then(answer => {
      notice('item/completed',{threadId:thread.id,turnId,item:{id:'decision',type:'agentMessage',text:JSON.stringify(answer)}})
      notice('turn/completed',{threadId:thread.id,turn:{id:turnId,status:'completed'}})
    })
    return
  }
  if (text.includes('request-escalations')) {
    void Promise.all(['item/fileChange/requestApproval','item/commandExecution/requestApproval','item/permissions/requestApproval'].map(method=>ask(method,{threadId:thread.id,turnId}))).then(answers => {
      notice('item/completed',{threadId:thread.id,turnId,item:{id:'decisions',type:'agentMessage',text:JSON.stringify(answers)}})
      notice('turn/completed',{threadId:thread.id,turn:{id:turnId,status:'completed'}})
    })
    return
  }
  if (text.includes('answer-question')) {
    void ask('item/tool/requestUserInput', {threadId: thread.id, turnId, questions: [{id:'choice',question:'Choose a fruit'}]}).then(result => {
      notice('item/completed', {threadId:thread.id,turnId,item:{type:'agentMessage',id:'answer',text:JSON.stringify(result)}})
      notice('turn/completed', {threadId:thread.id,turn:{id:turnId,status:'completed'}})
    })
    return
  }
  if (text.includes('hold-ask')) {
    void ask('item/commandExecution/requestApproval', { threadId: thread.id, turnId, reason: 'hold approval', availableDecisions: ['accept', 'decline'] })
    return
  }
  // The turn ends while the request is still open: the answer comes late.
  if (text.includes('late-ask')) {
    void ask('item/commandExecution/requestApproval', { threadId: thread.id, turnId, reason: 'late approval', availableDecisions: ['accept', 'decline'] })
    thread.turn = undefined
    notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    return
  }
  if (/late-elicit \S+ \S+/.test(text)) {
    void elicitTurn(thread, turnId, text.replace(/^late-/, ''))
    thread.turn = undefined
    notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    return
  }
  // What the thread was opened with, for a test that checks the fields.
  // A turn that stays open until a steer lands on it.
  if (text.includes('hold')) return
  if (text.includes('show-thread')) {
    notice('item/completed', { threadId: thread.id, turnId, item: { id: 'i2', type: 'agentMessage', text: JSON.stringify(thread.params ?? {}) } })
    notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
    return
  }
  if (!textOnly) {
    notice('item/started', { threadId: thread.id, turnId, item: { id: 'i1', type: 'commandExecution', command: 'ls' } })
    const failure = text.includes('raw-shell-receipts')
    notice('item/completed', { threadId: thread.id, turnId, item: { id: 'i1', type: 'commandExecution', status: 'completed',
      exitCode: failure ? 8 : 0, ...(failure ? { aggregatedOutput: 'fixture command output' } : {}) } })
  }
  const suffix = images.length > 0 ? ` images=${JSON.stringify(images)}` : ''
  notice('item/completed', { threadId: thread.id, turnId, item: { id: 'i2', type: 'agentMessage', text: `ok: ${text.slice(0, 60)} effort=${effort ?? 'none'}${suffix}` } })
  thread.used = (thread.used ?? 25_000) + 800 + Number(text.match(/grow:(\d+)/)?.[1] ?? 0)
  usage(thread, turnId, { totalTokens: thread.used, inputTokens: thread.used - 6, cachedInputTokens: 12_288, cacheWriteInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 })
  thread.turn = undefined
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
  if (exitAfterTurn) setTimeout(() => process.exit(0), 50)
}

const ZERO = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
function usage(thread, turnId, last) {
  const total = thread.total ?? ZERO
  thread.total = Object.fromEntries(Object.keys(ZERO).map(key => [key, total[key] + last[key]]))
  notice('thread/tokenUsage/updated', { threadId: thread.id, turnId, tokenUsage: { total: thread.total, last, modelContextWindow: 475_000 } })
}

function compactTurn(thread) {
  const turnId = `turn-${++nextId}`
  notice('turn/started', { threadId: thread.id, turn: { id: turnId, status: 'inProgress' } })
  notice('item/started', { threadId: thread.id, turnId, item: { type: 'contextCompaction', id: 'cc1' } })
  thread.used = 29_000
  usage(thread, turnId, { ...ZERO, totalTokens: thread.used })
  notice('item/completed', { threadId: thread.id, turnId, item: { type: 'contextCompaction', id: 'cc1' } })
  notice('turn/completed', { threadId: thread.id, turn: { id: turnId, status: 'completed' } })
}

let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      requests.get(message.id)?.(message)
      requests.delete(message.id)
      continue
    }
    const { id, method, params = {} } = message
    switch (method) {
      case 'initialize': reply(id, { userAgent: 'fake-codex' }); break
      case 'initialized': break
      case 'mcpServerStatus/list': {
        const configured = threads.get(params.threadId)?.params.config?.mcp_servers?.godbot
        const scoped = configured?.url ? [{
          name: 'godbot', httpOrigin: new URL(configured.url).origin, runtimeStatus: 'connected',
          tools: Object.fromEntries((configured.enabled_tools ?? []).map(name => [name, { name }])),
        }] : []
        if (scoped[0] && process.env.GODBOT_TEST_MCP_REPORT === 'different-origin') scoped[0].httpOrigin = 'http://127.0.0.1:1'
        if (scoped[0] && process.env.GODBOT_TEST_MCP_REPORT === 'extra-tool') scoped[0].tools.assign_task = {}
        if (process.env.GODBOT_TEST_MCP_REPORT === 'absent') scoped.length = 0
        reply(id, { data: params.threadId ? scoped : [{ name: 'outside', tools: {} }], nextCursor: null })
        break
      }
      case 'collaborationMode/list':
        reply(id,{data:[{mode:'default',name:'Default'},{mode:'plan',name:'Plan'}]});break
      case 'thread/unsubscribe': reply(id,{status:'unsubscribed'});break
      case 'thread/settings/update': {
        reply(id,{})
        if (params.model && params.model!=='gpt-5.1-codex' && params.model!=='gpt-next') break
        const thread=threads.get(params.threadId)
        thread.model=params.model ?? params.collaborationMode?.settings.model ?? thread.model ?? 'gpt-5.1-codex'
        thread.effort=params.collaborationMode ? params.collaborationMode.settings.reasoning_effort : params.effort ?? thread.effort ?? 'high'
        thread.mode=params.collaborationMode?.mode ?? thread.mode ?? 'default'
        setTimeout(()=>notice('thread/settings/updated',{threadId:params.threadId,threadSettings:{model:thread.model,effort:thread.effort,collaborationMode:{mode:thread.mode}}}),30)
        break
      }
      case 'model/list':
        reply(id, {
          data: [{
            id: 'gpt-5.1-codex',
            displayName: 'GPT-5.1 Codex',
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast responses' },
              { reasoningEffort: 'medium', description: 'Balanced speed and depth' },
              { reasoningEffort: 'high', description: 'Deep reasoning' },
            ],
          },{id:'gpt-next',displayName:'Next',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'max'}]}],
        })
        break
      case 'thread/start': {
        record('thread/start', params)
        const extra = unknownField(params, THREAD_START)
        if (extra !== undefined) { replyError(id, extra); break }
        const thread = { id: process.env.GODBOT_E2E_GATE_DIR ? randomUUID() : `thr-${++nextId}`, params }
        threads.set(thread.id, thread)
        reply(id, { thread: { id: thread.id },sandbox:{type:params.sandbox === 'read-only'?'readOnly':'workspaceWrite'},approvalPolicy:params.approvalPolicy,model:params.model ?? 'gpt-5.1-codex', reasoningEffort:params.model==='gpt-next'?'low':'high' })
        break
      }
      case 'thread/resume': {
        record('thread/resume', params)
        if (params.threadId === 'missing') { replyError(id, 'thread missing'); break }
        const extra = unknownField(params, THREAD_RESUME)
        if (extra !== undefined) { replyError(id, extra); break }
        const thread = threads.get(params.threadId) ?? { id: params.threadId }
        thread.params = params
        threads.set(thread.id, thread)
        reply(id, { thread: { id: params.threadId },sandbox:{type:params.sandbox === 'read-only'?'readOnly':'workspaceWrite'},approvalPolicy:params.approvalPolicy,model:params.model ?? 'gpt-5.1-codex', reasoningEffort:params.model==='gpt-next'?'low':'high' })
        break
      }
      case 'config/read':
        record('config/read', params)
        reply(id, { config: { developer_instructions: process.env.FAKE_CODEX_DEVELOPER_INSTRUCTIONS ?? null } })
        break
      case 'thread/inject_items': record('thread/inject_items', params); reply(id, {}); break
      case 'turn/start': {
        record('turn/start', params)
        const input = params.input ?? []
        const badImage = input.find(item => item.type === 'image' && typeof item.url !== 'string' && typeof item.fileId !== 'string')
        if (badImage !== undefined) { replyError(id, 'Invalid image input: missing url or fileId'); break }
        const images = input.filter(item => item.type === 'image').map(item => ({ type: item.type, url: item.url }))
        const thread = threads.get(params.threadId)
        const turnId = `turn-${++nextId}`
        if (thread !== undefined) thread.turn = turnId
        reply(id, { turn: { id: turnId } })
        const text = input.filter(item => item.type === 'text').map(item => item.text ?? '').join('\n')
        setImmediate(() => runTurn(thread ?? { id: params.threadId }, turnId, text, params.effort, images))
        break
      }
      case 'thread/compact/start': {
        reply(id, {})
        if (holdCompact) break
        const thread = threads.get(params.threadId) ?? { id: params.threadId }
        threads.set(thread.id, thread)
        setImmediate(() => compactTurn(thread))
        break
      }
      case 'turn/interrupt': {
        reply(id, {})
        const {threadId, turnId} = params
        setTimeout(() => notice('turn/completed', {threadId, turn: {id:turnId,status:'interrupted'}}), 80)
        break
      }
      case 'turn/steer': {
        // Codex's schema requires the turn being steered; a steer after that turn
        // ended is refused, which is what the adapter must recover from.
        record('turn/steer', params)
        const thread = threads.get(params.threadId)
        if (typeof params.expectedTurnId !== 'string') { replyError(id, 'missing field expectedTurnId'); break }
        if (thread?.turn === undefined || thread.turn !== params.expectedTurnId) { replyError(id, `no live turn ${params.expectedTurnId}`); break }
        const text = (params.input ?? []).map(item => item.text ?? '').join('\n')
        // A late notice for an earlier turn: the turn this thread runs now stays live.
        if (text.startsWith('emit-stale ')) {
          notice('turn/completed', { threadId: thread.id, turn: { id: text.slice('emit-stale '.length), status: 'completed' } })
          reply(id, {})
          break
        }
        // A steer can be refused while the turn ends at the same moment: the client
        // must recover by starting a turn of its own.
        if (text === 'race') {
          replyError(id, `no live turn ${params.expectedTurnId}`)
          thread.turn = undefined
          notice('turn/completed', { threadId: thread.id, turn: { id: params.expectedTurnId, status: 'completed' } })
          break
        }
        notice('item/completed', { threadId: thread.id, turnId: params.expectedTurnId, item: { id: 'steer', type: 'agentMessage', text: `steered: ${text}` } })
        reply(id, {})
        break
      }
      default: if (id !== undefined) fail(id, `method not found: ${method}`)
    }
  }
})

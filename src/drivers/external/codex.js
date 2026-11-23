// Modified for Godbot. See THIRD_PARTY_NOTICES.
// The Codex app-server engine: `codex app-server --listen stdio://`, one
// JSON-RPC process per route that multiplexes threads. NativeCrew Sessions map to
// threads; turns stream item notifications back.
import { effortOptions, requireEffort } from './effort.js'
import { JsonRpcPeer, wireProcess, EventQueue, newCallId } from './jsonrpc.js'
import { cleanEnv, findEngineExecutable, spawnAgent, terminateChild } from './discover.js'
import { toolStatusWithExitCode } from './tool-results.js'

// The name the loopback MCP server is registered under in each thread's config.
const MCP_SERVER = 'godbot'
const READ_ONLY_TEAM_TOOLS = ['list_members', 'list_tasks', 'send_message', 'report_result']
const MCP_APPROVAL = 'mcp_tool_call'

export function codexInputModalities(input) {
  if (!Array.isArray(input)) return undefined
  const modalities = input.filter(kind => kind === 'text' || kind === 'image' || kind === 'audio')
  return modalities.length > 0 ? modalities : undefined
}

// The team adapter and the direct driver use the same app-server request/notice contract.
// Manual compaction acknowledges with {}, so only its own contextCompaction item can
// identify the native turn. Inline review can also announce an internal turn/started
// with a different id from the review RPC and the final turn/completed.
export function consumeCodexCommandNotice(engine, method, params) {
  const thread = [...engine.threads.values()].find(t => t.threadId === params?.threadId)
  const op = thread?.slashOperation
  if (!op) return false
  const item = params.item
  if (op.started && item?.type === 'contextCompaction' && params.turnId &&
      (method === 'item/started' || method === 'item/completed') && params.turnId !== op.previous) {
    op.id = params.turnId
    op.started.resolve(op.id)
  }
  if (op.name === 'review') {
    if ((item?.type === 'enteredReviewMode' || item?.type === 'exitedReviewMode') &&
        params.turnId && params.turnId !== op.previous) op.id ??= params.turnId
    if (method === 'turn/started' && params.turn?.id !== op.id) return true
    if (params.turnId === op.id && method === 'item/completed' && item?.type === 'exitedReviewMode')
      op.review = item.review
    if (params.turnId === op.id && method === 'item/completed' && item?.type === 'agentMessage' && item.text)
      op.lastMessage = item.text
    // Render the official review once; Codex can emit the same verdict again as an agentMessage.
    if (params.turnId === op.id && (method === 'item/agentMessage/delta' ||
        ((method === 'item/started' || method === 'item/completed') && item?.type === 'agentMessage'))) return true
  }
  if (method === 'turn/completed' && op.id && params.turn?.id === op.id) {
    if (op.name === 'review' && (op.review || op.lastMessage))
      thread.push({ type: 'text', turnId: op.id, text: op.review || op.lastMessage })
    if (op.name === 'compact' && params.turn.status === 'completed')
      thread.push({ type: 'text', turnId: op.id, text: 'Codex 已完成当前会话的上下文压缩。' })
    delete thread.slashOperation
  }
  return false
}

async function startCodexCommand(peer, thread, command, signal) {
  if (thread.turnId || thread.slashOperation) throw new Error('请等待当前 Codex 回合结束后再执行命令。')
  const { threadId } = thread
  const { name, args = '' } = command
  if (name !== 'compact' && name !== 'review') throw new Error('Unknown native Codex command')
  if (typeof args !== 'string' || (name === 'compact' && args.trim()))
    throw new Error('/compact 不接收参数。')
  const op = thread.slashOperation = { name, previous:thread.completedTurnId }
  let timer
  let abort
  try {
    if (name === 'review') {
      const target = args.trim() ? {type:'custom', instructions:args.trim()} : {type:'uncommittedChanges'}
      const result = await peer.request('review/start', {threadId, target, delivery:'inline'}, {signal, timeout:30_000})
      if (!result?.turn?.id || result.reviewThreadId !== threadId || (op.id && op.id !== result.turn.id))
        throw Object.assign(new Error('Codex did not confirm the inline review turn'), {deliveryUnknown:true})
      op.id = result.turn.id
    } else {
      if (!thread.completedTurnId) {
        // The CLI acknowledges an empty compaction but may never complete it.
        const history = await peer.request('thread/read', {threadId, includeTurns:true}, {signal, timeout:15_000})
          .catch(error => {
            if (/not (?:yet )?materialized|before (?:the )?first user message|no rollout|ephemeral threads do not support includeTurns/i.test(error.message))
              return null
            throw error
          })
        if (!history?.thread?.turns?.some(turn => turn.items?.length))
          throw new Error('当前 Codex 会话还没有可压缩的历史。')
      }
      op.started = Promise.withResolvers()
      thread.pendingCompaction = true
      abort = () => op.started.reject(signal?.reason ?? new Error('Codex compact cancelled'))
      signal?.addEventListener('abort', abort, {once:true})
      timer = setTimeout(() => op.started.reject(Object.assign(new Error('Codex did not report its compaction turn'), {deliveryUnknown:true})), 30_000)
      await Promise.all([peer.request('thread/compact/start', {threadId}, {signal, timeout:30_000}), op.started.promise])
    }
    thread.turnId = thread.completedTurnId === op.id ? undefined : op.id
    return op.id
  } catch (error) {
    if (thread.slashOperation === op) delete thread.slashOperation
    if (name === 'compact') {
      thread.pendingCompaction = false
      thread.compactionCancel?.resolve()
      thread.compactionCancel = undefined
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

async function serverCatalog(peer, threadId) {
  const all = []
  let cursor
  const seen = new Set()
  do {
    if (seen.has(cursor)) throw new Error('Codex returned a repeating MCP catalog cursor')
    seen.add(cursor)
    const page = await peer.request('mcpServerStatus/list', {threadId, cursor, limit:100, detail:'toolsAndAuthOnly'}, {timeout:30_000})
    if (!Array.isArray(page?.data)) throw new Error('Codex could not verify MCP isolation')
    all.push(...page.data)
    cursor = page.nextCursor
  } while (cursor)
  return all
}

async function verifyReadOnly(peer, reply, mcp) {
  if (reply?.sandbox?.type !== 'readOnly' || reply.approvalPolicy !== 'never') {
    throw new Error('Codex did not confirm a read-only sandbox with approvals disabled')
  }
  const servers = await serverCatalog(peer, reply.thread.id)
  let teamVerified = false
  for (const server of servers) {
    if (server.runtimeStatus === 'disabled' && Object.keys(server.tools ?? {}).length === 0) continue
    if (!mcp || server.name !== MCP_SERVER) throw new Error('Unexpected MCP server exposed in a read-only workspace: ' + server.name + ' (state=' + server.runtimeStatus + ', tools=' + Object.keys(server.tools ?? {}).length + ')')
    if (server.httpOrigin !== new URL(mcp.url).origin || server.runtimeStatus !== 'connected') {
      throw new Error('Codex did not confirm the authenticated loopback team endpoint')
    }
    const names = Object.keys(server.tools ?? {})
    if (names.some(name => !READ_ONLY_TEAM_TOOLS.includes(name))) {
      // Some Codex builds list the raw peer catalog here before filtering the
      // model-visible tools: bind the server to a scoped host catalog as well.
      throw new Error('Unrestricted team tool catalog in read-only workspace')
    }
    teamVerified = READ_ONLY_TEAM_TOOLS.every(name => names.includes(name))
  }
  if (mcp && !teamVerified) throw new Error('Codex did not confirm the four scoped read-only team tools')
}

export class CodexEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    this.threads = new Map()
  }

  threadFor(dshSessionId) {
    let thread = this.threads.get(dshSessionId)
    // A thread whose process exited keeps its queue and, with it, the pump
    // still waiting there: a resumed thread needs a fresh one.
    if (thread === undefined || thread.dead) {
      const queue = new EventQueue()
      thread = { dshSessionId, threadId: undefined, dead: false, push: event => queue.push(event), next: () => queue.next() }
      this.threads.set(dshSessionId, thread)
    }
    return thread
  }

  async ensure() {
    // A peer exists before its handshake has finished; other callers wait for it.
    if (this.starting !== undefined) return this.starting
    if (this.peer !== undefined) return this.peer
    const starting = this.startPeer()
    this.starting = starting
    try {
      return await starting
    } finally {
      if (this.starting === starting) this.starting = undefined
    }
  }

  async startPeer() {
    const bin = findEngineExecutable(this.engine, name => this.findExecutable(name))
    if (bin === undefined) throw Object.assign(new Error(`${this.engine.name} is not installed`), { code: 'NO_ADAPTER' })
    const child = (this.engine.spawn ?? spawnAgent)(bin, this.engine.args ?? [], {
      env: cleanEnv(this.engine.env ?? {}),
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: this.engine.spawnCwd,
      windowsHide: true,
    })
    this.child = child
    const peer = this.peer = new JsonRpcPeer(line => child.stdin.write(`${JSON.stringify(line)}\n`))
    wireProcess(child, peer)
    const gone = (error) => {
      peer.close(error)
      // A process close() let go of must not take the one that replaced it along.
      if (this.child !== child) return
      this.child = undefined
      this.peer = undefined
      for (const thread of this.threads.values()) {
        this.releaseCompaction(thread)
        thread.dead = true
        thread.push({ type: 'error', error })
      }
    }
    child.on('exit', () => gone(new Error(`${this.engine.name} exited`)))
    // A CLI that cannot start at all (a broken install, a missing interpreter)
    // raises 'error', never 'exit'; unheard it takes the host down.
    child.on('error', error => gone(Object.assign(new Error(`${this.engine.name} could not start: ${error.message}`), { code: 'LOCAL_AGENT_EXIT' })))
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    try {
      await peer.request('initialize', { clientInfo: { name: 'godbot', title: 'NativeCrew', version: '1' }, capabilities:{experimentalApi:true} }, { timeout: 30_000 })
      if (this.child !== child) {
        throw Object.assign(new Error(`${this.engine.name} closed while starting`), { code: 'LOCAL_AGENT_EXIT' })
      }
      peer.notify('initialized', {})
      return peer
    } catch (error) {
      peer.close(error)
      if (this.child === child) {
        this.child = undefined
        this.peer = undefined
        terminateChild(child)
      }
      throw error
    }
  }

  onNotice(method, params) {
    if (consumeCodexCommandNotice(this, method, params)) return
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    switch (method) {
      case 'thread/settings/updated': {
        if (thread && params.threadSettings) {
          thread.model = params.threadSettings.model
          thread.mode = params.threadSettings.collaborationMode?.mode
          thread.effort = params.threadSettings.effort
          thread.settingsChanged?.()
        }
        break
      }
      case 'turn/started':
        if (thread !== undefined) {
          this.activateTurn(thread, params?.turn?.id)
          thread.push({ type: 'started', turnId: params?.turn?.id })
        }
        break
      case 'item/started':
      case 'item/completed': {
        const item = params?.item ?? {}
        if (thread === undefined) break
        // Codex 0.166 condenses as an item of its own, in a turn of its own or mid-turn.
        if (item.type === 'contextCompaction') {
          if (method === 'item/started') this.activateTurn(thread, params?.turnId)
          thread.push({ type: 'compaction', status: method === 'item/started' ? 'started' : 'completed' })
        }
        // Every event names its turn, so the adapter can tell a finished turn's
        // leftovers from the turn it reads now (#1513).
        const turnId = params?.turnId
        if (item.type === 'agentMessage' || item.type === 'agent_message') {
          if (method === 'item/completed' && !thread.deltaItems?.delete(item.id)) thread.push({ type: 'text', text: item.text ?? '', turnId })
        } else if (!['reasoning', 'contextCompaction', 'userMessage'].includes(item.type)) {
          const status = method === 'item/started' ? 'running' : toolStatusWithExitCode(item.status ?? 'completed', item.exitCode)
          thread.push({ type: 'tool', toolCallId: item.id, name: item.type, text: activityOf(item),
            input: item.arguments ?? item.command, output: item.aggregatedOutput?.slice(0, 12_000), exitCode: item.exitCode, status, turnId })
        }
        break
      }
      case 'item/agentMessage/delta':
        if (thread && typeof params.delta === 'string') {
          (thread.deltaItems ??= new Set()).add(params.itemId)
          thread.push({type: 'text', text: params.delta, turnId: params.turnId})
        }
        break
      case 'turn/completed': {
        if (thread === undefined) break
        const turn = params?.turn ?? {}
        // Only the turn that finished is cleared. A late notice for an earlier turn —
        // one a steer already replaced — must not clear the turn running now: that would
        // make the next input start a turn instead of steering the live one (#1513).
        thread.completedTurnId = turn.id
        if (turn.id === undefined || thread.turnId === turn.id) thread.turnId = undefined
        if (turn.status === 'failed') thread.push({ type: 'error', error: new Error(turn.error?.message ?? 'the turn failed'), turnId: turn.id })
        else if (turn.status === 'interrupted' || turn.status === 'completed') thread.push({ type: 'done', reason: turn.status, turnId: turn.id })
        else thread.push({ type: 'error', error: new Error('Unknown Codex turn outcome: ' + turn.status), turnId: turn.id })
        break
      }
      case 'thread/tokenUsage/updated': {
        // {total, last, modelContextWindow}: `last` is the request that just ran, and
        // its totalTokens is what the thread's context holds now (after a compaction,
        // what is left).
        const last = params?.tokenUsage?.last
        if (thread === undefined || last === undefined) break
        const size = params.tokenUsage.modelContextWindow
        if (typeof last.totalTokens === 'number') thread.push({ type: 'context', used: last.totalTokens, ...(typeof size === 'number' ? { size } : {}), turnId: params?.turnId })
        const cached = last.cachedInputTokens ?? 0
        if (Number.isFinite(last.inputTokens) || Number.isFinite(last.outputTokens)) {
          thread.push({
            type: 'usage',
            turnId: params?.turnId,
            usageId: params.tokenUsage.total?.totalTokens === undefined ? undefined : 'total-' + params.tokenUsage.total.totalTokens,
            usage: {
              // Codex folds cached input into inputTokens; DSH counts it apart.
              inputTokens: Math.max(0, (last.inputTokens ?? 0) - cached),
              outputTokens: last.outputTokens ?? 0,
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
              ...(last.reasoningOutputTokens ? { reasoningTokens: last.reasoningOutputTokens } : {}),
            },
          })
        }
        break
      }
      default: break
    }
  }

  // Server-initiated approval requests bridge to the approval tool.
  onRequest(method, params) {
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    if (!thread) throw new Error('Unknown Codex thread')
    if (this.engine.readOnly) {
      if (method === 'item/permissions/requestApproval') return {permissions:{},scope:'turn'}
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return {decision:'decline'}
      if (method === 'execCommandApproval' || method === 'applyPatchApproval') return {decision:'denied'}
      if (method === 'mcpServer/elicitation/request') {
        const own = thread.teamTools && params.serverName === MCP_SERVER &&
          params._meta?.codex_approval_kind === MCP_APPROVAL && READ_ONLY_TEAM_TOOLS.includes(params._meta?.tool_name)
        return {action:own ? 'accept' : 'decline',content:null,_meta:null}
      }
    }
    if (method === 'item/tool/requestUserInput') {
      return new Promise(resolve => thread.push({
        type: 'question', id: newCallId(), turnId: params.turnId, questions: params.questions,
        reply: answers => resolve({ answers: answers ?? {} }),
      }))
    }
    if (method === 'mcpServer/elicitation/request') {
      return new Promise(resolve => thread.push({
        type: 'permission', id: newCallId(), turnId: params.turnId, action: params.message || 'Allow MCP action',
        options: [{optionId:'accept',kind:'allow_once'}, {optionId:'decline',kind:'reject_once'}],
        reply: choice => resolve({ action: choice === 'accept' ? 'accept' : 'decline', content: null, _meta: null }),
      }))
    }
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const allowed = params.availableDecisions ?? ['accept', 'decline']
      const options = allowed.filter(id => typeof id === 'string').map(id => ({
        optionId: id, name: id, kind: id === 'accept' ? 'allow_once' : id === 'acceptForSession' ? 'allow_always' : 'reject_once',
      }))
      return new Promise(resolve => thread.push({
        type: 'permission', id: newCallId(), turnId: params.turnId, action: params.reason ?? params.command ?? 'Allow Codex action',
        detail: detailText(params), options, reply: decision => resolve({decision: decision ?? 'decline'}),
      }))
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async open(dshSessionId, { cwd, mcp, resumeId, mode, instructions, model, ephemeral }) {
    const peer = await this.ensure()
    const thread = this.threadFor(dshSessionId)
    if (resumeId !== undefined) thread.threadId = resumeId
    // Codex 0.166 reads `ThreadStartParams` from the top level and takes the MCP
    // servers from `config`; it drops unknown keys without a word. So the fields keep
    // their documented names: `sandbox`, `approvalPolicy`, and `config.mcp_servers`.
    // The team instructions belong to a new thread: a resumed one keeps the
    // instructions it was started with, and instruct() updates them later.
    thread.teamTools = Boolean(mcp)
    let extra = {}
    if (this.engine.readOnly) {
      const previous = await serverCatalog(peer)
      const servers = Object.fromEntries(previous
        .filter(server => !server.pluginId && server.name !== MCP_SERVER && server.name !== 'codex_apps')
        .map(server => [server.name, {enabled:false,...(server.httpOrigin ? {url:'http://127.0.0.1:1'} : {command:process.execPath})}]))
      if (mcp) {
        // With approvalPolicy=never, Codex rejects each MCP prompt before it
        // can reach our elicitation handler. Only these member-bound tools
        // may run, on the credentialed loopback server verified after open.
        servers[MCP_SERVER] = {
          url: mcp.url,
          http_headers: { Authorization: 'Bearer ' + mcp.token },
          enabled_tools: READ_ONLY_TEAM_TOOLS,
          tools: Object.fromEntries(READ_ONLY_TEAM_TOOLS.map(name => [name, { approval_mode: 'approve' }])),
        }
      }
      else if (previous.some(server => server.name === MCP_SERVER)) servers[MCP_SERVER] = {enabled:false}
      extra = {sandbox:'read-only',approvalPolicy:'never',config:{
        features:{plugins:false,apps:false,hooks:false,multi_agent:false,multi_agent_v2:false,browser_use:false,computer_use:false},
        mcp_servers:servers,
      }}
    }
    const params = {
      cwd,
      ...(model && model !== 'default' ? { model } : {}),
      approvalPolicy: 'on-request',
      ...(mode ? { sandbox: mode } : {}),
      ...(mcp !== undefined ? { config: { mcp_servers: { [MCP_SERVER]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` } } } } } : {}),
    }
    Object.assign(params,extra)
    thread.defaultRequest = {...params}
    delete thread.defaultRequest.model
    thread.defaults = new Map()
    if (thread.threadId !== undefined) {
      const resumed = await peer.request('thread/resume', { threadId: thread.threadId, ...params }, { timeout: 30_000 })
      if (resumed?.thread?.id && resumed.thread.id !== thread.threadId) throw new Error('Codex resumed another thread')
      this.rememberSettings(thread,resumed,model)
      if (this.engine.readOnly) await verifyReadOnly(peer,resumed,mcp)
      return thread
    }
    const reply = await peer.request('thread/start', { ...params, ...(instructions ? { developerInstructions: instructions } : {}), ...(ephemeral ? { ephemeral: true } : {}) }, { timeout: 60_000 })
    thread.threadId = reply?.thread?.id ?? reply?.threadId
    this.rememberSettings(thread,reply,model)
    const baseline={model:reply.model,effort:reply.reasoningEffort ?? null}
    if (reply.model) thread.defaults.set(reply.model,baseline)
    if (!model || model==='default') thread.defaults.set(null,baseline)
    if (this.engine.readOnly) await verifyReadOnly(peer,reply,mcp)
    return thread
  }

  // Follow-up instructions while a thread lives (Codex injects a developer item).
  async instruct(thread, text) {
    if (text === '') return
    await this.peer?.request('thread/inject_items', { threadId: thread.threadId, items: [{ type: 'developerMessage', text }] }, { timeout: 15_000 }).catch(() => {})
  }

  async prompt(thread, blocks, { signal, effort }) {
    const peer = await this.ensure()
    const command = blocks.find(block => block.type === 'native-command')
    if (command) {
      if (blocks.length !== 1) throw new Error('原生命令必须单独发送。')
      return startCodexCommand(peer, thread, command, signal)
    }
    const reply = await peer.request('turn/start', {
      threadId: thread.threadId,
      input: codexInput(blocks),
      // The app-server takes the level per turn and keeps it for the next ones.
      ...(effort === undefined ? {} : { effort }),
    }, { signal, timeout: 0 })
    const turnId = reply?.turn?.id ?? reply?.id
    // Notifications in the response's stdout batch run before this continuation.
    thread.turnId = thread.completedTurnId === turnId ? undefined : turnId
    return turnId
  }

  // Codex's app-server refuses a steer that does not name the turn it steers, and
  // a refused steer must reach the adapter: it starts a turn of its own instead of
  // dropping the user's answer. A thread with no live turn cannot be steered at all.
  canSteer(thread) {
    return thread?.turnId !== undefined
  }

  activateTurn(thread, turnId) {
    if (turnId === undefined) return
    thread.turnId = turnId
    thread.pendingCompaction = false
    const cancelled = thread.compactionCancel
    thread.compactionCancel = undefined
    if (cancelled !== undefined) Promise.resolve(this.cancel(thread)).then(cancelled.resolve, cancelled.reject)
  }

  releaseCompaction(thread) {
    thread.pendingCompaction = false
    thread.compactionCancel?.resolve()
    thread.compactionCancel = undefined
  }

  // The thread's own compaction: a turn of its own, which ends with turn/completed.
  compact(thread) {
    if (this.peer === undefined) return false
    thread.turnId = undefined
    thread.pendingCompaction = true
    this.peer.request('thread/compact/start', { threadId: thread.threadId }, { timeout: 30_000 })
      .catch(error => {
        this.releaseCompaction(thread)
        thread.push({ type: 'error', error })
      })
    return true
  }

  async steer(thread, input) {
    const expectedTurnId = thread?.turnId
    if (expectedTurnId === undefined) throw new Error('the turn this input steers has already ended')
    const blocks = Array.isArray(input) ? input : [{ type: 'text', text: input }]
    if (blocks.some(block => block.type === 'native-command')) throw new Error('Codex 原生命令需要单独的回合。')
    if (!this.peer) throw new Error('Codex connection closed')
    await this.peer.request('turn/steer', { threadId: thread.threadId, expectedTurnId, input: codexInput(blocks) }, { timeout: 15_000 })
  }

  cancel(thread) {
    if (thread.pendingCompaction) {
      thread.compactionCancel ??= Promise.withResolvers()
      return thread.compactionCancel.promise
    }
    if (thread.turnId === undefined) return
    if (!this.peer) throw new Error('Codex connection closed')
    return this.peer.request('turn/interrupt', { threadId: thread.threadId, turnId: thread.turnId }, { timeout: 15_000 })
  }

  // The adapter stopped reading this thread: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    const thread = this.threads.get(dshSessionId)
    if (thread !== undefined) this.releaseCompaction(thread)
    this.threads.delete(dshSessionId)
  }

  rememberSettings(thread, reply, requested) {
    if (requested && requested !== 'default' && reply?.model !== requested)
      throw new Error('Codex did not confirm the requested model')
    thread.model = reply?.model
    thread.effort = reply?.reasoningEffort
    thread.mode = reply?.collaborationMode?.mode
  }

  async listModels() {
    const peer = await this.ensure()
    const models = []
    const cursors = new Set()
    let cursor
    do {
      if (cursors.has(cursor)) throw new Error('Codex repeated a model catalog cursor')
      cursors.add(cursor)
      const page = await peer.request('model/list', { cursor, limit: 100 }, { timeout: 15_000 })
      for (const entry of page.data ?? page.models ?? []) {
        const id = entry.id ?? entry.model
        const inputModalities = codexInputModalities(entry.inputModalities)
        if (id && !entry.hidden)
          models.push({
            id,
            name: entry.displayName ?? entry.name ?? id,
            efforts: effortOptions(entry.supportedReasoningEfforts ?? []),
            ...(inputModalities === undefined ? {} : { inputModalities }),
            ...(entry.defaultReasoningEffort ? { catalogDefaultEffort: entry.defaultReasoningEffort } : {}),
          })
      }
      cursor = page.nextCursor
    } while (cursor)
    return models
  }

  async describe(thread) {
    if (!this.catalog) {
      this.catalog = Promise.all([
        this.listModels(),
        this.peer.request('collaborationMode/list', {}, { timeout: 15_000 }).catch((error) => {
          if (error.code === -32601 || /experimental|method not found/i.test(error.message)) return null
          throw error
        }),
      ])
        .then(([models, result]) => ({
          models,
          modes: (result?.data ?? [])
            .filter((item) => item.mode)
            .map((item) => ({
              id: item.mode,
              name: item.name ?? item.mode,
              selectable: ['plan', 'default'].includes(item.mode),
            })),
          commands: [],
          canSetModel: result !== null && models.length > 0,
        }))
        .catch((error) => {
          this.catalog = undefined
          throw error
        })
    }
    const catalog = await this.catalog
    const efforts = catalog.models.find((m) => m.id === thread.model)?.efforts ?? []
    return {
      ...catalog,
      canSetMode: catalog.modes.some((m) => m.selectable) && Boolean(thread.model),
      currentModel: thread.model,
      currentMode: thread.mode,
      efforts,
      currentEffort: thread.effort ?? null,
      canConfigureEffort: catalog.canSetModel,
      canSetEffort: catalog.canSetModel && efforts.length > 0,
      canResetModel: catalog.canSetModel,
      canResetEffort: catalog.canSetModel && efforts.length > 0,
      defaultModel: thread.defaults?.get(null)?.model,
      defaultEffort: thread.defaults?.get(thread.model)?.effort,
      effortSource: 'native',
    }
  }

  async defaultsFor(thread, model) {
    if (thread.defaults.has(model)) return thread.defaults.get(model)
    // isDefault and defaultReasoningEffort from model/list describe the model
    // catalog. Only a fresh native thread reflects the actual user's CLI config.
    const fresh = await this.peer.request(
      'thread/start',
      {
        ...thread.defaultRequest,
        ...(model ? { model } : {}),
        ephemeral: true,
      },
      { timeout: 15_000 },
    )
    try {
      if (!fresh.model || (model && model !== fresh.model))
        throw new Error('Codex could not resolve the native defaults')
      const value = { model: fresh.model, effort: fresh.reasoningEffort ?? null }
      thread.defaults.set(model, value)
      thread.defaults.set(fresh.model, value)
      return value
    } finally {
      if (fresh.thread?.id)
        await this.peer.request('thread/unsubscribe', { threadId: fresh.thread.id }, { timeout: 5000 })
    }
  }

  async configure(thread, { model, mode, effort }) {
    const options = await this.describe(thread)
    const nativeModel =
      model === null ? (await this.defaultsFor(thread, null)).model : (model ?? thread.model)
    const levels = options.models.find((m) => m.id === nativeModel)?.efforts ?? []
    requireEffort(levels, effort)
    const switching = model !== undefined && nativeModel !== thread.model
    // A new model starts with its native defaults unless the caller made an
    // explicit selection for that model. Never carry a model-specific level across.
    const selected =
      effort === null || (switching && effort === undefined)
        ? (await this.defaultsFor(thread, nativeModel)).effort
        : effort
    const params = { threadId: thread.threadId, ...(model !== undefined ? { model: nativeModel } : {}) }
    if (selected != null) params.effort = selected
    if (mode || selected === null) {
      const chosenMode = mode ?? thread.mode
      if (!chosenMode) {
        // Codex ignores top-level effort:null. Read the existing collaboration
        // mode using a no-change update before clearing its nested effort.
        await this.updateAndWait(thread, { threadId: thread.threadId, model: thread.model }, () =>
          Boolean(thread.mode),
        )
      }
      params.collaborationMode = {
        mode: chosenMode ?? thread.mode,
        settings: {
          model: nativeModel,
          reasoning_effort: selected === undefined ? (thread.effort ?? null) : selected,
          developer_instructions: null,
        },
      }
    }
    if (
      nativeModel === thread.model &&
      (!mode || mode === thread.mode) &&
      (selected === undefined || selected === (thread.effort ?? null))
    )
      return
    await this.updateAndWait(
      thread,
      params,
      () =>
        (model === undefined || thread.model === nativeModel) &&
        (!mode || mode === thread.mode) &&
        (selected === undefined || (thread.effort ?? null) === selected),
    )
  }

  async updateAndWait(thread, params, matches) {
    // The RPC result only acknowledges queueing. It can arrive after the settings
    // notification in the same stdout batch, so subscribe before issuing the RPC.
    const changed = Promise.withResolvers()
    let timer
    thread.settingsChanged = () => {
      if (matches()) changed.resolve(true)
    }
    try {
      await this.peer.request('thread/settings/update', params, { timeout: 8000 })
      timer = setTimeout(() => changed.resolve(false), 6000)
      if (!(await changed.promise)) throw new Error('Codex has not confirmed the selected thread settings')
    } finally {
      clearTimeout(timer)
      delete thread.settingsChanged
    }
  }

  async close() {
    for (const thread of this.threads.values()) this.releaseCompaction(thread)
    const child = this.child
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    if (child === undefined) return this.closing
    if (child.exitCode !== null || child.signalCode !== null) return
    this.closing = new Promise(resolve => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5_000)
      timer.unref?.()
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
    return this.closing
  }
}

function codexInput(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'skill') {
      out.push({ type: 'skill', name: block.name, path: block.path })
    } else if (block.type === 'image') {
      const url = block.url ?? (block.data?.startsWith('data:') ? block.data : `data:${block.mediaType ?? block.mimeType ?? 'image/png'};base64,${block.data}`)
      out.push({ type: 'image', url })
    } else if ((block.text ?? '') !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

const activityOf = item => {
  const kind = item.type === 'commandExecution' ? (item.command ?? 'command')
    : item.type === 'fileChange' ? 'edit'
      : item.type === 'mcpToolCall' ? (item.tool ?? 'tool')
        : (item.title ?? item.type)
  return String(kind).split('\n')[0].slice(0, 120)
}
const detailText = params => [params?.command, params?.reason, JSON.stringify(params?.changes ?? params?.patch ?? '')].filter(Boolean).join('\n').slice(0, 4_000)

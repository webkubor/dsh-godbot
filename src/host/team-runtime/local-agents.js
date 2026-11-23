// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Local agents: ordinary Bots whose model route is a local agent CLI (Devin
// CLI, Claude Code, Codex, ACP agents). install() scans for the CLIs, registers
// one DSH LLM adapter for the routes it found, keeps the custom agents and the
// Session→CLI-session map in state, and serves the Settings page.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { claimTeamTerminal, TerminalLeases } from './terminal-lease.js'
import { SandboxTeamAgents, sandboxRouteInfo } from './sandbox-agents.js'
import { sandboxTeamEngine } from './sandbox-engines.js'
import { commandLabel, toolActivity } from './tool-activity.js'
import { toolReference } from './shared/tool-timeline.js'
import { readBoundCodexHistory } from './codex-execution-history.js'
import { acpToolExitCode, acpToolStatus } from '../../drivers/external/tool-results.js'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LoopbackMcp } from '../../team/mcp.js'
import { serviceOf } from './core/services.js'
import { splitRef } from './core/text.js'
import { output } from './core/tools.js'
import { LocalAgentAdapter, DEFAULT_CONTEXT_WINDOW, nativeInputModalities } from './core/local-agents/adapter.js'
import { AcpEngine, ownToolCall } from './core/local-agents/acp.js'
import { CodexEngine } from './core/local-agents/codex.js'
import { createWorkspaceClaudeEngine } from '../workspace-agent-controls.js'
import { CodexEngine as NativeCodexEngine, consumeCodexCommandNotice } from '../../drivers/external/codex.js'
import { listSlashCommands } from '../slash-catalog.js'
import { resolveSlash, slashInput, teamSlashMessage } from '../slash.js'
import { ENGINES, customRoute, isLocalAgentRoute as isBaseLocalRoute, validateCustom } from './core/local-agents/engines.js'
import { cleanEnv, findEngineExecutable, findExecutable, probeSignIn, probeVersion, refreshSearchDirs } from '../../drivers/external/discover.js'

const isLocalAgentRoute = route => isBaseLocalRoute(route) || Boolean(sandboxRouteInfo(route))

// What a local agent CLI keeps of a DSH prompt assembly. Sections: NativeCrew's
// instructions only. Contexts: the working folder and NativeCrew's own, plus the
// memory, which leaves the instructions for the runtime context.
const LOCAL_AGENT_SECTIONS = new Set(['bot-identity'])
const LOCAL_AGENT_CONTEXTS = new Set(['working-directory:current', 'godbot-learning'])
const MEMORY_SECTION = 'bot-memory'
export const MEMORY_CONTEXT = 'godbot-memory'

export function localAgentPresentation(assembly) {
  const memory = assembly.sections.find(section => section.name === MEMORY_SECTION)
  const contexts = assembly.contexts.filter(entry => LOCAL_AGENT_CONTEXTS.has(entry.name))
  if (memory !== undefined && memory.text !== '') contexts.push({ name: MEMORY_CONTEXT, text: memory.text, interpolate: false })
  return {
    ...assembly,
    sections: assembly.sections.filter(section => LOCAL_AGENT_SECTIONS.has(section.name)),
    contexts,
  }
}

const SIGNED_IN_TTL_MS = 60_000

function spawnEngine(kind, route, spec) {
  if (kind === 'acp') {
    // Antigravity's Auto mode forcibly enables its terminal sandbox. Use the
    // normal native mode; the adapter already answers prompts for full access.
    const engine = route === 'local-antigravity'
      ? { ...spec, modes: { ...spec.modes, 'danger-full-access': ['default'] } }
      : spec
    return new WorkspaceAcpEngine(route, engine, { findExecutable })
  }
  return kind === 'codex' ? new WorkspaceCodexEngine(route, spec, { findExecutable })
    : createWorkspaceClaudeEngine(route, spec, { findExecutable })
}

const toolPaths = items => Array.isArray(items)
  ? items.map(item => item?.path).filter(path => typeof path === 'string' && path !== '').slice(0, 3).join(', ')
  : ''

// NativeCrew uses an array of command names for compaction. Retain the associated
// ACP descriptors for exactly as long as that session's name array is live.
const acpMenus = new WeakMap()
const acpToolNames = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Shell', fetch: 'Fetch', think: 'Think' }

function acpExecution(id, name, call, status, exitCode) {
  if (typeof id !== 'string' || id === '') return undefined
  const blocks = Array.isArray(call.content) ? call.content : []
  const changes = blocks.filter(block => block?.type === 'diff')
  const content = blocks.filter(block => block?.type !== 'diff')
  const output = call.rawOutput != null && content.length ? { result: call.rawOutput, content }
    : call.rawOutput ?? (content.length ? content : undefined)
  return { type: 'tool', id, name, status, input: call.rawInput ?? call.args, output,
    ...(changes.length ? { changes } : {}), locations: call.locations, cwd: call.cwd ?? call.rawInput?.cwd,
    exitCode, durationMs: call.durationMs, parentId: call.parentToolCallId }
}

function recordAcpTool(sessions, { sessionId, update }) {
  const session = [...sessions.values()].find(entry => entry.acpSessionId === sessionId)
  if (!session) return
  const id = update.toolCallId
  const known = update.sessionUpdate === 'tool_call' ? undefined : session.toolCalls.get(id)
  // The workspace permission handler uses the same merged call to resolve partial updates.
  const call = { ...known, ...Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== 'sessionUpdate' && value != null)) }
  if (id !== undefined) session.toolCalls.set(id, call)
  const exitCode = acpToolExitCode(call)
  const reportedStatus = acpToolStatus(call, exitCode)
  const status = ['failed', 'completed', 'declined', 'interrupted'].includes(reportedStatus) ? reportedStatus : 'started'
  const name = call.name ?? call.toolName ?? acpToolNames[call.kind] ?? '工具'
  const trace = acpExecution(id, name, call, reportedStatus, exitCode)
  const bridged = ownToolCall(call)
  // The loopback bridge publishes its own live DSH node. Keep provider
  // failures as well, since a failed transport may never reach the bridge.
  if (bridged && (status === 'started' || status === 'completed')) return
  if (known && (!bridged || acpToolStatus(known, acpToolExitCode(known)) === status)) {
    if (trace) session.push({ type: 'execution-trace', trace })
    return
  }
  const input = call.rawInput
  const target = toolPaths(call.locations) || (call.kind === 'execute'
    ? input?.toolSummary ?? input?.description ?? commandLabel(input?.command ?? input?.cmd ?? input?.CommandLine)
    : input?.file_path ?? input?.path ?? input?.Path ?? input?.TargetFile)
  session.push({ ...toolActivity(name, target, status), trace })
}

export class WorkspaceAcpEngine extends AcpEngine {
  spawnWorker(cwd) {
    const worker = super.spawnWorker(cwd)
    worker.onNotice = this.onNotice
    worker.loadSession = this.loadSession
    worker.handedToTerminal = this.handedToTerminal
    return worker
  }
  async loadSession(peer, options) {
    if (!this.handedToTerminal?.(options.resumeId)) return super.loadSession(peer, options)
    // The workspace normally falls back to session/new on a failed load. Preserve
    // its MCP transport ladder but never change the post-terminal conversation.
    const strict = Object.create(this)
    strict.newSession = () => { throw new Error('Antigravity 无法恢复该原生会话。') }
    const result = await super.loadSession.call(strict, peer, options)
    if (result.reply?.sessionId && result.reply.sessionId !== options.resumeId)
      throw new Error('Antigravity 返回了其他原生会话。')
    return result
  }
  onNotice(method, params) {
    if (method === 'session/update' && ['tool_call', 'tool_call_update'].includes(params?.update?.sessionUpdate)) {
      recordAcpTool(this.sessions, params)
      return
    }
    super.onNotice(method, params)
    if (params?.update?.sessionUpdate === 'available_commands_update') {
      const names = this.commands.get(params.sessionId)
      if (names) acpMenus.set(names, params.update.availableCommands ?? [])
    }
  }
}

function codexTool({ type, tool, changes, commandActions, command, scriptPath, path }) {
  switch (type) {
    case 'commandExecution': {
      const parsed = Array.isArray(commandActions) ? commandActions.find(action => typeof action?.command === 'string')?.command : undefined
      return ['Shell', toolPaths(commandActions) || scriptPath || commandLabel(parsed ?? command)]
    }
    case 'fileChange': return ['Edit', toolPaths(changes)]
    case 'mcpToolCall':
    case 'dynamicToolCall':
    case 'collabAgentToolCall': return [tool ?? type]
    case 'webSearch': return ['WebSearch']
    case 'imageView': return ['ImageView', path]
    case 'imageGeneration': return ['ImageGeneration']
    default: return undefined
  }
}

function codexToolStatus(method, item) {
  if (method === 'item/started') return 'started'
  if (item.status === 'declined' || item.status === 'interrupted') return item.status
  if (item.status === 'failed' || item.error != null || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0)) return 'failed'
  return 'completed'
}

function codexExecution(item, name, status) {
  if (typeof item.id !== 'string' || item.id === '') return undefined
  const input = item.command ?? item.arguments ?? item.prompt ?? item.query ?? item.path
  const output = item.aggregatedOutput ?? item.error ?? item.result ?? item.contentItems ?? item.agentsStates ?? item.action
  return { type: 'tool', id: item.id, name, status: status === 'started' ? 'running' : status,
    input, output, cwd: item.cwd, changes: item.changes, exitCode: item.exitCode, durationMs: item.durationMs }
}

function codexExecutionUpdate(method, params) {
  const id = params?.itemId
  if (typeof id !== 'string' || id === '') return undefined
  switch (method) {
    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta':
      if (typeof params.delta === 'string' && params.delta !== '')
        return { type: 'tool', id, outputDelta: params.delta }
      break
    case 'item/fileChange/patchUpdated':
      if (Array.isArray(params.changes)) return { type: 'tool', id, changes: params.changes }
      break
    case 'item/mcpToolCall/progress':
      if (typeof params.message === 'string' && params.message !== '')
        return { type: 'tool', id, outputDelta: `${params.message}\n` }
      break
    default: break
  }
}

function codexTurnItems(thread, turnId) {
  const turns = thread.noticeItems ??= new Map()
  let items = turns.get(turnId)
  if (!items) {
    items = { messages: new Map(), tools: new Set(), bridgedTools: new Set() }
    turns.set(turnId, items)
  }
  return items
}

// Keep the team's sandbox, approvals and session lifecycle. Share the native
// app-server input encoder so selected skills reach turn/start and turn/steer.
export class WorkspaceCodexEngine extends CodexEngine {
  async open(id, options) {
    const { resumeId, cwd, mode, mcp, model } = options
    if (!resumeId || !this.handedToTerminal?.(resumeId)) return super.open(id, options)
    const peer = await this.ensure()
    const reply = await peer.request('thread/resume', { threadId: resumeId, cwd,
      ...(model && model !== 'default' ? { model } : {}),
      ...(mode ? { sandbox: mode, approvalPolicy: mode === 'danger-full-access' ? 'never' : 'on-request' } : {}),
      ...(mcp ? { config: { mcp_servers: { godbot: { url: mcp.url, http_headers: { Authorization: 'Bearer ' + mcp.token } } } } } : {}),
    }, { timeout: 30_000 })
    if (reply?.thread?.id !== resumeId) throw new Error('Codex 未恢复该原生会话。')
    const thread = this.threadFor(id)
    thread.threadId = resumeId
    thread.cwd = cwd
    return thread
  }
  onNotice(method, params) {
    if (consumeCodexCommandNotice(this, method, params)) return
    const thread = [...this.threads.values()].find(entry => entry.threadId === params?.threadId)
    if (!thread) return super.onNotice(method, params)
    if (method === 'turn/completed') thread.noticeItems?.delete(params?.turn?.id)
    const { item, turnId } = params ?? {}
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      const { itemId, delta } = params ?? {}
      if (typeof itemId === 'string' && typeof delta === 'string' && delta !== '') {
        const messages = codexTurnItems(thread, turnId).messages
        const streamed = messages.get(itemId)
        if (streamed !== null) {
          messages.set(itemId, (streamed ?? 0) + delta.length)
          thread.push({ type: 'text', text: delta, textKey: itemId, turnId })
        }
      }
      return
    }
    const update = codexExecutionUpdate(method, params)
    if (update) {
      if (!thread.noticeItems?.get(turnId)?.bridgedTools.has(update.id))
        thread.push({ type: 'execution-trace', trace: update, turnId })
      return
    }
    if ((method === 'item/started' || method === 'item/completed') && item) {
      if (item.type === 'agentMessage' || item.type === 'agent_message' || item.type === 'plan') {
        if (method === 'item/completed') {
          const messages = codexTurnItems(thread, turnId).messages
          const streamed = messages.get(item.id)
          if (streamed !== null) {
            if (typeof item.id === 'string') messages.set(item.id, null)
            // A completion repeats the streamed prefix. Some backends report
            // a final suffix here even when a text delta did not arrive.
            const text = typeof item.text === 'string' ? item.text.slice(streamed ?? 0) : undefined
            if (text) thread.push({ type: 'text', text, textKey: item.id, turnId })
          }
        }
        return
      }
      const tool = codexTool(item)
      if (tool) {
        const [name, target] = tool
        const status = codexToolStatus(method, item)
        // The `godbot` loopback sends its own DSH tool/call and tool/result
        // events. Codex reports transport errors separately from MCP results.
        const bridged = item.type === 'mcpToolCall' && item.server === 'godbot'
        const items = codexTurnItems(thread, turnId)
        if (bridged && typeof item.id === 'string') items.bridgedTools.add(item.id)
        const transportFailed = method === 'item/completed' && item.error != null && item.result == null
        if (bridged && !transportFailed) return
        const trace = codexExecution(item, name, status)
        if (trace && items.tools.has(trace.id)) {
          thread.push({ type: 'execution-trace', trace, turnId })
          return
        }
        if (trace) items.tools.add(trace.id)
        thread.push({ ...toolActivity(name, target, status), trace, turnId })
        return
      }
      if (method === 'item/started' && !['reasoning', 'contextCompaction'].includes(item.type)) return
    }
    super.onNotice(method, params)
  }
  prompt = NativeCodexEngine.prototype.prompt
  steer = NativeCodexEngine.prototype.steer
}

export class WorkspaceAgentAdapter extends LocalAgentAdapter {
  slashInputs = new WeakMap()
  terminalLeases = new TerminalLeases()

  async ensureMcp(live, toolsForStep) {
    const admitted = toolsForStep()
    const catalog = this.deps.rt.connectorTools
    live.tools = () => catalog.current(admitted, live.sessionId)
    if (live.mcp) return live.mcp
    const bridge = new LoopbackMcp(() => {
      const tools = live.tools()
      catalog.listed(live.sessionId, this.deps.exposedRoute ?? live.route, tools)
      return tools
    }, ({ name, arguments: args, callId }) => {
      const tool = live.tools().find(entry => entry.name === name)
      // A turn the CLI runs by itself may call before the Session turn that shows it
      // starts; that turn hands the call to the loop, which checks it like any other.
      if (live.dead || (live.state === 'idle' && live.background === undefined) || !tool) {
        return Promise.resolve({ text: '该工具未获当前会话授权。', isError: true })
      }
      const dshCallId = 'godbot-' + callId
      if (tool.connector) catalog.calls.set(dshCallId, { tool, sessionId: live.sessionId, botId: catalog.rt.selfOf(live.sessionId) })
      return new Promise(resolve => {
        live.pending.set(dshCallId, { name, mcpCallId: callId, resolve })
        live.push({ type: 'call', name, args, dshCallId })
      }).finally(() => catalog.calls.delete(dshCallId))
    })
    await bridge.listen()
    live.mcp = bridge
    return bridge
  }

  providerInfo(route) {
    const account = sandboxRouteInfo(route)
    if (account) return { id: route, name: this.sandboxes?.routes().find(row => row.route === route)?.name ?? account.accountId }
    return super.providerInfo(route)
  }
  async *stream(options) {
    const sandbox = sandboxRouteInfo(options.provider)
    if (sandbox && this.sandboxes) {
      const nested = this.sandboxes.get(options.sessionId, options.provider, this.deps)
      const release = this.terminalLeases.enter(String(options.sessionId))
      try { yield* nested.streamChat({ ...options, provider: sandbox.base }) } finally { release() }
      return
    }
    if (this.sandboxes && options.sessionId) {
      const part = String(options.sessionId)
      const binding = this.deps.record(part)
      const bot = this.sandboxes.botFor(part)
      if (binding?.accountProfileId || bot?.accountProfileId || this.sandboxes.changes.has(bot?.id))
        throw new Error('当前 Bot 已绑定沙箱账号，无法从本机打开此会话。')
    }
    const release = this.terminalLeases.enter(String(options.sessionId))
    try { yield* this.streamChat(options) } finally { release() }
  }
  async *drain(live, options) {
    const history = this.deps.rt?.executionHistory
    if (!history) {
      yield* super.drain(live, options)
      return
    }
    const next = live.next
    live.next = async () => {
      const event = await next()
      // Match the workspace drain's turn fence, and ignore a pending dequeue that
      // settled after cancellation. Trace-only events produce no model chunks.
      if (event.trace && !options.signal?.aborted && !live.dead &&
          (event.turnId === undefined || live.turnTag === undefined || event.turnId === live.turnTag)) {
        history.record(live.sessionId, event.trace)
        if (event.type === 'activity') return { ...event, text: toolReference(event.text, event.trace.id) }
      }
      return event
    }
    try { yield* super.drain(live, options) } finally { live.next = next }
  }
  async maintain(id, signal, work) {
    const release = this.terminalLeases.enter(String(id))
    try { return await super.maintain(id, signal, work) } finally { release() }
  }
  async dispose() {
    await Promise.all([this.terminalLeases.dispose(), super.dispose()])
  }
  async readCodexExecutionHistory(binding) {
    if (this.disposed || binding?.route !== 'local-codex-cli' || !binding.cliSessionId || !binding.cwd) return []
    const engine = this.engine(binding.route)
    // Protect the shared app-server from idle close or a concurrent model
    // probe for the duration of these read-only calls.
    const request = { engine, controller: new AbortController(), done: Promise.withResolvers() }
    this.sideRequests.add(request)
    const signal = AbortSignal.any([request.controller.signal, AbortSignal.timeout(4000)])
    let onAbort
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const peer = await Promise.race([engine.ensure(), aborted])
      return await readBoundCodexHistory(peer, binding, { signal, toolOf: item => {
        const tool = codexTool(item)
        if (!tool) return
        const status = item.status === 'inProgress' ? 'started' : codexToolStatus('item/completed', item)
        return codexExecution(item, tool[0], status)
      } })
    } catch {
      return []
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (!this.engineInUse(engine, request)) await engine.close?.().catch(() => {})
      this.sideRequests.delete(request)
      request.done.resolve()
    }
  }
  async detachForTerminal(live) {
    const session = live.engineSession
    clearTimeout(live.idle)
    // Unsubscribe only this Bot when other threads share the native process.
    if (session && live.spec.kind === 'codex' && live.engine.peer) {
      await live.engine.peer.request('thread/unsubscribe', { threadId: live.cliSessionId }, { timeout: 10_000 })
    }
    if (session && live.spec.kind === 'acp') {
      const worker = live.engine.workerOf(session) ?? live.engine
      if (worker.caps.close) {
        await worker.peer.request('session/close', { sessionId: live.cliSessionId }, { timeout: 10_000 })
      } else if (worker.sessions.size > 1) {
        throw new Error('该 ACP 进程尚在服务其他会话，无法独立释放此会话。')
      }
    }
    const child = session?.child
    const exited = child && child.exitCode === null && child.signalCode === null
      ? once(child, 'exit', { signal: AbortSignal.timeout(10_000) }) : undefined
    await Promise.all([exited, this.closeLive(live, { idle: true })])
  }
  recordOf(live, extra) {
    const record = super.recordOf(live, extra)
    const bound = this.deps.record(live.sessionId)?.terminalSessionId
    if (bound) record.terminalSessionId = bound
    return record
  }
  rollbackUnread(live, id) {
    const expected = this.deps.record(id)?.terminalSessionId
    if (live.engineSession?.resumeMissing && (this.deps.sandbox || (expected && live.cliSessionId === expected))) {
      live.handed = live.handedBefore
      this.deps.saveRecord(id, this.recordOf(live))
      return
    }
    super.rollbackUnread(live, id)
  }
  async *streamChat(options) {
    const request = teamSlashMessage(options.messages)
    if (!request || ['session-title', 'compaction'].includes(options.purpose)) {
      yield* super.stream(options)
      return
    }
    if ((this.deps.exposedRoute ?? options.provider) !== request.route) throw new Error('Bot 切换了 Agent，请重新选择命令。')
    // A fresh signal isolates simultaneous/private conversations, including
    // nested or retried calls that happen to share the same outer signal.
    const signal = options.signal ? AbortSignal.any([options.signal]) : new AbortController().signal
    const cwd = await this.deps.cwdFor(String(options.sessionId))
    const commands = await this.deps.slashCatalog(request.route, cwd, options.sessionId)
    const delivery = { command: resolveSlash(commands, request.name, request.args) }
    this.slashInputs.set(signal, delivery)
    try {
      let sessionUsage
      for await (const chunk of super.stream({ ...options, signal })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'text' && delivery.report?.text === chunk.block.text)
          sessionUsage = delivery.report.sessionUsage
        if (chunk.type === 'finish' && chunk.reason.kind === 'stop' && sessionUsage) {
          // Persist a structured receipt on this assistant message. Never add
          // numbers to the model prompt or append markup to the CLI's stdout.
          yield { ...chunk, replayState: { response: { godbotClaudeSessionUsage: sessionUsage } } }
        } else yield chunk
      }
    } finally {
      this.slashInputs.delete(signal)
      if (delivery.control?.usageDelivery === delivery) delete delivery.control.usageDelivery
      const live = delivery.refreshInstructions
      if (live && !live.dead) {
        // The workspace marked its runtime preamble as delivered, but a raw native
        // command cannot carry it. Reattach the team instructions to the next
        // ordinary input without rewinding tool acknowledgements or user turns.
        live.promptHash = undefined
        this.deps.saveRecord(live.sessionId, this.recordOf(live))
      }
    }
  }

  sendInput(live, input, signal, effort, settled) {
    const delivery = this.slashInputs.get(signal)
    if (!delivery) return super.sendInput(live, input, signal, effort, settled)
    // NativeCrew prepends replay and runtime context, so forwarding that string
    // would make the CLI read a slash command as prose. Codex accepts metadata
    // alongside its ordinary text and retains the entire replay in that case.
    this.slashInputs.delete(signal)
    const { command } = delivery
    if (live.spec.kind === 'claude' && ['usage', 'cost', 'stats'].includes(command.name)) {
      delivery.control = live.engine.controls.get(live.engineSession)
      if (delivery.control) delivery.control.usageDelivery = delivery
    }
    if (!command.skillPath && Array.isArray(input) &&
      (input.length !== 1 || input[0]?.text !== command.text)) delivery.refreshInstructions = live
    return super.sendInput(live, slashInput(command, input), signal, effort, settled)
  }

  async listModels(route) {
    if (this.sandboxes && sandboxRouteInfo(route)) {
      const target = sandboxRouteInfo(route)
      if (!this.sandboxes.routes().some(row => row.route === 'local-sandbox-' + target.kind + '-' + target.accountId)) return []
      const { rows: reported = [], supportsImages } = this.sandboxes.models.get(route) ?? {}
      const ids = new Set(['default', ...reported.map(row => row.id), ...this.deps.usedModels(route)])
      return [...ids].map(id => {
        const row = reported.find(row => row.id === id) ?? { id, provider: route, name: id === 'default' ? 'CLI default' : id }
        const inputModalities = nativeInputModalities(row.inputModalities, supportsImages)
        return inputModalities === undefined ? row : { ...row, inputModalities }
      })
    }
    const rows = await super.listModels(route)
    const reasoning = this.modelCache.has(route) && this.engines.get(route)?.defaultReasoning
    return reasoning ? rows.map(row => row.id === 'default' ? { ...row, reasoning } : row) : rows
  }

  async resolveModel(route, model) {
    if (this.sandboxes && sandboxRouteInfo(route)) {
      const rows = await this.listModels(route)
      if (!rows.length) throw new Error('该沙箱账号当前不可用。')
      const selected = rows.find(row => row.id === model)
      const inputModalities = selected === undefined
        ? nativeInputModalities(undefined, this.sandboxes.models.get(route)?.supportsImages)
        : selected.inputModalities
      return { ...selected, provider: route, id: model, name: selected?.name ?? model,
        ...(inputModalities === undefined ? {} : { inputModalities }),
        context: { contextWindow: DEFAULT_CONTEXT_WINDOW } }
    }
    if (ENGINES[route]?.kind === 'claude' && !this.modelCache.has(route)) await this.probeModels(route)
    return super.resolveModel(route, model)
  }
}

export function install(rt) {
  const { ctx, state } = rt
  // state.localAgents is replaced by the state load after install; read it
  // each time instead of holding the pre-load object.
  const store = () => {
    const live = state.localAgents ??= { custom: [], sessions: {} }
    live.custom ??= []
    live.sessions ??= {}
    return live
  }

  const customAgents = () => store().custom
  const customRouteId = () => store().custom.map(agent => customRoute(agent.id))
  const sandboxes = new SandboxTeamAgents(rt, { adapterFor: deps => new WorkspaceAgentAdapter(deps),
    engineFor: (...args) => sandboxTeamEngine(...args, { Acp: WorkspaceAcpEngine, Codex: WorkspaceCodexEngine }),
  })
  const allRoutes = () => [...Object.keys(ENGINES), ...customRouteId(), ...sandboxes.routes().map(row => row.route)]

  // Only CLIs found on this machine get a route; the scan result feeds the page.
  const found = new Map()
  let disposed = false
  async function scan() {
    await refreshSearchDirs()
    if (disposed) return []
    for (const route of Object.keys(ENGINES)) {
      const spec = ENGINES[route]
      const path = findEngineExecutable(spec, findExecutable)
      if (path === undefined) found.delete(route)
      else if (found.get(route)?.path !== path) found.set(route, { route, name: spec.name, path, version: undefined, signIn: spec.signIn })
    }
    applyRoutes()
    return [...found.values()]
  }
  async function probeVersions() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.version !== undefined) return
      const spec = ENGINES[entry.route]
      const result = await probeVersion(entry.path, spec.version ?? ['--version'], cleanEnv(spec.env ?? {})).catch(() => undefined)
      entry.version = result?.version
    }))
  }
  // Asked only when the list of CLIs is about to show, never at start or for a menu.
  async function probeSignIns() {
    await Promise.all([...found.values()].map(async (entry) => {
      if (entry.signedIn !== undefined && Date.now() - entry.signedInAt < SIGNED_IN_TTL_MS) return
      entry.signedIn = await probeSignIn(entry.path, ENGINES[entry.route].signedIn)
      entry.signedInAt = Date.now()
    }))
  }
  // A signed-out CLI or a slow one never holds back the list for long: each check is bounded.
  async function freshList() {
    await Promise.all([probeVersions(), probeSignIns()])
    return { available: supported(), detected: [...detected(), ...sandboxes.routes()], custom: customView() }
  }

  async function slashCatalog(route, cwd, sessionId) {
    const sandbox = sandboxRouteInfo(route)
    if (sandbox) sandboxes.validate(sandboxes.botFor(sessionId), route, { part: sessionId })
    const options = { agent: sandbox?.base ?? route, cwd, executable: found.get(route)?.path, liveOnly: Boolean(sandbox) }
    const live = sandbox ? sandboxes.parts.get(String(sessionId))?.adapter.live.get(sessionId) : adapter.live.get(sessionId)
    const session = live?.engineSession
    if (session && !session.dead && live.route === (sandbox?.base ?? route) && live.cwd === cwd) {
      const control = live.engine.controls?.get(session)
      if (control) {
        await control.readMetadata()
        if (control.commands?.length) return listSlashCommands({ ...options, commands: control.commands })
      }
      if (live.spec.kind === 'acp') {
        const worker = live.engine.workerOf(session) ?? live.engine
        const names = worker.commands.get(session.acpSessionId)
        const commands = names && acpMenus.get(names)
        if (commands?.length) return listSlashCommands({ ...options, commands })
      }
    }
    return listSlashCommands(options)
  }
  const adapter = new WorkspaceAgentAdapter({
    slashCatalog,
    rt,
    customAgents,
    findExecutable,
    spawnEngine: (...args) => {
      const engine = spawnEngine(...args)
      engine.handedToTerminal = nativeId => Object.values(store().sessions).some(record => record.terminalSessionId === nativeId)
      return engine
    },
    usedModels: route => usedRefs().map(ref => splitRef(ref)).filter(used => used?.provider === route).map(used => used.model),
    record: sessionId => store().sessions[sessionId],
    saveRecord: (sessionId, record) => {
      store().sessions[sessionId] = record
      void rt.save().catch(() => {})
    },
    recordUsage: entry => rt.recordUsage?.(entry),
    // What a Bot's CLI says by itself shows in a turn of its own (delivery.js); sandbox
    // parts get this with the rest of these deps.
    onBackground: (sessionId, background) => rt.deliverBackground?.(sessionId, background) ?? false,
    // A change that rides along with the next save: the CLI reports its context on
    // every model call.
    patchRecord: (sessionId, patch) => {
      const record = store().sessions[sessionId]
      if (record !== undefined) Object.assign(record, patch)
    },
    presetFor: (sessionId, { terminal = false } = {}) => {
      const bot = rt.botOf(rt.selfOf(sessionId))
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      const assigned = room?.permission ?? bot?.permission
      if (assigned === 'read-only') return assigned
      const enforced = terminal ? undefined : rt.governance?.nativePreset(sessionId)
      if (enforced === 'read-only') return enforced

      // DSH pins policy to the chat when it creates or restores the session.
      // Read that policy on launch and approval, including for inherited Bots.
      try {
        const session = serviceOf(ctx, 'sessions')?.get(sessionId)
        const permissions = serviceOf(ctx, 'permissionPresets')
        const effective = session && permissions?.current(session)
        if (effective === 'read-only') return effective
        if (effective && effective !== 'custom' && effective !== 'auto') {
          const { sandbox, approval } = permissions.resolve(effective)
          if (sandbox === 'read-only') return sandbox
          if (sandbox === 'workspace-write' && approval === 'ask') return sandbox
          // A narrower Bot or room assignment can still be applying. Only a
          // verified full-access bundle without such an assignment can auto-approve.
          if (enforced === undefined && effective === 'danger-full-access' && (!assigned || assigned === effective) &&
              sandbox === effective && approval === 'never') return effective
        }
        if (session && serviceOf(ctx, 'sandboxPolicy')?.resolve({ session }).mode === 'read-only') return 'read-only'
      } catch { /* An unavailable policy cannot authorize automatic approval. */ }
      // The standard workspace mode keeps tool requests on the host approval
      // path. A detached terminal cannot represent that path for custom policies.
      return terminal ? 'custom' : 'workspace-write'
    },
    cwdFor: async (sessionId) => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        return agent.session.header?.cwd ?? rt.workDirOf?.({ botId: rt.selfOf(sessionId), roomId: rt.groupOwners.get(sessionId)?.roomId }) ?? rt.teamFolder?.() ?? tmpdir()
      } catch {
        return rt.teamFolder?.() ?? tmpdir()
      }
    },
    probeCwd: () => mkdtempSync(join(tmpdir(), 'godbot-probe-')),
    toolsFor: (options) => {
      const names = new Set([...rt.teamTools.map(def => def.name), 'approve_agent_action'])
      return rt.connectorTools.forStep(options, names)
    },
  })

  adapter.sandboxes = sandboxes
  // A native terminal someone has taken over dies with the plugin: an automatic
  // update waits until every one has been handed back.
  rt.addUpdateBlocker?.(() => {
    const terminals = adapter.terminalLeases.claims.size
    return terminals > 0 ? { kind: 'terminals', count: terminals } : null
  })
  let registration
  // A message that arrives during handoff stays in its original DSH step, even
  // if its source is another agent or a scheduled job. Release resumes it once.
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    await adapter.terminalLeases.waitForChat(agent.session?.id ?? agent.id, signal)
    return next()
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    if (!['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) return
    const owner = sandboxes.parts.get(String(session.id))?.adapter ?? adapter
    const live = owner.live.get(session.id)
    if (live?.preset !== 'danger-full-access') return
    // The native process can retain full access while its turn is open. Allow
    // the synchronous preset writes to settle before checking the new bundle.
    queueMicrotask(() => {
      if (disposed || owner.live.get(session.id) !== live || owner.deps.presetFor(session.id) === live.preset) return
      void owner.closeSession(session.id, '会话权限已收紧，请在新的权限下重新运行。').catch(error =>
        rt.warn?.('NativeCrew could not close a native session after permission changed: %s', error.message))
    })
  })
  // A local agent CLI reads only NativeCrew's part of the prompt: DSH's own sections and
  // contexts describe DSH's tools, approvals and sandbox, which the CLI does not
  // have; it keeps its own. The memory moves to the runtime context, which reaches
  // the CLI as a note with its next input whenever it changes, so the instructions
  // stay the same for the whole conversation.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    const provider = context?.modelSelection?.provider
    if (typeof provider !== 'string' || !isLocalAgentRoute(provider)) return assembly
    return localAgentPresentation(assembly)
  }, { prepend: true })
  const llm = () => serviceOf(ctx, 'llm')
  const supported = () => typeof llm()?.registerAdapter === 'function'
  const usedRefs = () => [...new Set(Object.values(state.bots ?? {}).flatMap(bot => [bot.model, bot.appliedModel]).filter(Boolean))]
  // A route a Bot runs on stays registered when its CLI goes away: the turn then fails
  // with the repair card, and nothing moves the Bot to another run mode by itself.
  const servedRoutes = () => [...new Set([...found.keys(), ...customRouteId(), ...sandboxes.routes().map(row => row.route), ...sandboxes.pendingRoutes, ...usedRefs().map(ref => splitRef(ref)?.provider).filter(isLocalAgentRoute)])]
  function applyRoutes() {
    if (!supported()) return
    const routes = servedRoutes()
    // The initial registration needs at least one provider; an empty replace
    // is legal and keeps the adapter registered with zero routes.
    if (registration === undefined) {
      if (routes.length === 0) return
      registration = llm().registerAdapter(routes, adapter)
    } else registration.replace(routes)
  }
  // Custom agents hold a route whether or not their command resolves yet; a
  // missing one fails at prompt time with a typed error.
  applyRoutes()
  const initialScan = scan()
  // Custom agents arrive with the state load; their routes register then too.
  void rt.load?.().then(() => { if (!disposed) applyRoutes() }).catch(() => {})
  // The callback returns the disposer: running adapter.dispose() inside the
  // setup would leave the adapter disposed from the moment it installs.
  ctx.effect(() => async () => {
    disposed = true
    registration?.()
    await Promise.all([initialScan, adapter.dispose(), sandboxes.dispose()])
  }, 'godbot: local agents')

  // ---------------------------------------------------------------------------
  // Helpers the rest of the host asks.

  const isLocalAgentRef = ref => isLocalAgentRoute(splitRef(ref)?.provider ?? '')
  // What a ref runs on: the local agent's route, or 'model' for NativeCrew's own models.
  // Two refs with the same answer share a conversation; two with different ones never do.
  const engineOf = (ref) => {
    if (!ref) return undefined
    return isLocalAgentRef(ref) || rt.isRemoteAgentRef?.(ref) ? splitRef(ref).provider : 'model'
  }
  // The model the Bot asked for decides, not the one last applied, which lags behind it.
  const engineOfBot = bot => engineOf(bot?.model ?? bot?.appliedModel)
  const localAgentOf = (bot) => {
    const ref = bot?.model ?? bot?.appliedModel
    return ref !== undefined && isLocalAgentRef(ref) ? ref : undefined
  }
  const isLocalAgentSession = (sessionId) => {
    const bot = rt.botOf(rt.selfOf(sessionId))
    return bot !== undefined && localAgentOf(bot) !== undefined
  }

  // ---------------------------------------------------------------------------
  // approve_agent_action: served only to abot sessions; the CLI's permission
  // prompts arrive through it as an ordinary approval card. It stays off
  // rt.teamTools (the catalog every Bot gets) and joins the scope only for a
  // local-agent Bot.

  rt.localAgentTools = [defineTool({
    name: 'approve_agent_action',
    description: 'Ask the user to approve an action you want to take: running a command, changing files, or reaching the network. The agent runtime asks this on your behalf when its own permission system wants a decision.',
    parameters: {
      action: { type: 'string', required: true, description: 'What the action does, in one line' },
      detail: { type: 'string', description: 'The exact command, paths, or arguments, when it helps the decision' },
    },
    output,
    localAgentOnly: true,
    async execute(args, exec) {
      const approval = ctx.get?.('approval')
      if (approval === undefined || exec.agent?.session === undefined) return 'denied: approvals are not available here'
      const text = `${args.action}${args.detail ? `\n${args.detail}` : ''}`
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
        reason: text.slice(0, 500),
        displayReason: { en: text.slice(0, 500) },
        ...(exec.signal ? { signal: exec.signal } : {}),
      })
      // The adapter decides the CLI's option from this structured result;
      // only an explicit {"decision":"allow"} counts.
      return JSON.stringify({ decision: outcome === 'allowed-once' ? 'allow' : 'deny' })
    },
  })]

  // ---------------------------------------------------------------------------
  // The Settings page's endpoints.

  const detected = () => [...found.values()].map(entry => ({ route: entry.route, name: entry.name, path: entry.path, version: entry.version ?? null, signIn: entry.signIn, signedIn: entry.signedIn ?? null }))
  const customView = () => store().custom.map(agent => ({ ...agent, route: customRoute(agent.id) }))

  // One CLI's models: the first look starts that CLI, later ones read what it said.
  const localAgentModels = async route => {
    const target = sandboxRouteInfo(route)
    if (!target) return servedRoutes().includes(route) ? adapter.probeModels(route) : []
    await sandboxes.probeModels(route, ENGINES[target.base])
    return adapter.listModels(route)
  }

  async function localAgentsEndpoint(endpoint, body) {
    switch (endpoint) {
      case 'local-agents': {
        await scan()
        return freshList()
      }
      case 'local-agent-refresh': {
        adapter.dropModelCache()
        sandboxes.models.clear()
        for (const entry of found.values()) delete entry.signedIn
        await scan()
        await rt.catalog?.({ fresh: true })
        return freshList()
      }
      case 'local-agent-models': {
        const models = await localAgentModels(String(body.route ?? ''))
        await rt.catalog?.({ fresh: true })
        return models
      }
      case 'local-agent-add': {
        const clean = validateCustom(body)
        await refreshSearchDirs()
        if (findExecutable(clean.command) === undefined && !clean.command.includes('/') && !clean.command.includes('\\')) {
          throw new Error(`No program named ${clean.command} was found`)
        }
        const entry = { id: `agent-${Date.now().toString(36)}`, ...clean }
        store().custom.push(entry)
        applyRoutes()
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-update': {
        const entry = store().custom.find(agent => agent.id === body.id)
        if (entry === undefined) throw new Error('Unknown agent')
        const clean = validateCustom({ name: body.name ?? entry.name, command: body.command ?? entry.command, args: body.args ?? entry.args })
        Object.assign(entry, clean)
        adapter.dropModelCache(customRoute(entry.id))
        await rt.save()
        return { ...entry, route: customRoute(entry.id) }
      }
      case 'local-agent-remove': {
        const at = store().custom.findIndex(agent => agent.id === body.id)
        if (at === -1) throw new Error('Unknown agent')
        store().custom.splice(at, 1)
        applyRoutes()
        await rt.save()
        return customView()
      }
      default:
        throw new Error(`Unknown endpoint ${endpoint}`)
    }
  }

  const partAdapter = id => sandboxes.parts.get(String(id))?.adapter ?? adapter
  const isSandboxPart = id => Boolean(store().sessions[String(id)]?.accountProfileId || sandboxes.botFor(String(id))?.accountProfileId)
  const maintenance = (method, id, ...args) => {
    if (!isSandboxPart(id)) return adapter[method](String(id), ...args)
    // ACP native resume and its authenticated bridge are owned by normal chat.
    // Never let background host probes or a fallback model operate on this part.
    throw new Error('该账号的后台上下文操作尚未开放，请在沙箱对话中继续。')
  }
  Object.assign(rt, {
    sandboxBotFields: (model, cwd) => sandboxes.savedBotFields(model, cwd),
    bindSandboxBot: req => sandboxes.bind(req),
    registerSandboxRoutes: applyRoutes,
    syncSandboxRoutes: async () => {
      sandboxes.models.clear()
      applyRoutes()
      if (!sandboxes.enabled()) {
        for (const [key, claim] of adapter.terminalLeases.claims) {
          if (isSandboxPart(key)) claim.controller.abort(new Error('沙箱账号已关闭。'))
        }
        await sandboxes.dispose()
      }
      await rt.catalog?.({ fresh: true })
    },
    assertSandboxBotIdle: id => {
      const keys = new Set([rt.chatOf(id), ...adapter.live.keys(), ...sandboxes.parts.keys(),
        ...adapter.terminalLeases.claims.keys(), ...adapter.terminalLeases.writers.keys(), ...(rt.groupOwners?.keys() ?? [])])
      for (const key of keys) {
        if (key !== rt.chatOf(id) && rt.selfOf(key) !== id) continue
        const live = partAdapter(key).live.get(key)
        const agent = rt.ctx.get?.('agents')?.get(key)
        if (adapter.terminalLeases.claims.has(key) || adapter.terminalLeases.writers.has(key) ||
            (live && (live.state !== 'idle' || live.pending.size || live.queue.length)) ||
            (agent && (agent.status && agent.status !== 'idle' || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length)) ||
            rt.waitsForApproval?.(key) || rt.live?.get(key)?.turn != null || rt.state.switching?.[key])
          throw new Error('请先结束该 Bot 的运行、队列、审批或终端，再切换账号。')
      }
    },
    validateSandboxPart: (bot, route, part) => sandboxes.validate(bot, route, { part }),
    isLocalAgentRoute, isLocalAgentRef, engineOf, engineOfBot, localAgentOf, isLocalAgentSession,
    localAgentRoutes: allRoutes, localAgentsEndpoint, localAgentModels, slashCatalog,
    claimAgentTerminal: (botId, part) => claimTeamTerminal(rt, adapter, botId, part, partAdapter(part)),
    engineNameOf: ref => (isLocalAgentRef(ref) ? adapter.providerInfo(splitRef(ref).provider).name : `the model ${ref}`),
    closeLocalAgentSession: (sessionId, reason) => sandboxes.parts.has(String(sessionId)) ? sandboxes.closePart(sessionId, reason) : adapter.closeSession(sessionId, reason),
    readCodexExecutionHistory: binding => adapter.readCodexExecutionHistory(binding),
    // The parts module's view of a CLI session's context, and the requests it makes of
    // the CLI when the conversation grows long: condense, write the handoff note, and
    // answer the context steward when the team has no model of its own.
    localAgentContext: sessionId => partAdapter(sessionId).contextOf(String(sessionId)),
    localAgentCompact: (sessionId, signal) => maintenance('compact', sessionId, signal),
    localAgentNote: (sessionId, text, signal) => maintenance('note', sessionId, text, signal),
    localAgentAsk: (sessionId, request) => maintenance('ask', sessionId, request),
    localAgentBadge: (ref) => {
      const provider = splitRef(ref)?.provider
      return provider !== undefined && isLocalAgentRoute(provider) ? provider : undefined
    },
  })
}

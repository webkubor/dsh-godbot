// Modified for Godbot. See THIRD_PARTY_NOTICES.
// The Agent Client Protocol engine: one child process per route (or per working
// folder when the CLI pins shell commands to its process cwd), ACP over stdio.
// A process multiplexes sessions: each NativeCrew Session maps to one ACP session,
// created or resumed with our loopback MCP server attached.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonRpcPeer, wireProcess, EventQueue } from './jsonrpc.js'
import { cleanEnv, findEngineExecutable, spawnAgent, terminateChild } from './discover.js'
import { effortOptions, requireEffort } from './effort.js'
import { acpMode } from './engines.js'
import { acpToolExitCode, acpToolStatus } from './tool-results.js'

const CLIENT = { name: 'godbot', version: '1' }
// NativeCrew's loopback MCP server, which carries the Bot's team tools.
const MCP_SERVER = 'godbot'
const AUTH_ERROR = /not signed in|not logged in|login required|unauthorized|authentication/i
const TIMEOUT_ERROR = /timed out|timeout/i
const BUNDLED_MCP_STDIO = join(dirname(fileURLToPath(import.meta.url)), 'mcp-stdio.js')

const extractedBridges = new Map()
// Electron's ASAR reader does not span external CLI processes spawned by Node:
// extract the bridge once per process into a private 0700 temp directory.
export function stdioBridgePath(source = BUNDLED_MCP_STDIO) {
  if (!/\.asar[\\/]/u.test(source)) return source
  const cached = extractedBridges.get(source)
  if (cached !== undefined && existsSync(cached)) return cached
  const dir = mkdtempSync(join(tmpdir(), 'godbot-mcp-'))
  try { chmodSync(dir, 0o700) } catch {}
  const target = join(dir, 'mcp-stdio.mjs')
  writeFileSync(target, readFileSync(source), { flag: 'wx', mode: 0o600 })
  extractedBridges.set(source, target)
  process.once('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
  return target
}

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }

// Events a driver reports, normalized for the adapter:
// {type:'text'|'thought',text} | {type:'activity',text} (one compact line of the
// agent's own work) | {type:'permission',id,action,detail,options,changes,reply} |
// {type:'done',reason,usage?} | {type:'error',error} | {type:'usage',usage} |
// {type:'context',used?,size?} (how full the CLI's own context is) |
// {type:'compaction',status:'started'|'completed'|'failed'}
export class AcpEngine {
  constructor(route, engine, { findExecutable }) {
    this.route = route
    this.engine = engine
    this.findExecutable = findExecutable
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    this.sessions = new Map()
    this.caps = {}
    // The modes, options and models this CLI listed last, for a reply that lists none.
    this.listed = { modes: [], configOptions: [], models: [] }
    // The commands each agent session lists, by the agent's session id.
    this.commands = new Map()
    // For CLIs whose commands follow their process cwd (`cwdPerProcess`): one
    // worker AcpEngine per resolved workspace folder.
    this.workers = new Map()
    this.sessionWorkers = new Map()
    this.ephemeral = false
  }

  activeWorker() {
    return [...this.workers.values()].find(worker => worker.peer !== undefined)
  }

  spawnWorker(cwd) {
    return new AcpEngine(
      this.route,
      { ...this.engine, cwdPerProcess: false, ...(cwd ? { spawnCwd: cwd } : {}) },
      { findExecutable: this.findExecutable },
    )
  }

  workerOf(session, dshSessionId = session?.dshSessionId) {
    return session?._worker ?? (dshSessionId !== undefined ? this.sessionWorkers.get(dshSessionId) : undefined)
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
    const spawnCwd = this.engine.spawnCwd && existsSync(this.engine.spawnCwd) ? this.engine.spawnCwd : undefined
    const child = (this.engine.spawn ?? spawnAgent)(bin, this.engine.args ?? [], {
      ...(spawnCwd !== undefined ? { cwd: spawnCwd } : {}),
      env: cleanEnv(this.engine.env ?? {}),
      stdio: ['pipe', 'pipe', 'ignore'],
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
      for (const session of this.sessions.values()) {
        session.dead = true
        session.push({ type: 'error', error })
      }
    }
    child.on('exit', (code, signal) => gone(new Error(`${this.engine.name} exited${signal ? ` (${signal})` : code !== null ? ` (${code})` : ''}`)))
    // A CLI that cannot start at all (a broken install, a missing interpreter)
    // raises 'error', never 'exit'; unheard it takes the host down.
    child.on('error', error => gone(Object.assign(new Error(`${this.engine.name} could not start: ${error.message}`), { code: 'LOCAL_AGENT_EXIT' })))
    peer.notificationHandler = (method, params) => this.onNotice(method, params)
    peer.requestHandler = (method, params) => this.onRequest(method, params)
    try {
      const reply = await peer.request('initialize', {
        protocolVersion: 1,
        // `session.compaction` asks for compaction_update notices, so NativeCrew hears when
        // the agent condenses its own context.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { compaction: {} } },
        clientInfo: CLIENT,
      }, { timeout: 30_000 })
      if (this.child !== child) {
        throw Object.assign(new Error(`${this.engine.name} closed while starting`), { code: 'LOCAL_AGENT_EXIT' })
      }
      if (reply?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version: ' + reply?.protocolVersion)
      const agentCaps = reply?.agentCapabilities ?? {}
      const mcpCaps = agentCaps.mcpCapabilities ?? agentCaps.mcp_capabilities
      const sessionCaps = agentCaps.sessionCapabilities ?? agentCaps.session_capabilities
      const promptCaps = agentCaps.promptCapabilities ?? agentCaps.prompt_capabilities
      const mcpHttp = mcpCaps?.http
      this.caps = {
        // Prefer Streamable HTTP MCP when declared, bridge via stdio MCP when HTTP is
        // false, or probe HTTP -> stdio -> plain when mcpCapabilities is omitted.
        mcpMode: mcpHttp === true ? 'http' : mcpHttp === false ? 'stdio' : undefined,
        mcpSse: mcpCaps?.sse === true,
        close: sessionCaps?.close != null,
        load: agentCaps.loadSession === true || agentCaps.load_session === true || sessionCaps?.load != null,
        resume: sessionCaps?.resume != null,
        image: promptCaps?.image === true,
      }
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

  sessionFor(dshSessionId) {
    let session = this.sessions.get(dshSessionId)
    // A session whose process exited keeps its queue and, with it, the pump
    // still waiting there: a reopened session needs a fresh one.
    if (session === undefined || session.dead) {
      const queue = new EventQueue()
      session = { dshSessionId, acpSessionId: undefined, dead: false, modes: [], toolCalls: new Map(), push: event => queue.push(event), next: () => queue.next() }
      this.sessions.set(dshSessionId, session)
    }
    return session
  }

  onNotice(method, params) {
    // Devin lists a session's commands before it answers session/new, so they are
    // kept by the agent's session id rather than on a session not known yet.
    if (params?.update?.sessionUpdate === 'available_commands_update') {
      this.commands.set(params.sessionId, (params.update.availableCommands ?? []).filter(c=>c?.name).map(c=>({name:c.name,description:c.description ?? '', ...(c.input?.hint ? { inputHint: c.input.hint } : {})})))
      return
    }
    const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
    if (session === undefined) return
    // Devin CLI 3000.12 reports its compaction this way, not as compaction_update.
    if (method === '_cognition.ai/compaction') {
      session.push({ type: 'compaction', status: compactionStatus(params?.status) })
      return
    }
    if (method !== 'session/update') return
    const update = params?.update ?? {}
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': session.push({ type: 'text', text: textOf(update.content) }); break
      case 'agent_thought_chunk': session.push({ type: 'thought', text: textOf(update.content) }); break
      case 'tool_call':
      case 'tool_call_update': {
        // A permission request names the call only by id; its title, kind and
        // input came with the call's own updates, so they are kept here.
        const id = update.toolCallId
        const known = id === undefined ? undefined : session.toolCalls.get(id)
        const call = mergeCall(known, update)
        if (id !== undefined) session.toolCalls.set(id, call)
        const exitCode = acpToolExitCode(call)
        session.push({
          type: 'tool', toolCallId: id, name: call.kind ?? 'tool', text: describeCall(call),
          status: acpToolStatus(call, exitCode), locations: call.locations, content: call.content,
          input: call.rawInput, output: call.rawOutput, exitCode,
        })
        break
      }
      case 'plan': session.push({ type: 'tool', name: 'plan', status: 'updated', text: planText(update.entries) }); break
      case 'usage_update': {
        // Devin sends each one twice, the second marked as a subagent's; a real
        // subagent's context is not the session's.
        if (update._meta?.['cognition.ai/subagent_context'] !== undefined) break
        if (typeof update.used === 'number') session.push({ type: 'context', used: update.used, ...(typeof update.size === 'number' ? { size: update.size } : {}) })
        break
      }
      case 'current_mode_update':
        session.currentMode = update.currentModeId
        break
      case 'config_option_update': {
        if (Array.isArray(update.configOptions)) {
          this.rememberSessionOptions(session,update.configOptions)
          session.modes = update.modes?.availableModes ?? configOptionsOf(update.configOptions, 'mode')?.options ?? session.modes
        }
        break
      }
      case 'compaction_update': session.push({ type: 'compaction', status: compactionStatus(update.status) }); break
      default: break
    }
  }

  // Agent → client requests: permission prompts bridge to the approval tool;
  // the rest are refused — we hold no editor or terminal of our own.
  onRequest(method, params) {
    if (method === 'session/request_permission') {
      const session = [...this.sessions.values()].find(entry => entry.acpSessionId === params?.sessionId)
      if (session === undefined) return Promise.reject({ code: -32603, message: 'unknown session' })
      const options = (params?.options ?? []).map(option => ({ optionId: option.optionId, name: option.name, kind: option.kind }))
      const call = callOf(session, params?.toolCall)
      const action = describeCall(call)
      return new Promise((resolve) => {
        const id = `perm-${Math.random().toString(36).slice(2)}`
        const reply = (optionId) => {
          if (optionId === null) resolve({ outcome: { outcome: 'cancelled' } })
          else resolve({ outcome: { outcome: 'selected', optionId } })
        }
        session.push({
          type: 'permission', id, reply,
          action,
          detail: detailText(call, action),
          options,
          changes: CHANGE_KINDS.has(call.kind),
        })
      })
    }
    return Promise.reject({ code: -32601, message: `method not found: ${method}` })
  }

  async openInWorker(dshSessionId, openArgs) {
    const existing = openArgs.ephemeral === true ? this.activeWorker() : undefined
    const key = openArgs.cwd ? resolve(openArgs.cwd) : ''
    const reused = existing !== undefined
    let worker = existing ?? this.workers.get(key)
    const created = worker === undefined
    if (created) {
      worker = this.spawnWorker(key)
      if (openArgs.ephemeral === true) worker.ephemeral = true
      this.workers.set(key, worker)
    }
    try {
      const session = await worker.open(dshSessionId, openArgs)
      session._worker = worker
      this.sessionWorkers.set(dshSessionId, worker)
      this.caps.image = worker.caps.image
      return session
    } catch (error) {
      if (created && !reused && ![...this.sessionWorkers.values()].includes(worker)) {
        this.workers.delete(key)
        await worker.close().catch(() => {})
      }
      throw error
    }
  }

  mcpModes(mcp) {
    if (mcp === undefined || this.caps.mcpMode === 'none') return ['none']
    if (this.caps.mcpMode === 'stdio') return ['stdio', 'none']
    return ['http', 'stdio', 'none']
  }

  // Starts an ACP session using Streamable HTTP MCP when supported, falling back
  // to the stdio MCP bridge and finally to a plain session (#1073, #1463).
  async newSession(peer, { cwd, mcp }) {
    const modes = this.mcpModes(mcp)
    let lastError
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]
      try {
        const reply = await peer.request('session/new', { cwd, mcpServers: serversFor(mcp, mode) }, { timeout: 60_000 })
        if (mcp !== undefined) this.caps.mcpMode = mode
        return reply
      } catch (error) {
        lastError = error
        const text = String(error?.message ?? error)
        if (mcp === undefined || AUTH_ERROR.test(text) || TIMEOUT_ERROR.test(text) || i === modes.length - 1) throw error
      }
    }
    throw lastError
  }

  // Resumes an ACP session across the same MCP transport fallback ladder as newSession.
  async loadSession(peer, { cwd, mcp, resumeId }) {
    const modes = this.mcpModes(mcp)
    for (let i = 0; i < modes.length; i++) {
      const mode = modes[i]
      const method = this.caps.resume ? 'session/resume' : this.caps.load ? 'session/load' : undefined
      if (!method) throw new Error('This ACP agent cannot resume the previous session')
      try {
        const reply = await peer.request(method, { cwd, mcpServers: serversFor(mcp, mode), sessionId: resumeId }, { timeout: 30_000 })
        if (mcp !== undefined) this.caps.mcpMode = mode
        if (reply?.sessionId && reply.sessionId !== resumeId) throw new Error('Agent resumed another session')
        return { reply: reply ?? {}, loaded: true }
      } catch (error) {
        if (!mcp || AUTH_ERROR.test(error.message) || TIMEOUT_ERROR.test(error.message) || i === modes.length - 1) throw error
      }
    }
  }

  // A new or resumed ACP session for one NativeCrew Session.
  async open(dshSessionId, openArgs) {
    if (this.engine.cwdPerProcess) return this.openInWorker(dshSessionId, openArgs)
    const { cwd, mcp, resumeId, preset, model } = openArgs
    const peer = await this.ensure()
    const session = this.sessionFor(dshSessionId)
    if (resumeId) session.acpSessionId = resumeId
    const { reply, loaded } =
      resumeId !== undefined
        ? await this.loadSession(peer, { cwd, mcp, resumeId })
        : { reply: await this.newSession(peer, { cwd, mcp }), loaded: false }
    session.acpSessionId = reply?.sessionId ?? resumeId
    const listed = this.remember(reply)
    session.cwd = cwd
    session.currentMode = reply?.modes?.currentModeId ?? session.currentMode
    session.currentModel = reply?.models?.currentModelId ?? session.currentModel
    this.rememberSessionOptions(
      session,
      reply?.configOptions ?? session.configOptions ?? listed.configOptions,
    )
    session.modes = listed.modes
    session.models = listed.models
    session.nativeDefaults = new Map()
    if (!loaded) {
      session.defaultModel = session.currentModel
      if (session.currentEffort != null)
        session.nativeDefaults.set(session.currentModel, session.currentEffort)
    }
    if (
      loaded &&
      !configOptionsOf(session.configOptions, 'model') &&
      !session.models?.length &&
      this.caps.close
    ) {
      // Some ACP implementations resume successfully without advertising their
      // model catalogs again. Reuse only the choices and fresh CLI defaults;
      // the probe says nothing about the resumed conversation's active model.
      const fresh = await this.newSession(peer, { cwd })
      try {
        const freshOptions = fresh?.configOptions ?? []
        const merged = new Map(freshOptions.map(({ currentValue, ...option }) => [option.id, option]))
        for (const original of session.configOptions)
          merged.set(original.id, { ...merged.get(original.id), ...original })
        this.rememberSessionOptions(session, [...merged.values()])
        session.models = fresh?.models?.availableModels ?? []
        session.modes =
          fresh?.modes?.availableModes ?? configOptionsOf(session.configOptions, 'mode')?.options ?? []
        session.defaultModel =
          configOptionsOf(freshOptions, 'model')?.currentValue ?? fresh?.models?.currentModelId
        const initial = configOptionsOf(freshOptions, 'thought_level')?.currentValue
        if (initial != null) session.nativeDefaults.set(session.defaultModel, initial)
      } finally {
        if (fresh?.sessionId) {
          try {
            await peer.request('session/close', { sessionId: fresh.sessionId }, { timeout: 5000 })
          } finally {
            this.commands.delete(fresh.sessionId)
          }
        }
      }
    }
    const mode = acpMode(preset, session.modes, this.engine.modes)
    if (mode !== undefined) await this.setOption(session, 'mode', mode)
    if (model && model !== 'default' && model !== session.currentModel) {
      await this.setOption(session, 'model', model)
      if (!loaded && session.currentModel === model && session.effortReadbackAfterModel)
        session.nativeDefaults.set(model, session.currentEffort)
    }
    return session
  }

  rememberSessionOptions(session, options) {
    session.configOptions = options
    const thought = configOptionsOf(options, 'thought_level')
    if (thought && Object.hasOwn(thought, 'currentValue')) {
      session.currentEffort = thought.currentValue
      session.effortSource = 'native'
    }
    session.currentMode = configOptionsOf(options, 'mode')?.currentValue ?? session.currentMode
    session.currentModel = configOptionsOf(options, 'model')?.currentValue ?? session.currentModel
  }

  describe(session) {
    const options = session.configOptions ?? []
    const model = configOptionsOf(options, 'model')
    const mode = configOptionsOf(options, 'mode')
    const flatten = (rows) =>
      (rows ?? []).flatMap((row) => (Array.isArray(row?.options) ? flatten(row.options) : [row]))
    const entries = (rows) =>
      flatten(rows).flatMap((item) => {
        const id = typeof item === 'string' ? item : (item.value ?? item.id ?? item.modelId)
        return id ? [{ id, name: item.name ?? id }] : []
      })
    const thought = configOptionsOf(options, 'thought_level')
    const availableModels = entries(model?.options ?? session.models)
    const thoughtChoices = effortOptions(flatten(thought?.options))
    // NativeCrew's Antigravity mapping: a model/level pair must appear among the
    // full variant ids. A standalone base id has no configurable level.
    const variantIds = new Set(entries(session.models).map((m) => m.id))
    const variantMap = availableModels.some((m) =>
      thoughtChoices.some((e) => variantIds.has(m.id + '-' + e.id)),
    )
    const models = availableModels.map((m) => ({
      ...m,
      ...(variantMap
        ? { efforts: thoughtChoices.filter((e) => variantIds.has(m.id + '-' + e.id)) }
        : m.id === session.currentModel
          ? { efforts: thoughtChoices }
          : {}),
    }))
    const efforts =
      models.find((m) => m.id === session.currentModel)?.efforts ?? (models.length ? [] : thoughtChoices)
    const knownDefault = session.nativeDefaults?.get(session.currentModel)
    // Unknown ACP mode ids have no portable safety semantics. Keep such choices
    // visible without offering to activate them through this control surface.
    const permitted = new Set(['ask', 'plan', 'read-only', 'readonly'])
    if (this.route === 'antigravity') permitted.add('default')
    const modes = entries(mode?.options ?? session.modes).map((m) => ({
      ...m,
      selectable: permitted.has(m.id),
    }))
    return {
      models,
      modes,
      commands: this.commands.get(session.acpSessionId) ?? [],
      currentModel: session.currentModel,
      currentMode: session.currentMode,
      canSetModel: models.length > 0,
      canSetMode: modes.some((m) => m.selectable),
      defaultModel: session.defaultModel,
      efforts,
      currentEffort: efforts.length ? (session.currentEffort ?? null) : null,
      defaultEffort: knownDefault,
      canConfigureEffort: thoughtChoices.length > 0,
      canSetEffort: efforts.length > 0,
      canResetEffort: efforts.length > 0 && (typeof knownDefault === 'string' || this.caps.close),
      canResetModel: models.length > 0 && (Boolean(session.defaultModel) || this.caps.close),
      effortSource: session.effortSource ?? 'native',
    }
  }

  async defaultsFor(session, target) {
    if (target == null && session.defaultModel)
      return { model: session.defaultModel, effort: session.nativeDefaults.get(session.defaultModel) }
    if (target != null && session.nativeDefaults.has(target))
      return { model: target, effort: session.nativeDefaults.get(target) }
    if (!this.caps.close)
      throw new Error('The ACP agent cannot recover the default settings for this session')
    // A resumed ACP conversation can report a previous override as current.
    // Ask a separate empty native session on the same CLI for unmodified
    // defaults, without team tools or model prompts, then release it.
    const reply = await this.newSession(this.peer, { cwd: session.cwd })
    if (!reply?.sessionId) throw new Error('ACP did not identify the default-settings session')
    const key = Symbol('defaults')
    const probe = this.sessionFor(key)
    probe.acpSessionId = reply.sessionId
    try {
      probe.models = reply.models?.availableModels ?? []
      probe.currentModel = reply.models?.currentModelId
      this.rememberSessionOptions(probe, reply.configOptions ?? [])
      if (!probe.currentModel && (target != null || probe.currentEffort == null))
        throw new Error('ACP did not identify native defaults')
      session.defaultModel = probe.currentModel
      session.nativeDefaults.set(probe.currentModel, probe.currentEffort)
      if (target && probe.currentModel !== target) {
        await this.setOption(probe, 'model', target)
        if (!probe.effortReadbackAfterModel)
          throw new Error('ACP did not report a default effort after the model switch')
        session.nativeDefaults.set(target, probe.currentEffort)
      }
      return { model: probe.currentModel, effort: probe.currentEffort }
    } finally {
      try {
        await this.peer.request('session/close', { sessionId: reply.sessionId }, { timeout: 5000 })
      } finally {
        this.sessions.delete(key)
        this.commands.delete(reply.sessionId)
      }
    }
  }

  async configure(session, { model, mode, effort }) {
    const target =
      model === null ? (await this.defaultsFor(session, null)).model : (model ?? session.currentModel)
    const switching = target !== session.currentModel
    const option = this.describe(session).models.find((m) => m.id === target)
    if (option?.efforts) requireEffort(option.efforts, effort)
    if (mode && session.currentMode !== mode) await this.setOption(session, 'mode', mode)
    if (switching) await this.setOption(session, 'model', target)
    const actual = this.describe(session)
    requireEffort(actual.efforts, effort)
    if (!actual.canSetEffort) return
    let selected = effort
    if (effort === null || (switching && effort === undefined)) {
      if (switching && !session.overrodeEffort && session.effortReadbackAfterModel)
        session.nativeDefaults.set(target, session.currentEffort)
      selected = session.nativeDefaults.has(target)
        ? session.nativeDefaults.get(target)
        : (await this.defaultsFor(session, target)).effort
      if (selected == null) throw new Error('ACP did not disclose the default effort')
      requireEffort(actual.efforts, selected)
    }
    if (selected !== undefined && session.currentEffort !== selected)
      await this.setOption(session, 'thought_level', selected)
    if (selected !== undefined) session.overrodeEffort = effort != null
  }

  async setOption(session, category, value) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.setOption(session, category, value)
    const peer = await this.ensure()
    const option = configOptionsOf(session.configOptions ?? [], category)
    let reply
    if (!option && category === 'model' && session.models?.length) {
      reply = await peer.request(
        'session/set_model',
        { sessionId: session.acpSessionId, modelId: value },
        { timeout: 15_000 },
      )
    } else if (!option && category === 'mode' && session.modes?.length) {
      reply = await peer.request(
        'session/set_mode',
        { sessionId: session.acpSessionId, modeId: value },
        { timeout: 15_000 },
      )
    } else {
      reply = await peer.request(
        'session/set_config_option',
        { sessionId: session.acpSessionId, configId: option?.id ?? category, value },
        { timeout: 15_000 },
      )
    }
    if (Array.isArray(reply?.configOptions)) {
      // ACP implementations can send only changed categories. Keep the rest of
      // this session's catalog and process the authoritative selected value.
      const byId = new Map((session.configOptions ?? []).map((o) => [o.id, o]))
      for (const item of reply.configOptions) byId.set(item.id, item)
      this.rememberSessionOptions(session, [...byId.values()])
      const reported = configOptionsOf(reply.configOptions, category)?.currentValue
      if (reported !== undefined && reported !== value)
        throw new Error('ACP agent selected another ' + category)
    }
    if (category === 'model') {
      session.currentModel = value
      session.effortReadbackAfterModel =
        configOptionsOf(reply?.configOptions ?? [], 'thought_level')?.currentValue != null
    }
    if (category === 'thought_level') {
      session.currentEffort = value
      session.effortSource =
        configOptionsOf(reply?.configOptions ?? [], category)?.currentValue === value
          ? 'native'
          : 'native-ack'
    }
    if (category === 'mode') session.currentMode = value
    return reply
  }

  supportsImages(session) {
    return (this.workerOf(session) ?? this).caps.image
  }

  async prompt(session, blocks, { signal, effort } = {}) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.prompt(session, blocks, { signal, effort })
    const peer = await this.ensure()
    session.running = true
    const reply = peer.request('session/prompt', { sessionId: session.acpSessionId, prompt: acpPrompt(blocks) }, { signal, timeout: 0 })
    session.push({type: 'written'})
    reply.then(
      result => { session.running = false; session.push({ type: 'done', reason: result?.stopReason ?? 'end_turn', ...(usageOf(result?.usage) ? { usage: usageOf(result.usage) } : {}) }) },
      error => { session.running = false; session.push({ type: 'error', error }) },
    )
    return reply
  }

  steer(session, text) {
    if (!session.running || this.peer === undefined) throw new Error('No active ACP prompt')
    // Qualified Antigravity versions accept another prompt while the primary prompt is
    // running. Its independent response must never complete the primary turn.
    return this.peer.request('session/prompt', {sessionId: session.acpSessionId, prompt: acpPrompt([{type: 'text', text}])}, {timeout: 0})
  }

  // The agent's own compaction, through the command it lists for it. False when it
  // lists none: it then condenses only on its own.
  compact(session) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) return worker.compact(session)
    // A loaded session may list nothing again: what this CLI listed last stands in.
    const listed = this.commands.get(session.acpSessionId) ?? [...this.commands.values()].at(-1) ?? []
    if (!listed.some(command => command.name === 'compact')) return false
    this.prompt(session, [{ type: 'text', text: '/compact' }], {}).catch(() => {})
    return true
  }

  // A one-off session leaves the agent's list when it is done.
  async closeSession(session) {
    if (this.engine.cwdPerProcess) {
      const worker = this.workerOf(session)
      if (worker === undefined) return
      await worker.closeSession(session)
      worker.forget(session.dshSessionId)
      this.sessionWorkers.delete(session.dshSessionId)
      if (worker.ephemeral && worker.sessions.size === 0) {
        for (const [key, entry] of this.workers) if (entry === worker) this.workers.delete(key)
        await worker.close()
      }
      return
    }
    if (session?.acpSessionId === undefined) return
    this.commands.delete(session.acpSessionId)
    if (this.caps.close) await this.peer?.request('session/close', { sessionId: session.acpSessionId }, { timeout: 15_000 }).catch(() => {})
  }

  cancel(session) {
    const worker = this.workerOf(session)
    if (worker !== undefined && worker !== this) { worker.cancel(session); return }
    if (!this.peer) throw new Error('ACP connection closed')
    this.peer.notify('session/cancel', { sessionId: session.acpSessionId })
  }

  // The adapter stopped reading this session: a later open starts a new queue, or
  // the pump that waits on this one would swallow its first event.
  forget(dshSessionId) {
    if (this.engine.cwdPerProcess) {
      const worker = this.sessionWorkers.get(dshSessionId)
      if (worker === undefined) return
      this.sessionWorkers.delete(dshSessionId)
      worker.forget(dshSessionId)
      if (worker.sessions.size === 0) {
        for (const [key, entry] of this.workers) if (entry === worker) this.workers.delete(key)
        void worker.close().catch(() => {})
      }
      return
    }
    this.sessions.delete(dshSessionId)
  }

  async close() {
    for (const worker of this.workers.values()) await worker.close()
    this.workers.clear()
    this.sessionWorkers.clear()
    const child = this.child
    this.child = undefined
    this.peer = undefined
    this.starting = undefined
    terminateChild(child)
  }

  remember(reply) {
    const configOptions = reply?.configOptions
    const modes = reply?.modes?.availableModes ?? configOptionsOf(configOptions ?? [], 'mode')?.options
    const models = reply?.models?.availableModels
    this.listed = {
      configOptions: configOptions ?? this.listed.configOptions,
      modes: modes ?? this.listed.modes,
      models: models ?? this.listed.models,
    }
    return this.listed
  }

  // Models (and per-model thinking levels) the agent advertises on a probe session.
  async listModels({ cwd, mcp }) {
    if (this.engine.cwdPerProcess) {
      const live = this.activeWorker()
      if (live !== undefined) {
        const target = live.engine.spawnCwd && existsSync(live.engine.spawnCwd) ? live.engine.spawnCwd : cwd
        const models = await live.listModels({ cwd: target, mcp })
        this.caps.image = live.caps.image
        return models
      }
      const temp = this.spawnWorker(cwd)
      try {
        const models = await temp.listModels({ cwd, mcp })
        this.caps.image = temp.caps.image
        return models
      } finally {
        await temp.close()
      }
    }
    const peer = await this.ensure()
    const probe = await this.newSession(peer, { cwd, mcp })
    if (probe?.sessionId !== undefined) {
      this.commands.delete(probe.sessionId)
      if (this.caps.close) await peer.request('session/close', { sessionId: probe.sessionId }, { timeout: 15_000 }).catch(() => {})
    }
    this.remember(probe)
    return modelsFromProbe(probe)
  }
}

function acpPrompt(blocks) {
  const out = []
  for (const block of blocks) {
    if (block.type === 'image') {
      out.push({ type: 'image', mimeType: block.mimeType ?? block.mediaType ?? 'image/png', data: block.data })
    } else if ((block.text ?? '') !== '') {
      out.push({ type: 'text', text: block.text })
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }]
}

export function modelsFromProbe(probe) {
  const option = configOptionsOf(probe?.configOptions ?? [], 'model')
  const available = probe?.models?.availableModels ?? []
  const baseModels = (option?.options ?? []).length > 0
    ? option.options.map(entry => ({ id: String(entry.id ?? entry.value ?? entry.name), name: String(entry.name ?? entry.id ?? entry.value) }))
    : available.map(entry => ({ id: String(entry.modelId ?? entry.id ?? entry.name), name: String(entry.name ?? entry.modelId ?? entry.id) }))
  const thought = configOptionsOf(probe?.configOptions ?? [], 'thought_level')
  const thoughtOptions = (thought?.options ?? []).map(entry => ({
    id: String(entry.id ?? entry.value ?? entry.name),
    name: String(entry.name ?? entry.id ?? entry.value),
    ...(entry.description ? { description: String(entry.description) } : {}),
  }))
  const thoughtById = new Map(thoughtOptions.map(entry => [entry.id, entry]))
  const availableIds = new Set(available.map(entry => String(entry.modelId ?? entry.id ?? '')).filter(Boolean))
  const knownEfforts = [...new Set([...EFFORT_ORDER, ...thoughtOptions.map(entry => entry.id)])]
  const hasVariantMap = (option?.options ?? []).length > 0
    && availableIds.size > 0
    && baseModels.some(base => knownEfforts.some(effortId => availableIds.has(`${base.id}-${effortId}`)))
  return baseModels.map((model) => {
    // Leave defaultEffort unset so a Bot without a chosen level keeps the CLI's default.
    if (hasVariantMap) {
      const efforts = knownEfforts
        .filter(effortId => availableIds.has(`${model.id}-${effortId}`))
        .map(effortId => thoughtById.get(effortId) ?? { id: effortId, name: EFFORT_NAMES[effortId] ?? effortId })
      return efforts.length > 0 ? { ...model, reasoning: { efforts } } : model
    }
    return thoughtOptions.length > 0 ? { ...model, reasoning: { efforts: thoughtOptions } } : model
  })
}

function serversFor(mcp, mode = 'http') {
  if (mcp === undefined || mode === 'none') return []
  if (mode === 'stdio') {
    if (mcp.sandboxStdio) return [mcp.sandboxStdio]
    return [{
      name: MCP_SERVER,
      command: process.execPath,
      args: [stdioBridgePath()],
      env: [
        { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
        { name: 'GODBOT_MCP_URL', value: mcp.url },
        { name: 'GODBOT_MCP_TOKEN', value: mcp.token },
      ],
    }]
  }
  return [{ type: 'http', name: MCP_SERVER, url: mcp.url, headers: [{ name: 'Authorization', value: `Bearer ${mcp.token}` }] }]
}


const configOptionsOf = (options, category) => options.find(option => (option.category ?? option.id) === category)
const textOf = content => (Array.isArray(content) ? content : [content]).filter(block => block?.type === 'text').map(block => block.text).join('')
const planText = entries => (entries ?? []).map(entry => `- ${entry.content ?? entry.title ?? ''}`).join('\n')
const mergeCall = (known, update) => ({
  ...known,
  ...Object.fromEntries(Object.entries(update).filter(([key, value]) => key !== 'sessionUpdate' && value !== undefined && value !== null)),
})
const callOf = (session, toolCall) => mergeCall(toolCall?.toolCallId === undefined ? undefined : session.toolCalls.get(toolCall.toolCallId), toolCall ?? {})
// ACP tool kinds that change files or run something.
const CHANGE_KINDS = new Set(['edit', 'delete', 'move', 'execute'])
const VERBS = { read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run', think: 'Think', fetch: 'Fetch' }
const inputOf = call => (call.rawInput !== null && typeof call.rawInput === 'object' ? call.rawInput : {})
// One line a person can act on: what kind of action, on what.
export const describeCall = (call) => {
  const input = inputOf(call)
  const command = input.command ?? input.cmd ?? input.CommandLine
  const target = typeof command === 'string' ? `\`${command.length > 160 ? `${command.slice(0, 157)}…` : command}\``
    : (call.locations ?? []).map(location => location?.path).filter(Boolean).join(', ')
      || input.path || input.file_path || input.Path || input.TargetFile || input.url || input.query || input.pattern || ''
  const verb = VERBS[call.kind]
  const title = typeof call.title === 'string' && call.title.trim() !== '' ? call.title.trim() : undefined
  const rawTarget = String(target).replaceAll('`', '')
  if (title !== undefined && (target === '' || (title.includes(rawTarget) && (verb === undefined || title !== rawTarget)))) return title
  if (verb !== undefined && target !== '') return `${verb} ${target}`
  return [title ?? verb ?? 'Use a tool', target].filter(Boolean).join(': ')
}
// What the card adds under its one-line action: the call's other inputs, one
// per line; what the action line already says is not repeated.
const detailText = (call, action = '') => {
  const lines = Object.entries(inputOf(call))
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
    .filter(([, value]) => !action.includes(value))
    .map(([key, value]) => `${key}: ${value}`)
  const paths = (call.locations ?? []).map(location => location?.path).filter(path => path && !action.includes(path))
  if (paths.length > 0) lines.push(paths.join(', '))
  return lines.join('\n').slice(0, 4_000)
}
// A prompt's usage. Some CLIs fold cached input into inputTokens (Devin: totalTokens is
// inputTokens + outputTokens), while others (Antigravity) count cachedReadTokens apart.
export const usageOf = (usage) => {
  if (typeof usage?.inputTokens !== 'number' && typeof usage?.outputTokens !== 'number') return undefined
  const read = usage.cachedReadTokens ?? 0
  const write = usage.cachedWriteTokens ?? 0
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  const separate = typeof usage.totalTokens === 'number' && read + write > 0 && usage.totalTokens >= input + read + write + output
  return {
    inputTokens: !separate && read + write <= input ? input - read - write : input,
    outputTokens: output,
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(usage.thoughtTokens ? { reasoningTokens: usage.thoughtTokens } : {}),
  }
}
const compactionStatus = status => (status === 'completed' ? 'completed' : status === 'started' || status === 'in_progress' ? 'started' : 'failed')

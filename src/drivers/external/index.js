import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ownProcess } from './owned-process.js'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AcpEngine } from './acp.js'
import { ClaudeEngine } from './claude.js'
import { CodexEngine } from './codex.js'
import { cleanEnv, findExecutable, probeVersion } from './discover.js'

const backends = {
  codex: { Engine: CodexEngine, command: 'codex', args: ['app-server', '--listen', 'stdio://'] },
  claude: { Engine: ClaudeEngine, command: 'claude', args: [] },
  antigravity: { Engine: AcpEngine, command: 'agy', args: ['acp'] },
  acp: { Engine: AcpEngine, args: [] },
}

// Measured with live-control.mjs: a changed MCP argument was observed before
// the original turn finished. A changed binary version requires a new probe.
const testedSteer = { claude: '2.1.328' }

async function qualified(kind, executable, config) {
  if (kind === 'codex') return true
  if (!['antigravity', 'claude'].includes(kind)) return false
  const evidence = config.steerQualification
  const versionWanted =
    evidence === undefined
      ? !config.command && !config.args
        ? testedSteer[kind]
        : undefined
      : evidence.verified === true && evidence.evidence
        ? evidence.version
        : undefined
  if (!versionWanted) return false
  const version = await probeVersion(executable, config.versionArgs ?? ['--version'], cleanEnv(config.env))
  return (
    version.ok && version.version?.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/u)?.[1] === versionWanted
  )
}

function answerQuestions(questions, answer) {
  const values = typeof answer === 'string' && questions.length === 1 ? { [questions[0].id]: answer } : answer
  if (!values || typeof values !== 'object') throw new Error('An answer is required for each question')
  return Object.fromEntries(
    questions.map(({ id }) => {
      const value = values[id]
      const answers = typeof value === 'string' ? [value] : (value?.answers ?? value)
      if (
        !Array.isArray(answers) ||
        !answers.length ||
        answers.some((text) => typeof text !== 'string' || !text.trim())
      ) {
        throw new Error('Missing answer to ' + id)
      }
      return [id, { answers }]
    }),
  )
}

function selectOption(options, decision) {
  const native = options.find((option) => option.optionId === decision)
  if (native) return native.optionId
  const kind = decision === 'allow' ? 'allow_once' : decision === 'deny' ? 'reject_once' : undefined
  const picked = kind && options.find((option) => option.kind === kind)
  if (!picked) throw new Error('Choose one of the options offered by the agent')
  return picked.optionId
}

// config and spawn are host-owned launch settings. Never accept them from team tools or a chat message.
export async function openExternal({ kind, cwd, resumeId, onEvent, mcp, config = {}, spawn, memberId, sandboxLaunch }) {
  const backend = backends[kind]
  if (!backend) throw new Error('Unsupported external agent: ' + kind)
  if (config.readOnly === true && kind !== 'codex')
    throw new Error('A native read-only workspace requires Codex')
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
    throw new Error('A local workspace directory is required')
  const command = sandboxLaunch?.command ?? config.command ?? backend.command
  const executable = command && findExecutable(command)
  if (!executable) throw new Error('Local agent executable not found: ' + (command ?? kind))
  if (sandboxLaunch) mcp = sandboxLaunch.mcp
  if (mcp) {
    const endpoint = new URL(mcp.url)
    if (
      endpoint.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) ||
      !mcp.token
    ) {
      throw new Error('The team tool endpoint must be an authenticated HTTP loopback service')
    }
  }
  const processOwner = ownProcess(sandboxLaunch?.spawn ?? spawn)
  const spec = {
    name: kind,
    readOnly: config.readOnly === true,
    command: executable,
    args: sandboxLaunch ? backend.args : config.args ?? backend.args,
    env: sandboxLaunch ? undefined : config.env,
    spawnCwd: cwd,
    spawn: processOwner.launch,
  }
  const engine = new backend.Engine(kind, spec, { findExecutable })
  const isAcp = backend.Engine === AcpEngine
  const steerSupported = sandboxLaunch ? kind === 'codex' : await qualified(kind, executable, config)
  let session
  try {
    session = await engine.open(memberId ?? randomUUID(), {
      cwd: sandboxLaunch?.guestCwd ?? cwd,
      mcp,
      resumeId: resumeId || undefined,
      model: config.model ?? undefined,
      mode: kind === 'codex' && ['plan', 'default'].includes(config.mode) ? undefined : config.mode,
      instructions: config.instructions,
      system: config.instructions,
    })
    if (sandboxLaunch && isAcp && mcp && engine.caps.mcpMode === 'none')
      throw new Error('The sandbox agent could not attach its scoped team tools')
  } catch (error) {
    await processOwner.stop(true)
    await engine.close()
    throw error
  }
  let nativeId = session.threadId ?? session.acpSessionId ?? session.cliSessionId ?? resumeId
  const capabilities = {
    steer: steerSupported,
    interrupt: true,
    resume: !isAcp || engine.caps.resume || engine.caps.load,
    permission: true,
    question: !isAcp,
    teamTools: Boolean(mcp) && (!isAcp || engine.caps.mcpMode !== 'none'),
  }
  let active
  let closed = false
  let configuring = false
  let lost
  const interactions = new Map()

  function emit(event) {
    if (mcp?.token) {
      // A locally configured CLI can echo its MCP configuration in tool or error
      // output. The session credential must never reach the persistent timeline.
      const value = JSON.stringify(event)
      const clean = value.replaceAll(mcp.token, '[redacted]').replace(/gbturn_[a-f0-9]{48}/g, '[redacted]')
      if (clean !== value) event = JSON.parse(clean)
    }
    return onEvent?.(event)
  }
  const assertTurn = (turnId) => {
    if (closed || lost || !active || active.id !== turnId)
      throw new Error('The selected turn is no longer running')
    return active
  }
  function dismissRequests() {
    for (const [id, item] of interactions) {
      interactions.delete(id)
      Promise.resolve(item.reply(null)).catch(() => {})
    }
  }
  function finish(turn, event) {
    if (turn !== active) return
    active = undefined
    dismissRequests()
    emit({ ...event, turnId: turn.id })
  }
  function receive(event) {
    if (closed) return
    if (event.type === 'session') {
      nativeId = event.nativeId
      emit({ type: 'session', nativeId })
      return
    }
    const turn = active
    if (event.type === 'error' && session.dead) lost = event.error
    if (!turn) {
      if (event.reply) Promise.resolve(event.reply(null)).catch(() => {})
      if (lost) emit({ type: 'error', status: 'disconnected', deliveryUnknown: true, text: lost.message })
      return
    }
    // Codex publishes notifications in the stdout batch containing turn/start's reply.
    // Bind the reply's id before attributing any of those notifications to a local turn.
    if (kind === 'codex' && !turn.native && event.turnId) {
      turn.early.push(event)
      return
    }
    if (event.turnId && turn.native && event.turnId !== turn.native) {
      if (event.reply) Promise.resolve(event.reply(null)).catch(() => {})
      return
    }
    if (event.type === 'error') {
      finish(turn, {
        type: 'error',
        status: session.dead ? 'lost' : 'failed',
        deliveryUnknown: session.dead || event.error?.deliveryUnknown === true,
        text: event.error?.message ?? 'Agent failed',
      })
    } else if (event.type === 'done') {
      const status = ['interrupted', 'cancelled', 'canceled'].includes(event.reason)
        ? 'interrupted'
        : 'completed'
      finish(turn, { type: 'done', status, reason: event.reason, ...(event.usage ? { usage: event.usage, usageId: 'result' } : {}) })
    } else if (event.type === 'usage') {
      emit({ type: 'usage', turnId: turn.id, usage: event.usage, usageId: event.usageId ?? String(++turn.usageCount) })
    } else if (event.type === 'permission' || event.type === 'question') {
      const requestId = event.id
      interactions.set(requestId, event)
      emit({
        type: event.type,
        turnId: turn.id,
        requestId,
        text: event.action ?? event.questions?.map((q) => q.question).join('\n'),
        details: event.detail,
        options: event.options,
        questions: event.questions,
      })
    } else if (event.type === 'text' || event.type === 'tool') {
      if (!turn.seen) {
        turn.seen = true
        emit({ type: 'started', turnId: turn.id, nativeTurnId: turn.native })
      }
      emit({ ...event, turnId: turn.id, nativeTurnId: turn.native })
    } else if (event.type === 'started' || event.type === 'accepted') {
      if (event.type === 'started' && turn.seen) return
      if (event.type === 'started') turn.seen = true
      emit({
        type: event.type,
        turnId: turn.id,
        nativeTurnId: turn.native,
        nativeRequestId: event.requestId,
        commandId: event.commandId,
      })
    }
  }
  async function pump() {
    while (!closed) {
      const event = await session.next()
      receive(event)
      if (session.dead && event.type === 'error') break
    }
  }
  void pump().catch((error) => {
    lost = error
    if (active) finish(active, { type: 'error', status: 'lost', text: error.message })
  })
  const handle = {
    get nativeId() {
      return nativeId
    },
    capabilities,
    async slashMetadata() {
      if (closed || lost || session.dead) return
      if (kind === 'claude') {
        await session.readMetadata()
        return session.commands
      }
      if (isAcp) return engine.describe(session).commands
    },
    async describe() {
      if (closed || lost || session.dead) throw new Error('Agent session disconnected')
      return engine.describe(session)
    },
    async configure({ model, mode, effort } = {}) {
      if (active || configuring || closed || lost || session.dead)
        throw new Error('Change settings on an idle connected session')
      if (model === undefined && mode === undefined && effort === undefined)
        throw new Error('Choose a model, mode, or reasoning effort')
      configuring = true
      try {
        const current = await engine.describe(session)
        if (model === null && !current.canResetModel)
          throw new Error('This agent cannot restore the CLI default model')
        if (
          model != null &&
          (!current.canSetModel || !current.models.some((m) => m.id === model || m.resolvedModel === model))
        )
          throw new Error('Model is not selectable on this session')
        if (
          mode !== undefined &&
          (!current.canSetMode || !current.modes.some((m) => m.id === mode && m.selectable))
        )
          throw new Error('Mode is not selectable on this session')
        if (effort === null && model === undefined && !current.canResetEffort)
          throw new Error('This agent cannot restore the CLI default effort')
        if (model === undefined && effort != null && !current.canSetEffort)
          throw new Error('Reasoning effort is unavailable for this model')
        if (
          model === null ||
          effort !== undefined ||
          (model && model !== current.currentModel) ||
          (mode && mode !== current.currentMode)
        ) {
          await engine.configure(session, { model, mode, effort })
        }
        return await engine.describe(session)
      } catch (error) {
        error.actualOptions = await Promise.resolve()
          .then(() => engine.describe(session))
          .catch(() => undefined)
        throw error
      } finally {
        configuring = false
      }
    },
    async setMode(mode) {
      return handle.configure({ mode })
    },
    async start({ turnId, text, commandId, teamTurnKey }) {
      if (!turnId || (!Array.isArray(text) && (typeof text !== 'string' || !text.trim())))
        throw new Error('A turn ID and prompt are required')
      if (closed || lost || session.dead) throw new Error('Agent disconnected; reopen its session')
      if (active || configuring) throw new Error('A turn is already running or settings are being applied')
      const turn = (active = { id: turnId, early: [], usageCount: 0 })
      const blocks = Array.isArray(text) ? [...text] : [{ type: 'text', text }]
      if (teamTurnKey && capabilities.teamTools) blocks.push({ type: 'text',
        text: '[NativeCrew team tools] For send_message, assign_task, and report_result in this turn, pass turnContext=' + teamTurnKey + '. Keep it out of messages and reports.' })
      try {
        if (isAcp) {
          void engine.prompt(session, blocks, {}).catch((error) => {
            if (active === turn)
              finish(turn, {
                type: 'error',
                text: error.message,
                deliveryUnknown: error.deliveryUnknown === true,
              })
          })
          return { status: 'submitted' }
        }
        const id = await engine.prompt(session, blocks, { commandId })
        if (kind === 'codex' && active === turn) {
          if (!id) throw new Error('Codex did not return a turn ID')
          turn.native = id
          emit({ type: 'accepted', turnId, nativeTurnId: id })
          for (const event of turn.early) receive(event)
          turn.early.length = 0
        } else if (kind === 'claude' && active === turn && id) {
          // Claude names the prompt as it writes it: a turn the CLI ran by itself, or
          // an earlier prompt's late end, carries another name and answers nothing here.
          turn.native = id
        }
        return { status: kind === 'codex' ? 'accepted' : 'written' }
      } catch (error) {
        if (active === turn)
          finish(turn, {
            type: 'error',
            text: error.message,
            deliveryUnknown: error.deliveryUnknown === true,
          })
        throw error
      }
    },
    async steer({ turnId, text, commandId }) {
      const turn = assertTurn(turnId)
      if (!capabilities.steer) throw new Error('In-turn input is unavailable for this agent version')
      if (kind === 'codex' && (!turn.native || session.turnId !== turn.native))
        throw new Error('The selected Codex turn is no longer active')
      if (isAcp && !session.running) throw new Error('ACP prompt is no longer active')
      if (isAcp) {
        // Here the RPC may resolve only at the end of the agent's work. Leave the
        // host command queue free for interrupts and pending permission answers.
        const response = engine.steer(session, text)
        void response.then(
          () => {
            if (!closed) emit({ type: 'accepted', turnId, commandId })
          },
          (error) => {
            if (!closed)
              emit({
                type: 'delivery_error',
                turnId,
                commandId,
                text: error.message,
                deliveryUnknown: error.deliveryUnknown === true,
              })
          },
        )
        return { status: 'written' }
      }
      await engine.steer(session, text, { commandId })
      return { status: kind === 'claude' ? 'written' : 'accepted' }
    },
    async interrupt({ turnId }) {
      const turn = assertTurn(turnId)
      if (kind === 'codex' && (!turn.native || session.turnId !== turn.native))
        throw new Error('The selected Codex turn is no longer active')
      await engine.cancel(session)
      if (active === turn) dismissRequests()
      return { status: kind === 'codex' ? 'accepted' : 'written' }
    },
    async respond({ requestId, decision, answer }) {
      const item = interactions.get(requestId)
      if (!item || !active) throw new Error('This interaction has already ended')
      const payload =
        item.type === 'question'
          ? answerQuestions(item.questions, answer)
          : selectOption(item.options, decision)
      interactions.delete(requestId)
      await item.reply(payload)
      return { status: 'submitted' }
    },
    async forceClose() {
      closed = true
      dismissRequests()
      await processOwner.stop(true)
      await engine.close()
    },
    async close() {
      if (!closed) {
        closed = true
        if (active) {
          await processOwner.remember()
          await Promise.race([Promise.resolve(engine.cancel(session)).catch(() => {}), delay(300)])
        }
        dismissRequests()
      }
      await processOwner.stop(false)
      await engine.close()
    },
  }
  const mode =
    config.mode && (isAcp || (kind === 'codex' && ['plan', 'default'].includes(config.mode)))
      ? config.mode
      : undefined
  const resetModel = config.model === null && Boolean(resumeId)
  if (mode || config.effort !== undefined || resetModel) {
    try {
      const described = await handle.describe()
      // On a fresh, non-thinking CLI there is no previous effort override to clear.
      const effort =
        config.effort === null && (!resumeId || !described.canResetEffort) && !resetModel
          ? undefined
          : config.effort
      if (mode || effort !== undefined || resetModel)
        await handle.configure({ mode, effort, ...(resetModel ? { model: null } : {}) })
    } catch (error) {
      await handle.close()
      throw error
    }
  }
  return handle
}

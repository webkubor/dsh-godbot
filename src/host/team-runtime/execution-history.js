import { chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshShellOutcome } from '../../drivers/dsh-tool-receipt.js'
import { readAntigravityToolResult } from './antigravity-tool-result.js'
import { readClaudeExecutionHistory } from './claude-execution-history.js'
import { bindToolSlots, mirroredTools, readToolActivity, toolSlots } from './shared/tool-timeline.js'

const fieldLimit = 256 * 1024
const turnPageSize = 12
const toolDetails = ['input', 'output', 'changes', 'error']
const persistedFields = ['name', 'status', 'text', 'layout', 'cwd', 'exitCode', 'durationMs', 'locations', 'parentId', ...toolDetails]
const now = () => new Date().toISOString()
const eventTime = event => Number.isFinite(event.time) ? new Date(event.time).toISOString() : now()
const chronological = (a, b) => b.startedAt.localeCompare(a.startedAt) || (b.nativeOrder ?? 0) - (a.nativeOrder ?? 0) || String(b.turn).localeCompare(String(a.turn))
const textBlocks = content => typeof content === 'string' ? content : !Array.isArray(content) ? '' :
  content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n')

function redact(value, clean) {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map(item => redact(item, clean))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, clean)]))
  return value
}

function protect(rt, row) {
  // A secret broker result itself is never a useful tool receipt for display.
  if (/(?:^|__)request_secret$/u.test(row.name ?? '')) delete row.output
  if (rt.redactSecrets) {
    for (const key of ['name', 'text', 'layout', 'cwd', 'locations', ...toolDetails]) {
      if (row[key] !== undefined) row[key] = redact(row[key], value => rt.redactSecrets(value))
    }
  }
  return row
}

function limitField(value) {
  if (typeof value === 'string') return [value.slice(0, fieldLimit), value.length > fieldLimit]
  const json = JSON.stringify(value)
  return json?.length > fieldLimit ? [json.slice(0, fieldLimit), true] : [value, false]
}

function mergeEvent(previous, next) {
  const row = { ...previous, type: next.type }
  const truncated = new Set(previous?.truncatedFields)
  if (next.type === 'tool') row.id = next.id
  for (const field of persistedFields) {
    if (next[field] === undefined) continue
    const [value, shortened] = limitField(next[field])
    row[field] = value
    if (shortened) truncated.add(field)
    else truncated.delete(field)
  }
  if (typeof next.outputDelta === 'string' && next.output === undefined) {
    const [output, shortened] = limitField((typeof row.output === 'string' ? row.output : '') + next.outputDelta)
    row.output = output
    if (shortened) truncated.add('output')
  }
  if (row.type === 'tool') {
    // Inspect the complete shell result before the retention limit cuts its tail.
    Object.assign(row, dshShellOutcome(row.name, row.status, next.output ?? row.output, next.shellExitCode ?? row.exitCode))
  }
  if (truncated.size) row.truncatedFields = Array.from(truncated)
  else delete row.truncatedFields
  return row
}

function summary(row) {
  if (row.type !== 'tool') return row
  const preview = { ...row, detailAvailable: toolDetails.some(key => row[key] !== undefined) }
  for (const key of toolDetails) delete preview[key]
  return preview
}

function identity(event) {
  if (event.type === 'tool') return typeof event.id === 'string' && event.id.length > 0 ? 'tool:' + event.id : undefined
  if (['text', 'input', 'error'].includes(event.type) && Number.isSafeInteger(event.seq)) return 'message:' + event.seq
}

function assistantEvent(content, seq) {
  const layout = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text)
        layout.push({ type: 'text', text: block.text })
      else if (block?.type === 'tool-call' && typeof block.id === 'string')
        layout.push({ type: 'host-tool', id: block.id })
      else if (block?.type === 'reasoning' && typeof block.text === 'string') {
        for (const line of block.text.split('\n')) {
          const activity = readToolActivity(line)
          if (activity) layout.push({ type: 'activity', ...activity })
        }
      }
    }
  }
  if (layout.some(item => item.type !== 'text') && JSON.stringify(layout).length <= fieldLimit)
    return { type: 'text', seq, layout }
  const text = textBlocks(content)
  return text ? { type: 'text', seq, text, layout: [] } : undefined
}

function turnEvent(event) {
  const data = event.data ?? {}
  switch (event.type) {
    case 'assistant/message':
      return assistantEvent(data.message?.content, event.seq)
    case 'user/message': {
      const source = data.source ?? data.message?.source
      if (source?.kind !== 'user' && !(source?.kind === 'bot' && source.role === 'request' && !source.handoff)) return
      const text = textBlocks(data.content ?? data.message?.content)
      return text ? { type: 'input', text, seq: event.seq } : undefined
    }
    case 'tool/call':
    case 'tool/ptc-dispatch-start':
      return {
        type: 'tool', id: data.subCallId ?? data.callId, name: data.name, status: 'running',
        input: data.arguments, parentId: data.subCallId ? data.callId : undefined,
      }
    case 'tool/result': {
      const message = data.message
      return {
        type: 'tool', id: message?.toolCallId ?? data.callId,
        status: message?.isError || message?.ok === false ? 'failed' : 'completed', output: message?.content,
        shellExitCode: data.meta?.exitCode,
      }
    }
    case 'tool/ptc-dispatch':
      return {
        type: 'tool', id: data.subCallId, name: data.name, parentId: data.callId, input: data.arguments,
        status: data.isError ? 'failed' : 'completed', output: data.content, shellExitCode: data.meta?.exitCode,
      }
    case 'turn/end': {
      const reason = data.reason
      return reason?.kind === 'error' || reason?.kind === 'failed' ? {
        type: 'error', text: reason.error?.message ?? reason.message ?? '执行失败', seq: event.seq,
      } : undefined
    }
  }
}

export class ExecutionHistory {
  constructor(rt, { readClaude = readClaudeExecutionHistory, readAntigravity = readAntigravityToolResult } = {}) {
    this.rt = rt
    this.readClaude = readClaude
    this.readAntigravity = readAntigravity
    this.active = new Map()
    this.nativeCache = new Map()
  }

  ownerOf(sessionId) {
    const rt = this.rt
    if (rt.groupOwners?.has(sessionId) || rt.roomOwners?.has(sessionId)) return undefined
    const past = rt.pastOwners?.get(sessionId)
    if (past?.roomId) return undefined
    return rt.chatOwners?.get(sessionId) ?? past?.botId
  }

  database() {
    if (this.db) return this.db
    const path = join(this.rt.home, 'execution.sqlite')
    mkdirSync(this.rt.home, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      db.exec(`PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS execution_turns (
          part TEXT NOT NULL, turn INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
          PRIMARY KEY(part, turn)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_events (
          seq INTEGER PRIMARY KEY, part TEXT NOT NULL, turn INTEGER NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL,
          UNIQUE(part, turn, identity)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS execution_by_turn ON execution_events(part, turn, seq);`)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    return db
  }

  close() {
    this.closed = true
    this.db?.close()
    this.db = undefined
    this.nativeCache.clear()
  }

  observe(sessionId, event) {
    if (this.closed || !this.ownerOf(sessionId)) return
    const turn = event.data?.turn ?? this.active.get(sessionId)
    if (!Number.isSafeInteger(turn)) return
    if (event.type === 'turn/start') {
      this.active.set(sessionId, turn)
      this.tryWrite(db => db.prepare('INSERT OR IGNORE INTO execution_turns(part, turn, started_at) VALUES (?, ?, ?)').run(sessionId, turn, eventTime(event)))
      return
    }
    if (event.type === 'turn/end') {
      const item = turnEvent(event)
      if (item) this.record(sessionId, item, turn)
      if (this.active.get(sessionId) === turn) this.active.delete(sessionId)
      this.tryWrite(db => {
        db.prepare('UPDATE execution_turns SET ended_at=? WHERE part=? AND turn=?').run(eventTime(event), sessionId, turn)
        if (['aborted', 'interrupted'].includes(event.data?.reason?.kind)) {
          db.prepare(`UPDATE execution_events SET data=json_set(data, '$.status', 'interrupted') WHERE part=? AND turn=?
            AND json_extract(data, '$.status') IN ('running','pending')`).run(sessionId, turn)
        }
      })
      return
    }
    const item = turnEvent(event)
    if (item) this.record(sessionId, item, turn)
  }

  tryWrite(write) {
    try { write(this.database()) } catch (error) {
      if (!this.loggedWriteFailure) {
        this.loggedWriteFailure = true
        this.rt.ctx?.logger?.warn('Could not save NativeCrew execution history: %s', error?.code ?? 'write failed')
      }
    }
  }

  record(sessionId, event, turn = this.active.get(sessionId) ?? this.rt.live?.get(sessionId)?.turn) {
    if (this.closed || !Number.isSafeInteger(turn) || !this.ownerOf(sessionId) || !event) return
    const key = identity(event)
    if (!key) return
    this.tryWrite(db => {
      const prior = db.prepare('SELECT data FROM execution_events WHERE part=? AND turn=? AND identity=?').get(sessionId, turn, key)
      const row = protect(this.rt, mergeEvent(prior && JSON.parse(prior.data), event))
      db.prepare('INSERT OR IGNORE INTO execution_turns(part, turn, started_at) VALUES (?, ?, ?)').run(sessionId, turn, now())
      db.prepare(`INSERT INTO execution_events(part, turn, identity, data) VALUES (?, ?, ?, ?)
        ON CONFLICT(part, turn, identity) DO UPDATE SET data=excluded.data`).run(sessionId, turn, key, JSON.stringify(row))
      if (event.type === 'tool') this.rt.chatTimelineChanged?.(sessionId, turn)
    })
  }

  // Chat pages refresh during streaming. Select only the fields that fit on
  // a card; file contents and shell output are read when the card is opened.
  toolSummaries(sessionId, turn) {
    if (this.closed || !this.ownerOf(sessionId)) return []
    const db = this.database()
    this.summaryQuery ??= db.prepare(`SELECT json_extract(data,'$.id') AS id, json_extract(data,'$.name') AS name,
      substr(coalesce(json_extract(data,'$.locations[0].path'), nullif(json_extract(data,'$.text'),''),
        json_extract(data,'$.input.file_path'), json_extract(data,'$.input.path')),1,400) AS text,
      json_extract(data,'$.status') AS status
      FROM execution_events WHERE part=? AND turn=? AND identity LIKE 'tool:%' ORDER BY seq`)
    return this.summaryQuery.all(sessionId, turn).map(row =>
      Object.fromEntries(Object.entries(row).filter(([, value]) => value != null)))
  }

  nativeTurns(sessionId) {
    const binding = this.rt.state.localAgents?.sessions?.[sessionId]
    if (!binding?.cwd || !binding.cliSessionId || !['local-claude-code', 'local-codex-cli'].includes(binding.route)) return Promise.resolve([])
    const key = JSON.stringify([sessionId, binding.route, binding.cwd, binding.cliSessionId])
    const cached = this.nativeCache.get(key)
    if (cached && cached.until > Date.now()) return cached.promise
    const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(binding.cwd, process.env.CLAUDE_CONFIG_DIR) : undefined
    const promise = Promise.resolve().then(() => binding.route === 'local-codex-cli'
      ? this.rt.readCodexExecutionHistory?.(binding) ?? []
      : this.readClaude({ cwd: binding.cwd, nativeId: binding.cliSessionId, configDir })).catch(() => [])
    this.nativeCache.delete(key)
    this.nativeCache.set(key, { until: Date.now() + 10_000, promise })
    if (this.nativeCache.size > 4) this.nativeCache.delete(this.nativeCache.keys().next().value)
    return promise
  }

  storedEvents(db, sessionId, turn, toolId, onlyTools) {
    const selected = typeof toolId === 'string'
      ? db.prepare('SELECT seq, data, identity FROM execution_events WHERE part=? AND turn=? AND identity=?').all(sessionId, turn, 'tool:' + toolId)
      : db.prepare(`SELECT seq, data, identity FROM execution_events WHERE part=? AND turn=?
          ${onlyTools ? "AND identity LIKE 'tool:%'" : ''} ORDER BY seq`).all(sessionId, turn)
    return selected.map(({ seq, data, identity }) => {
      const row = JSON.parse(data)
      // Older rows may already have the native shell marker but lack the exit code.
      return { seq, ...row, ...dshShellOutcome(row.name, row.status, row.output, row.exitCode),
        ...(row.type === 'text' && row.layout === undefined ? { messageSeq: Number(identity.slice('message:'.length)) } : {}) }
    })
  }

  // DSH retains the original call/result bodies for its own tools, including
  // archived parts created before the execution database existed.
  async sessionTurns(sessionId, target) {
    const controller = this.rt.ctx?.sessionController
    if (!controller?.page) return []
    const signal = AbortSignal.timeout(3500)
    const records = []
    let beforeSeq
    try {
      for (let pageNo = 0; pageNo < (target === undefined ? 2 : 12); pageNo++) {
        const page = await controller.page({ address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 80 }, signal)
        const events = page.records.map(record => record.event)
        if (events.length === 0) break
        records.unshift(...events)
        if (!page.hasMore || events.some(event => event.type === 'turn/start' && event.data?.turn <= target)) break
        beforeSeq = events[0].seq
      }
    } catch {
      return []
    }
    const turns = []
    let current
    for (const event of records) {
      if (event.type === 'turn/start') {
        current = { turn: event.data.turn, startedAt: eventTime(event), events: [] }
        if (target === undefined || current.turn === target) turns.push(current)
        else current = undefined
      } else if (current && (event.data?.turn === undefined || event.data.turn === current.turn)) {
        const row = turnEvent(event)
        if (row) current.events.push({ ...row, seq: event.seq })
        if (event.type === 'turn/end') {
          current.endedAt = eventTime(event)
          current = undefined
        }
      }
    }
    return turns
  }

  async read({ botId, sessionId, turn, toolId, beforeTurn, onlyTools } = {}) {
    const allowed = () => !this.closed && typeof botId === 'string' && typeof sessionId === 'string' &&
      this.rt.botOf(botId) && this.ownerOf(sessionId) === botId
    if (!allowed()) throw new Error('请选择该 Bot 的私聊或历史会话。')
    if (toolId !== undefined && (turn === undefined || typeof toolId !== 'string' || toolId.length > 400)) throw new Error('工具调用无效。')
    const db = this.database()
    if (Number.isSafeInteger(turn)) {
      const running = this.active.get(sessionId) === turn || this.rt.live?.get(sessionId)?.turn === turn
      let events = this.storedEvents(db, sessionId, turn, toolId, onlyTools)
      if (!running && !db.prepare('SELECT 1 FROM execution_turns WHERE part=? AND turn=?').get(sessionId, turn)) {
        const prior = (await this.sessionTurns(sessionId, turn))[0]
        const native = prior ? matchNative(prior, await this.nativeTurns(sessionId)) : undefined
        if (!allowed()) throw new Error('请选择该 Bot 的私聊或历史会话。')
        events = mergeRows(this.rt, native?.events ?? prior?.events ?? [], toolId)
      } else if (!onlyTools && !running && events.some(row => row.messageSeq !== undefined) && events.some(row => row.type === 'tool')) {
        const prior = (await this.sessionTurns(sessionId, turn))[0]
        if (!allowed()) throw new Error('请选择该 Bot 的私聊或历史会话。')
        const layouts = new Map(prior?.events.filter(row => row.layout?.length).map(row => [row.seq, row.layout]))
        events = events.map(row => layouts.has(row.messageSeq) ? protect(this.rt, mergeEvent(row, {
          type: 'text', layout: layouts.get(row.messageSeq),
        })) : row)
      }
      const tool = toolId !== undefined && events[0]
      if (tool && (tool.output == null || (tool.status === 'failed' && tool.error == null))) {
        const binding = this.rt.state.localAgents?.sessions?.[sessionId]
        const native = this.readAntigravity(binding, tool)
        if (native) events[0] = protect(this.rt, mergeEvent(tool, {
          type: 'tool', id: tool.id, output: tool.output ?? native.output, error: tool.error ?? native.error,
        }))
      }
      return { events: toolId !== undefined ? events : onlyTools
        ? events.filter(row => row.type === 'tool').map(summary)
        : orderedRows(events).map(summary), running }
    }
    const native = await this.nativeTurns(sessionId)
    if (!allowed()) throw new Error('请选择该 Bot 的私聊或历史会话。')
    if (typeof turn === 'string') {
      const selected = native.find(row => 'native:' + row.nativeTurnId === turn)
      const events = mergeRows(this.rt, selected?.events ?? [], toolId)
      return { events: toolId === undefined ? events.map(summary) : events, running: false }
    }
    if (turn !== undefined) throw new Error('回合编号无效。')
    const stored = db.prepare('SELECT turn, started_at AS startedAt, ended_at AS endedAt FROM execution_turns WHERE part=? ORDER BY turn DESC').all(sessionId)
    const storedTurns = new Set(stored.map(row => row.turn))
    const old = (await this.sessionTurns(sessionId)).filter(row => !storedTurns.has(row.turn) && row.events.length)
    if (!allowed()) throw new Error('请选择该 Bot 的私聊或历史会话。')
    const ids = new Set(db.prepare("SELECT identity FROM execution_events WHERE part=? AND identity LIKE 'tool:%'").all(sessionId).map(row => row.identity))
    const recentReports = db.prepare(`SELECT turn, data FROM execution_events WHERE part=?
      AND json_extract(data,'$.type')='text' ORDER BY seq DESC LIMIT 100`).all(sessionId)
    const reportTimes = new Map(stored.map(row => [row.turn, row.startedAt]))
    const knownReports = recentReports.map(row => ({ startedAt: reportTimes.get(row.turn), events: [JSON.parse(row.data)] }))
    const matchedNative = new Set([...old, ...knownReports].map(row => matchNative(row, native)).filter(Boolean))
    const nativeOnly = native.filter(row => !matchedNative.has(row) && !row.events.some(item => item.type === 'tool' && ids.has(identity(item))))
    const turns = stored.map(row => ({ ...row, running: this.active.get(sessionId) === row.turn }))
      .concat(old.map(({ turn, startedAt, endedAt }) => ({ turn, startedAt, endedAt, running: false })))
      .concat(nativeOnly.map((row, nativeOrder) => ({ turn: 'native:' + row.nativeTurnId, startedAt: row.startedAt ?? '', endedAt: row.endedAt,
        nativeOrder, native: true, running: false })))
      .sort(chronological)
    const previous = turns.findIndex(row => row.turn === beforeTurn)
    if (beforeTurn !== undefined && previous < 0) return { turns: [], cursor: null }
    const at = previous + 1
    const page = turns.slice(at, at + turnPageSize)
    return { turns: page, cursor: at + page.length < turns.length ? page.at(-1).turn : null }
  }
}

function matchNative(dshTurn, nativeTurns) {
  const text = dshTurn.events.filter(event => event.type === 'text').map(event => event.text ??
    (Array.isArray(event.layout) ? event.layout.findLast(part => part.type === 'text')?.text : undefined))
    .findLast(text => typeof text === 'string' && text.trim())?.trim()
  if (!text) return
  const timestamp = Date.parse(dshTurn.startedAt)
  const timeWindow = text.length >= 80 ? 5 * 60_000 : 20_000
  const matches = nativeTurns.filter(turn => Math.abs(Date.parse(turn.startedAt) - timestamp) < timeWindow &&
    turn.events.some(event => event.type === 'text' && event.text.trim() === text))
  if (matches.length === 1) return matches[0]
}

function orderedRows(events) {
  const tools = events.filter(row => row.type === 'tool')
  const byId = new Map(tools.map(row => [row.id, row]))
  const hostIds = new Set()
  const entries = []
  for (const row of events) {
    if (!Array.isArray(row.layout)) continue
    row.layout.forEach((part, index) => {
      if (part.type === 'host-tool') hostIds.add(part.id)
      if (part.type === 'activity') entries.push([`${row.seq}:${index}`, part])
    })
  }
  const mirrors = mirroredTools(tools, hostIds)
  const slots = bindToolSlots(toolSlots(entries), tools, hostIds, mirrors)
  const placed = new Set([...hostIds, ...mirrors, ...Array.from(slots.values(), slot => slot.id).filter(Boolean)])
  const seen = new Set()
  return events.flatMap(row => {
    if (row.type === 'tool' && placed.has(row.id)) return []
    if (!Array.isArray(row.layout) || !row.layout.length) return row
    return row.layout.flatMap((part, index) => {
      const seq = `${row.seq}:${index}`
      if (part.type === 'text') return { type: 'text', text: part.text, seq }
      const tool = part.type === 'host-tool' ? byId.get(part.id) : slots.get(seq)
      if (!tool || (tool.id && seen.has(tool.id))) return []
      if (tool.id) seen.add(tool.id)
      return { ...tool, type: 'tool', seq }
    })
  })
}

function mergeRows(rt, events, toolId) {
  const rows = new Map()
  for (const event of events) {
    if (toolId !== undefined && (event.type !== 'tool' || event.id !== toolId)) continue
    const key = identity(event)
    if (!key) continue
    const prior = rows.get(key)
    rows.set(key, protect(rt, { seq: prior?.seq ?? event.seq, ...mergeEvent(prior, event) }))
  }
  return Array.from(rows.values())
}

export function install(rt) {
  const history = rt.executionHistory = new ExecutionHistory(rt)
  rt.ctx.on('session/event', (session, event) => history.observe(session.id, event))
  rt.ctx.effect(() => () => history.close(), 'NativeCrew Bot execution history')
}

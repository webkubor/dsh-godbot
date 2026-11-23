import { randomUUID } from 'node:crypto'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import { assessRemoteUrl, runRemoteAgent } from './ag-ui-stream.js'

const ROUTE_PREFIX = 'ag-ui-'
const MODEL = 'default'
const idFor = () => randomUUID().replaceAll('-', '')
const secretName = id => 'GODBOT_REMOTE_' + id.toUpperCase()
const credentialOf = entry => secretName(entry.credentialId ?? entry.id)
const bookFor = sessionId => 'remote-agent-' + sessionId
const MAX_TEXT = 256_000
const MAX_HISTORY = 64_000

export function remoteMessages(messages, redact) {
  let size = 0
  const outgoing = []
  for (const message of messages.slice(-100).reverse()) {
    if (!['user', 'assistant'].includes(message?.role) || message.source?.kind === 'runtime-context') continue
    const plain = typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (!plain) continue
    const content = redact(plain).slice(0, Math.max(0, MAX_HISTORY - size))
    if (!content) break
    size += content.length
    outgoing.unshift({ id: String(message.id ?? idFor()), role: message.role, content })
  }
  return outgoing
}

function protectCredential(part, text, token) {
  const combined = part.pending + text
  part.pending = ''
  if (!token) return combined
  const cleaned = combined.replaceAll(token, '[redacted]')
  let length = Math.min(token.length - 1, cleaned.length)
  while (length > 0 && !token.startsWith(cleaned.slice(-length))) length -= 1
  if (length === 0) return cleaned
  part.pending = cleaned.slice(-length)
  return cleaned.slice(0, -length)
}

function error(note) {
  return new LlmError(note, 'GODBOT_REMOTE_ERROR')
}

export class RemoteAgentAdapter extends LlmAdapter {
  constructor(rt, find, options) {
    super()
    this.rt = rt
    this.find = find
    this.options = options
    this.active = new Map()
  }

  providerInfo(route) {
    return { id: route, name: this.find(route)?.name ?? '远程 Agent' }
  }

  async listModels(route) {
    const row = this.find(route)
    return row ? [{ provider: route, id: MODEL, name: row.name, inputModalities: ['text'] }] : []
  }

  async resolveModel(provider, model) {
    if (model !== MODEL || !this.find(provider)) throw error('远程 Agent 已移除或模型不存在')
    return { provider, id: model, name: this.find(provider).name, inputModalities: ['text'] }
  }

  async *stream(opts) {
    const entry = this.find(opts.provider)
    if (!entry || opts.model !== MODEL) throw error('远程 Agent 已移除')
    await this.rt.loadSecrets()
    const redact = text => this.rt.redactSecrets(text)
    const messages = remoteMessages(opts.messages ?? [], redact)
    if (opts.purpose === 'session-title' || opts.purpose === 'compaction') {
      const text = opts.purpose === 'session-title'
        ? messages.find(message => message.role === 'user')?.content.split('\n')[0]?.slice(0, 80) || '远程 Agent'
        : messages.map(({ role, content }) => role + ': ' + content).join('\n\n').slice(-12_000)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const sessionId = opts.sessionId
    const bot = this.rt.botOf(this.rt.selfOf(sessionId))
    if (!bot || ![bot.model, bot.appliedModel].includes(opts.provider + '/' + MODEL) || opts.purpose !== undefined || opts.system !== undefined) {
      throw error('请从选择了该远程 Agent 的 Bot 会话运行')
    }
    if (!messages.some(message => message.role === 'user')) throw error('远程 Agent 需要文字消息')
    if (this.active.has(sessionId)) throw error('此会话已有远程运行')
    if (this.rt.readOnly()) throw error(this.rt.readOnly())
    const { url, allowed } = assessRemoteUrl(entry.endpoint, this.options.allowPrivateOrigins)
    await this.rt.governance?.remote(sessionId, url.origin, opts.signal)
    const token = entry.usesToken ? this.rt.secretValue(credentialOf(entry)) : undefined
    if (entry.usesToken && !token) throw error('请先解锁或更新远程 Agent 凭据')
    const stop = new AbortController()
    if (this.active.has(sessionId)) throw error('此会话已有远程运行')
    this.active.set(sessionId, stop)
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(this.options.timeoutMs), ...(opts.signal ? [opts.signal] : [])])
    const input = { threadId: String(sessionId), runId: randomUUID(), messages, state: {}, tools: [], context: [], forwardedProps: {} }
    const book = bookFor(sessionId)
    let seq = this.rt.ledger.lastSeq(book)
    const record = async (kind, fields = {}) => {
      this.rt.ledger.append(book, { seq: ++seq, time: Date.now(), kind, runId: input.runId, agentId: entry.id, ...fields })
      await this.rt.ledger.written(book)
    }
    let size = 0
    let events = 0
    let ended = false
    const parts = new Map()
    try {
      await record('submitted')
      for await (const event of runRemoteAgent({ endpoint: url, token, input, signal, allowPrivate: allowed, request: this.options.request })) {
        if (event.kind === 'text') {
          if ((size += event.text.length) > MAX_TEXT) throw new Error('远程 Agent 输出超过限制')
          let part = parts.get(event.id)
          if (!part) {
            if (parts.size >= 100) throw new Error('远程 Agent 消息数超过限制')
            part = { index: parts.size, text: '', pending: '' }
            parts.set(event.id, part)
            yield { type: 'block-start', index: part.index, blockType: 'text' }
          }
          const text = redact(protectCredential(part, event.text, token))
          if (text) {
            part.text += text
            yield { type: 'text-delta', index: part.index, text }
          }
        } else if (event.kind === 'finished' || events++ < 240) {
          await record(event.kind, event.tool ? { tool: event.tool } : {})
        }
      }
      for (const { index, text, pending } of parts.values()) {
        if (pending) yield { type: 'text-delta', index, text: redact(pending) }
        yield { type: 'block-end', index, block: { type: 'text', text: redact(text + pending) } }
      }
      ended = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    } catch (failure) {
      ended = true
      const canceled = opts.signal?.aborted || stop.signal.aborted
      const detail = canceled ? '已停止读取，远端结果待核对' : redact(String(failure.message ?? failure)).slice(0, 400)
      await record(canceled ? 'disconnected' : 'failed', { detail }).catch(() => {})
      if (canceled) throw opts.signal?.reason ?? stop.signal.reason
      throw error(detail)
    } finally {
      if (!ended) await record('disconnected', { detail: '已停止读取，远端结果待核对' }).catch(() => {})
      this.active.delete(sessionId)
    }
  }

  dispose() {
    for (const controller of this.active.values()) controller.abort(new Error('NativeCrew 已关闭'))
  }
}

export function install(rt) {
  const entries = () => rt.state.remoteAgents ?? []
  const find = route => entries().find(row => ROUTE_PREFIX + row.id === route)
  const options = {
    allowPrivateOrigins: Array.isArray(rt.config.remoteAgents?.allowPrivateOrigins) ? rt.config.remoteAgents.allowPrivateOrigins : [],
    timeoutMs: Math.min(900_000, Math.max(5_000, Number(rt.config.remoteAgents?.timeoutMs) || 180_000)),
  }
  const adapter = new RemoteAgentAdapter(rt, find, options)
  let registration
  let closed = false
  const sync = () => {
    if (closed) return
    const routes = entries().map(row => ROUTE_PREFIX + row.id)
    if (registration) registration.replace(routes)
    else if (routes.length) registration = rt.ctx.get?.('llm')?.registerAdapter(routes, adapter)
  }
  void rt.load().then(sync).catch(failure => rt.warn('godbot: remote agents: %s', failure.message))
  rt.ctx.effect(() => () => {
    closed = true
    adapter.dispose()
    registration?.()
  }, 'NativeCrew remote agents')

  let saving = Promise.resolve()
  async function handle(req) {
    await rt.load()
    const { action } = req
    if (action === 'remote-agents.events') {
      if (typeof req.sessionId !== 'string' || !rt.botOf(rt.selfOf(req.sessionId) ?? rt.pastOwners.get(req.sessionId)?.botId)) throw new Error('未知的 Bot 会话')
      const book = bookFor(req.sessionId)
      const after = Number.isSafeInteger(req.after) && req.after >= 0 ? req.after : null
      const rows = after === null ? rt.ledger.records(book).slice(-80) : rt.ledger.after(book, after).slice(0, 80)
      return { version: 1, cursor: rows.at(-1)?.seq ?? after ?? 0, events: rows }
    }
    const view = () => ({ version: 1, agents: entries().map(({ id, name, endpoint, usesToken }) => ({
      id, name, endpoint, usesToken, route: ROUTE_PREFIX + id + '/' + MODEL,
    })) })
    if (action === 'remote-agents.list') return view()
    const run = saving.then(async () => {
      const previous = req.id ? entries().find(row => row.id === req.id) : undefined
      if (req.id && !previous) throw new Error('远程 Agent 已不存在')
      if (action === 'remote-agents.remove') {
        const route = ROUTE_PREFIX + previous?.id + '/' + MODEL
        if (!previous) throw new Error('请选择远程 Agent')
        if (Object.values(rt.state.bots).some(bot => [bot.model, bot.appliedModel].includes(route))) throw new Error('请先更换使用此远程 Agent 的 Bot')
        const before = entries()
        rt.state.remoteAgents = before.filter(row => row.id !== previous.id)
        try { await rt.save({ required: true }) }
        catch (failure) { rt.state.remoteAgents = before; throw failure }
        sync()
        if (previous.usesToken) await rt.secretEndpoint('secret-delete', { name: credentialOf(previous) }).catch(() => {})
        return view()
      }
      if (action !== 'remote-agents.save') throw new Error('未知的远程 Agent 操作')
      const name = typeof req.name === 'string' ? req.name.trim() : ''
      if (!name || name.length > 100) throw new Error('请输入 1 至 100 字的远程 Agent 名称')
      const { url } = assessRemoteUrl(req.endpoint, options.allowPrivateOrigins)
      const token = req.token
      if (token !== undefined && (typeof token !== 'string' || token.length > 4096 || /[\u0000-\u001f\u007f]/.test(token))) throw new Error('无效的远程 Agent 凭据')
      if (previous?.usesToken && previous.endpoint !== url.href && token === undefined) throw new Error('变更执行地址时请重新填写凭据，或明确选择清除')
      const id = previous?.id ?? idFor()
      if (!previous && entries().length >= 80) throw new Error('远程 Agent 目录已满')
      const usesToken = token === undefined ? !!previous?.usesToken : token.length > 0
      const credentialId = token ? idFor() : usesToken ? previous?.credentialId ?? previous?.id : undefined
      if (token) await rt.secretEndpoint('secret-set', { name: secretName(credentialId), purpose: '远程 Agent · ' + name, value: token, scope: [] })
      const before = entries()
      const item = { id, name, endpoint: url.href, usesToken, ...(credentialId ? { credentialId } : {}) }
      rt.state.remoteAgents = previous ? before.map(row => row.id === id ? item : row) : [...before, item]
      try { await rt.save({ required: true }) }
      catch (failure) {
        rt.state.remoteAgents = before
        if (token) await rt.secretEndpoint('secret-delete', { name: secretName(credentialId) }).catch(() => {})
        throw failure
      }
      sync()
      if (previous?.usesToken && token !== undefined) await rt.secretEndpoint('secret-delete', { name: credentialOf(previous) }).catch(() => {})
      await rt.catalog?.({ fresh: true })
      return view()
    })
    saving = run.catch(() => {})
    return run
  }
  Object.assign(rt, { remoteAgentEndpoint: handle, isRemoteAgentRef: ref => typeof ref === 'string' && ref.startsWith(ROUTE_PREFIX) })
}

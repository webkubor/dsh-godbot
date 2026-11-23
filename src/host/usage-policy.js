import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BotBudget } from './bot-budget.js'

import { foldCalls } from './team-runtime/core/usage.js'
const limitKeys = ['dailyTokens', 'monthlyTokens', 'dailyUsd', 'monthlyUsd']
const quotas = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
const perMillion = 1_000_000

function totals() {
  return { tokens: 0, estimatedUsd: 0, calls: 0, unpricedCalls: 0, unreported: 0 }
}
function sum(target, row, rate) {
  if (row.missing) {
    target.unreported++
    return
  }
  const input = row.input + row.cacheRead + row.cacheWrite
  target.tokens += input + row.output
  target.calls++
  if (rate) target.estimatedUsd += (input * rate.input + row.output * rate.output) / perMillion
  else target.unpricedCalls++
}
function numeric(value, integer = false) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error('Budget values must be finite nonnegative numbers')
  return value
}
const modelRef = (provider, model) => provider + '/' + model
const validRoute = (selection) =>
  typeof selection?.provider === 'string' &&
  selection.provider.length > 0 &&
  typeof selection.model === 'string' &&
  selection.model.length > 0 &&
  !selection.provider.startsWith('local-')

export class UsagePolicy {
  constructor(service, clock = Date.now) {
    this.service = service
    this.store = service.store
    this.clock = clock
    this.folds = new Map()
    this.selected = new Map()
  }

  owner(id) {
    if (!id) return
    const rt = this.service.runtime
    if (rt?.isBotSession(id)) return rt.selfOf(id)
  }

  configure(subject, inputs) {
    const settings = { id: subject }
    for (const key of limitKeys)
      if (inputs[key] != null) settings[key] = numeric(inputs[key], key.endsWith('Tokens'))
    if (inputs.stops != null && !['unattended', 'all'].includes(inputs.stops))
      throw new Error('Invalid budget stop mode')
    settings.stops = inputs.stops ?? 'unattended'
    if (inputs.backup) {
      if (subject === 'profile' || !validRoute(inputs.backup))
        throw new Error('Choose a Bot and an API backup route')
      const bot = this.service.runtime?.botOf(subject)
      if ((bot?.model ?? bot?.appliedModel)?.startsWith('local-'))
        throw new Error('自动接管需要可确认尚未执行工具的 API 模型。此成员使用本机 CLI。')
      settings.backup = { provider: inputs.backup.provider, model: inputs.backup.model }
    }
    if (subject === 'profile') {
      settings.rates = {}
      for (const [model, rate] of Object.entries(inputs.rates ?? {})) {
        if (!model.includes('/')) throw new Error('Use provider/model for a price')
        settings.rates[model] = { input: numeric(rate.input), output: numeric(rate.output) }
      }
    }
    const saved = this.store.put('usagePolicy', settings)
    this.botBudget?.changed()
    return saved
  }

  snapshot(subject) {
    const time = this.clock(),
      date = new Date(time)
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
    const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    const rates = this.store.get('usagePolicy', 'profile')?.rates ?? {}
    const daily = totals(),
      monthly = totals(),
      models = new Map()
    const rows = new Map()
    // NativeCrew journals each model attempt under Session#turn:step:attempt. The
    // live overlay uses its exact key while that journal's asynchronous scan catches up.
    const rt = this.service.runtime
    const ledgerPath = rt?.home && join(rt.home, 'usage.sqlite')
    if (!this.ledger && ledgerPath && existsSync(ledgerPath))
      this.ledger = new DatabaseSync(ledgerPath, { readOnly: true })
    if (this.ledger?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls'").get()) {
      const found = this.ledger
        .prepare(
          'SELECT c.key AS id, c.time, c.input, c.output, c.cache_read AS cacheRead, c.cache_write AS cacheWrite, c.provider, c.model, c.session, o.owner FROM calls c LEFT JOIN owners o ON c.session=o.session WHERE c.time >= ?',
        )
        .all(start)
      for (const row of found) {
        const owner = row.owner ?? this.owner(row.session)
        if (owner) rows.set(row.id, { ...row, owner })
      }
    }
    for (const row of this.store.all('usageReceipts')) if (row.time >= start) rows.set(row.id, row)
    for (const row of rows.values()) {
      if (row.time > time || (subject !== 'profile' && row.owner !== subject)) continue
      const ref = modelRef(row.provider ?? '', row.model ?? '')
      const rate = rates[ref]
      if (!models.has(ref)) models.set(ref, totals())
      sum(models.get(ref), row, rate)
      sum(monthly, row, rate)
      if (row.time >= day) sum(daily, row, rate)
    }
    const fallback = this.store
      .all('usageQuotaHolds')
      .filter((hold) => hold.owner === subject)
      .map(({ from, backup, until, code, recoveredAt }) => ({
        from,
        backup,
        until,
        code,
        recoveredAt,
        active: until > time && !recoveredAt,
      }))
    return {
      subject,
      daily,
      monthly,
      deferred: this.botBudget?.view(subject) ?? [],
      models: Object.fromEntries(models),
      fallback,
      settings: this.store.get('usagePolicy', subject) ?? { id: subject },
      dayReset: day + 86400000,
      monthReset: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
    }
  }

  refusal(subject, unattended) {
    for (const id of new Set(['profile', subject])) {
      const settings = this.store.get('usagePolicy', id)
      if (!settings || (!unattended && settings.stops !== 'all') || !limitKeys.some((key) => settings[key] > 0))
        continue
      let view
      try {
        view = this.snapshot(id)
      } catch (cause) {
        return {
          subject: id,
          limit: 'usage-unavailable',
          reason: cause.message,
          resetsAt: this.clock() + 10_000,
        }
      }
      const { daily, monthly, dayReset, monthReset } = view
      for (const key of limitKeys) {
        const period = key.startsWith('daily') ? daily : monthly
        if (settings[key] > 0 && period[key.endsWith('Tokens') ? 'tokens' : 'estimatedUsd'] >= settings[key])
          return { subject: id, limit: key, resetsAt: key.startsWith('daily') ? dayReset : monthReset }
      }
    }
  }

  attach(ctx) {
    ctx.on('session/event', (session, event) => {
      if (this.service.closing) return
      if (
        ![
          'request/header',
          'request/context',
          'llm/retry-started',
          'assistant/message',
          'assistant/attempt',
          'session/end-seed',
        ].includes(event.type)
      )
        return
      const owner = this.owner(session.id)
      if (!owner) return
      const { state, rows, reset } = foldCalls(
        [event],
        this.folds.get(session.id) ?? session.requestHeader?.()?.config,
      )
      this.folds.set(session.id, state)
      // A fork's inherited prefix belongs to the parent. Drop its old overlay
      // just as the workspace journal drops rows when it sees the inherited cut.
      if (reset) this.store.db.prepare(`DELETE FROM records WHERE collection IN ('usageReceipts','localUsageGaps')
        AND substr(id, 1, ?) = ?`).run(session.id.length + 1, session.id + '#')
      if (!rows.length && (event.type === 'assistant/message' || event.type === 'assistant/attempt') &&
          event.data?.turn != null && event.data?.step != null) {
        const route = this.selected.get(session.id) ?? state
        if (route.provider?.startsWith('local-')) {
          const { turn, step } = event.data
          const attempt = state.retry?.turn === turn && state.retry.step === step ? state.retry.count : 0
          const id = session.id + '#' + [turn,step,attempt].join(':')
          if (!this.store.get('usageReceipts',id) && !this.store.get('localUsageGaps',id))
            this.store.put('localUsageGaps',{ id,provider:route.provider,model:route.model,time:event.time || this.clock(),missing:true })
        }
      }
      for (const row of rows) {
        const actual = this.selected.get(session.id)
        const route = session.requestHeader?.()?.config
        this.store.remove('localUsageGaps',session.id + '#' + row.key)
        this.store.put('usageReceipts', {
          ...row,
          id: session.id + '#' + row.key,
          time: row.time || this.clock(),
          owner,
          provider: row.provider || route?.provider || '',
          model: row.model || route?.model || '',
          ...(actual ? { provider: actual.provider, model: actual.model } : {}),
        })
      }
    })
    ctx.on('agent/disposed', ({ agent }) => {
      this.folds.delete(agent.id)
      this.selected.delete(agent.id)
    })
    this.botBudget = new BotBudget(this, ctx)
    if (this.service.runtime) this.botBudget.attach(this.service.runtime)
    const rerouted = new WeakSet()
    ctx.on(
      'llm/stream',
      (options, next) => {
        if (!options.sessionId || options.purpose || rerouted.has(options) || !validRoute(options))
          return next()
        const owner = this.owner(options.sessionId)
        const backup = owner && this.store.get('usagePolicy', owner)?.backup
        if (!backup || (backup.provider === options.provider && backup.model === options.model)) {
          this.selected.delete(options.sessionId)
          return next()
        }
        return this.modelStream(ctx, options, next, owner, backup, rerouted)
      },
      { prepend: true },
    )
  }

  async *modelStream(ctx, options, next, owner, backup, rerouted) {
    const current = modelRef(options.provider, options.model)
    const id = JSON.stringify([owner, current])
    const held = this.store.get('usageQuotaHolds', id)
    let switchNow = held?.until > this.clock() && held.backup === modelRef(backup.provider, backup.model)
    if (!switchNow) {
      this.selected.delete(options.sessionId)
      let yielded = false
      for await (const chunk of next()) {
        const failure = chunk.type === 'finish' && chunk.reason?.kind === 'error' && chunk.reason.failure
        if (!yielded && quotas.has(failure?.code) && !options.signal?.aborted) {
          const retry = Number(failure.providerRetryAfterMs)
          const until = this.clock() + (Number.isFinite(retry) && retry > 0 ? retry : 60_000)
          this.store.put('usageQuotaHolds', {
            id,
            owner,
            from: current,
            backup: modelRef(backup.provider, backup.model),
            until,
            code: failure.code,
          })
          switchNow = true
          break
        }
        if (
          held &&
          !held.recoveredAt &&
          chunk.type === 'finish' &&
          !['error', 'aborted'].includes(chunk.reason?.kind)
        )
          this.store.update('usageQuotaHolds', id, { recoveredAt: this.clock() })
        yielded = true
        yield chunk
      }
    }
    if (switchNow) {
      const { reasoningEffort: _effort, ...original } = options
      const replacement = { ...original, ...backup }
      rerouted.add(replacement)
      this.selected.set(options.sessionId, backup)
      yield* ctx.llm.stream(replacement)
    }
  }

  close() {
    this.botBudget?.close()
    this.ledger?.close()
  }
}

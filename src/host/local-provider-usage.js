import { workspaceHome } from './workspace-home.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sandboxRouteInfo } from './team-runtime/sandbox-agents.js'

const dayMs = 86_400_000
const counters = ['input', 'cacheRead', 'cacheWrite', 'output']
const iso = value => new Date(value).toISOString()
const totals = () => ({ tokens: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reports: 0, unreported: 0 })
const periods = () => ({ today: totals(), week: totals(), month: totals() })
const isCount = value => Number.isSafeInteger(value) && value >= 0

function identify(row) {
  const { provider } = row
  if (typeof provider !== 'string') return
  const sandbox = sandboxRouteInfo(provider)
  if (sandbox) return { route: sandbox.base, accountId: sandbox.accountId, attribution: 'sandbox' }
  // NativeCrew records the full route for ordinary calls and manual compaction.
  if (provider.startsWith('local-') && !provider.startsWith('local-sandbox-'))
    return { route: provider, accountId: null, attribution: 'host' }
}

function add(target, row) {
  if (row.missing || !counters.some(key => isCount(row[key]))) {
    target.unreported++
    return
  }
  target.reports++
  for (const key of counters) {
    if (!isCount(row[key])) continue
    target[key] += row[key]
    target.tokens += row[key]
  }
}

function readLedger(file, since, now) {
  if (!existsSync(file)) return { status: 'not-created', rows: [] }
  let db
  try {
    db = new DatabaseSync(file, { readOnly: true })
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='calls'").get())
      return { status: 'not-created', rows: [] }
    const rows = db.prepare(`SELECT key AS id, time, provider, model, input, output,
        cache_read AS cacheRead, cache_write AS cacheWrite FROM calls
        WHERE provider LIKE 'local-%' AND time BETWEEN ? AND ?`).all(since, now)
    return { status: 'ready', rows }
  } catch {
    return { status: 'unavailable', rows: [] }
  } finally {
    db?.close()
  }
}

function measuredRows(service, since, now) {
  const file = join(service.runtime?.home ?? workspaceHome(service.stateDir), 'usage.sqlite')
  const ledger = readLedger(file, since, now)
  const rows = new Map(ledger.rows.map(row => [row.id, row]))
  const receipts = service.store.db.prepare(`SELECT data FROM records
    WHERE collection IN ('usageReceipts', 'localUsageGaps') AND json_extract(data, '$.time') BETWEEN ? AND ?`)
  for (const { data } of receipts.iterate(since, now)) {
    const row = JSON.parse(data)
    // The live overlay and the journal share session#turn:step:attempt keys.
    // In either order, a missing-usage placeholder yields to a measurement.
    if (!row.missing || !rows.has(row.id)) rows.set(row.id, row)
  }
  return { rows, ledgerStatus: ledger.status }
}

function publicProvider(provider) {
  const accounts = [...provider.accounts.values()].sort((a, b) =>
    a.attribution.localeCompare(b.attribution) || (a.accountId ?? '').localeCompare(b.accountId ?? ''))
  return {
    ...provider,
    accounts: accounts.map(account => ({
      ...account,
      models: [...account.models.values()].sort((a, b) => (a.model ?? '').localeCompare(b.model ?? '')),
    })),
  }
}

export function localProviderUsage(service, now = Date.now()) {
  const stamp = new Date(now)
  const today = Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), stamp.getUTCDate())
  const from = { today, week: now - 7 * dayMs, month: Date.UTC(stamp.getUTCFullYear(), stamp.getUTCMonth(), 1) }
  const historyStart = today - 6 * dayMs
  const history = () => Array.from({ length: 7 }, (_, i) => ({
    date: iso(historyStart + i * dayMs).slice(0, 10), ...totals(),
  }))
  const { rows, ledgerStatus } = measuredRows(service, Math.min(...Object.values(from)), now)
  const providers = new Map()
  for (const row of rows.values()) {
    const identity = identify(row)
    if (!identity) continue
    const { route, accountId, attribution } = identity
    if (!providers.has(route))
      providers.set(route, { route, periods: periods(), history: history(), accounts: new Map() })
    const provider = providers.get(route)
    const key = attribution === 'sandbox' ? 'sandbox/' + accountId : attribution
    if (!provider.accounts.has(key))
      provider.accounts.set(key, { accountId, attribution, periods: periods(), models: new Map(), history: history() })
    const account = provider.accounts.get(key)
    const name = typeof row.model === 'string' && row.model ? row.model : null
    if (!account.models.has(name)) account.models.set(name, { model: name, periods: periods() })
    const model = account.models.get(name)
    for (const [period, start] of Object.entries(from)) {
      if (row.time < start) continue
      for (const entry of [provider, account, model]) add(entry.periods[period], row)
    }
    if (row.time >= historyStart) {
      const index = Math.floor((row.time - historyStart) / dayMs)
      add(provider.history[index], row)
      add(account.history[index], row)
    }
  }
  return {
    asOf: iso(now), ledgerStatus,
    periods: Object.fromEntries(Object.entries(from).map(([key, start]) => [key, { start: iso(start), end: iso(now) }])),
    providers: [...providers.values()].sort((a, b) => a.route.localeCompare(b.route)).map(publicProvider),
  }
}

// An explicit refresh indexes previous DSH logs through the workspace's existing
// Usage page reader. Its bounded wait reports when that scan is still running.
export async function refreshLocalProviderUsage(service) {
  let scanning = false
  let failed = false
  try {
    const rt = service.runtime
    if (rt?.usageView) scanning = Boolean((await rt.usageView({ timeZone: 'UTC' })).scanning)
  } catch {
    failed = true
  }
  const result = localProviderUsage(service)
  return { ...result, historyScanning: scanning, ...(failed ? { ledgerStatus: 'unavailable' } : {}) }
}

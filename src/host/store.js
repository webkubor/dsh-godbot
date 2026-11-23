import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

function acquireHostLease(dir) {
  const path = join(dir, 'godbot-owner.sqlite3')
  const lease = new DatabaseSync(path)
  try {
    // Keep a write reservation on this separate file for the lifetime of
    // the Host. SQLite releases it on process exit, including a crash. The
    // file must stay in place so every contender locks the same inode.
    lease.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE')
    chmodSync(path, 0o600)
    return lease
  } catch (error) {
    lease.close()
    // SQLite may report an extended SQLITE_BUSY or SQLITE_LOCKED code.
    if ([5, 6].includes(error.errcode & 0xff)) {
      const busy = new Error('Another NativeCrew host already owns the state directory ' + dir, { cause: error })
      busy.code = 'GODBOT_STATE_IN_USE'
      throw busy
    }
    throw error
  }
}

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.lease = acquireHostLease(dir)
    try {
      this.#openRecords(dir)
    } catch (error) {
      this.close()
      throw error
    }
  }
  #openRecords(dir) {
    const path = join(dir, 'godbot.sqlite3')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(collection, id)
      );
      CREATE INDEX IF NOT EXISTS run_records ON records(collection,json_extract(data,'$.runId'),seq)
        WHERE json_extract(data,'$.runId') IS NOT NULL;
    `)
    this.putStatement = this.db.prepare('INSERT INTO records(collection,id,data) VALUES(?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data')
    this.getStatement = this.db.prepare('SELECT data,seq FROM records WHERE collection=? AND id=?')
    this.runStatement = this.db.prepare("SELECT data,seq FROM records WHERE collection=? AND json_extract(data,'$.runId')=? ORDER BY seq")
    this.allStatement = this.db.prepare('SELECT data,seq FROM records WHERE collection=? ORDER BY seq')
  }
  decode(row) {
    return row && { ...JSON.parse(row.data), seq: Number(row.seq) }
  }
  resetIndependentTeams() {
    // The Bot roster and chats live in the team runtime. Retire the separate
    // scheduler and grants before any timer can pick up one of its old jobs.
    const old = this.db.prepare("SELECT 1 FROM records WHERE collection IN ('teams','members') LIMIT 1").get()
    if (!old) return
    this.transaction(() => {
      this.db.exec(`
        DELETE FROM records WHERE
          (collection IN ('usageReceipts','usageQuotaHolds','localUsageGaps','usageDeferred')
            AND json_extract(data,'$.owner') IN (SELECT id FROM records WHERE collection='members'))
          OR (collection='usagePolicy' AND id IN (SELECT id FROM records WHERE collection='members'));
        DELETE FROM records WHERE collection IN (
          'teams','members','turns','commands','events','tasks','messages','interactions','receipts',
          'donorBindings','donorSessions','donorTeamImports','nativeHandoffs',
          'workflows','workflowRuns','botTaskDeliveries','nativeRoutines','automationRuns','automationGrants',
          'automationHooks','automationRequests','githubSources','fullTeamTasks','fullTeamEvidence',
          'fullTeamWork','humanPeople','humanInvites','humanSessions','humanAudit','humanFileMeta','humanFileBytes'
        );
      `)
    })
  }
  get(collection, id) {
    return typeof id === 'string' ? this.decode(this.getStatement.get(collection, id)) : undefined
  }
  require(collection, id) {
    const row = this.get(collection, id)
    if (!row) throw new Error(`Unknown ${collection}: ${String(id ?? '')}`)
    return row
  }
  all(collection) {
    return this.allStatement.all(collection).map(row => this.decode(row))
  }
  forRun(collection, id) {
    return this.runStatement.all(collection, id).map(row => this.decode(row))
  }
  put(collection, row) {
    this.putStatement.run(collection, row.id, JSON.stringify(row))
    return this.get(collection, row.id)
  }
  update(collection, id, patch) {
    return this.put(collection, { ...this.require(collection, id), ...patch })
  }
  remove(collection, id) {
    this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, id)
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  close() {
    if (this.db) {
      this.db.close()
      this.db = undefined
    }
    if (this.lease) {
      this.lease.close()
      this.lease = undefined
    }
  }
}

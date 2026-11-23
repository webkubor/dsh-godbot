import { currentTeamDirectory, previousTeamDirectory, workspaceHome } from './workspace-home.js'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { child, collectAttachments, decode, relocateLog, fileData, includeDescendants, sessionHeader, logLines, logRelative, mapFields, remapper, seal, sessionRefs, sha, tree, unpackTree, unseal } from './backup-files.js'

const managed = new Set(['memory','ledger','handoff-results','avatars','workspace','group-lines','group-logs','skills','usage.sqlite','execution.sqlite'])
const credentials = new Set(['automationGrants','automationHooks','automationSettings','humanInvites','humanSessions'])
const format = 'dsh-godbot-workspace/v2'
const json = file => JSON.parse(readFileSync(file))
const registryPath = home => join(home, 'storages/workspace.json')
const emptyRegistry = () => ({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: {} } })
function safeReplace(path, bytes) {
  const fresh = path + '.tmp-' + randomUUID()
  writeFileSync(fresh, bytes, { flag: 'wx', mode: 0o600, flush: true })
  renameSync(fresh, path)
}
function verifyParents(path) {
  if (lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Cannot replace a symbolic link: ' + path)
  let p = dirname(path)
  while (p !== dirname(p)) {
    if (lstatSync(p,{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Cannot restore through a symbolic link: ' + p)
    p = dirname(p)
  }
}
function regular(path) {
  if (!lstatSync(path).isFile()) throw new Error('Backup member is not a regular file: ' + path)
  return readFileSync(path)
}
function checkpoint(file) {
  const db = new DatabaseSync(file)
  try {
    if (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) throw new Error('Stop active SQLite readers and writers before continuing the workspace operation')
  } finally { db.close() }
}
function rowsOf(dir) {
  const file = join(dir, 'godbot.sqlite3')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file)
  try {
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint.busy) throw new Error('The NativeCrew database still has an active writer')
    return db.prepare('SELECT seq,collection,id,data FROM records ORDER BY seq').all().filter(r => !credentials.has(r.collection))
      .map(r => ({ collection: r.collection, seq: r.seq, id: r.id, value: portableRecord(r.collection, JSON.parse(r.data)) }))
  } finally { db.close() }
}
function portableRecord(collection, value) {
  if (collection === 'usageDeferred' && ['held','releasing'].includes(value.status)) return { ...value, status:'unknown' }
  if (collection === 'humanPeople') return { ...value, permissions: {} }
  if (collection === 'githubSources') return { ...value, paused: true }
  if (collection === 'nativeRoutines' && value.status === 'active')
    return { ...value, status: 'paused', nextAt: null, revision: value.revision + 1 }
  return value
}
function nativeDatabase(path, rows) {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE records(seq INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(collection,id)); BEGIN')
    const insert = db.prepare('INSERT INTO records(seq,collection,id,data) VALUES(?,?,?,?)')
    for (const r of rows) if (!credentials.has(r.collection)) insert.run(r.seq,r.collection,r.id,JSON.stringify(portableRecord(r.collection,r.value)))
    db.exec('COMMIT')
  } finally { db.close() }
}
function portableTeamState(original) {
  const s = structuredClone(original)
  // Connection credentials, per-engine launch commands, remote capabilities
  // and phone/IM permissions belong to the destination machine and its owner.
  for (const k of ['secrets','connectors','providers','phone','im','secretsEncryption','computer','browserPlugins','requests']) delete s[k]
  if (s.capabilities?.items) s.capabilities.items = Object.fromEntries(Object.entries(s.capabilities.items).filter(([,v]) => v.kind === 'skill'))
  for (const b of Object.values(s.bots ?? {})) b.capabilities = (b.capabilities ?? []).filter(k => s.capabilities?.items?.[k])
  if (s.localAgents) {
    delete s.localAgents.custom
    // Preserve original records and transcript references; credentials are held by the CLI itself.
  }
  return s
}
function sessionInventory(home,refs) {
  const root = join(home,'sessions')
  const entries = []
  if (!existsSync(root)) return entries
  for (const project of readdirSync(root,{withFileTypes:true})) {
    if (!project.isDirectory()) continue
    const projectDir = join(root,project.name)
    for (const session of readdirSync(projectDir,{withFileTypes:true})) {
      if (!session.isDirectory()) continue
      const dir = join(projectDir,session.name)
      const files = readdirSync(dir).filter(n => /^session\.v4\.jsonl(?:\.zstd)?$/.test(n))
      if (files.length !== 1) {
        if (refs.has(session.name)) throw new Error('Expected one v4 JSONL Session artifact for '+session.name)
        continue
      }
      const name = files[0], path = join(dir,name)
      try {
        if (!lstatSync(path).isFile()) throw new Error('Session artifact is not a regular file')
        const h = sessionHeader(path,name.endsWith('zstd'))
        if (h.type !== 'session' || h.version !== 4 || h.id !== session.name) throw new Error('DSH Session header identity mismatch')
        entries.push({id:h.id,parentSession:h.parentSession,path,name})
      } catch (error) { if (refs.has(session.name)) throw error }
    }
  }
  includeDescendants(refs,entries)
  return entries.filter(entry => refs.has(entry.id))
}

function ownedLogs(home,refs,objects) {
  const logs = sessionInventory(home,refs).map(({id,name,path,parentSession}) => {
    const bytes = regular(path)
    collectAttachments(logLines(bytes,name.endsWith('zstd')),objects)
    return {id,name,parentSession,...fileData(bytes)}
  })
  const found = new Set(logs.map(s => s.id))
  const missing = [...refs].filter(id => !found.has(id))
  if (missing.length) throw new Error('Missing owned v4 JSONL Session artifacts: '+missing.join(', '))
  return logs
}

function backup({ home, dir, profile, out, password }) {
  const records = rowsOf(dir)
  const teamHome = workspaceHome(dir)
  const statePath = join(teamHome, 'state.json')
  if (!existsSync(statePath)) throw new Error('The team workspace has no saved state at ' + statePath)
  const state = portableTeamState(json(statePath))
  if (records.some(r => ['members', 'teams'].includes(r.collection)))
    throw new Error('Start the current Bot workspace once before taking a backup.')
  if (records.some(r => r.collection === 'botTaskDeliveries' && ['queued','sending','sent'].includes(r.value.state)))
    throw new Error('Finish active Bot assignments before taking a workspace backup.')
  const refs = sessionRefs(state)
  const objects = new Map()
  const sessions = ownedLogs(home, refs, objects)
  const registry = existsSync(registryPath(home)) ? json(registryPath(home)) : emptyRegistry()
  const workspaces = Object.entries(registry.tables.workspaces).filter(([id,x]) => id === state.workspaceId || x.sessionIds.some(s => refs.has(s)))
    .map(([id,x]) => ({ id, ...x, sessionIds: x.sessionIds.filter(s => refs.has(s)) }))
  const attachments = []
  collectAttachments(state, objects)
  for (const r of records) collectAttachments(r.value, objects)
  const usageLedger = join(teamHome,'usage.sqlite')
  if (existsSync(usageLedger)) checkpoint(usageLedger)
  const executionLedger = join(teamHome,'execution.sqlite')
  if (existsSync(executionLedger)) checkpoint(executionLedger)
  const donorFiles = tree(teamHome, managed)
  for (const f of donorFiles) if (f.path.startsWith('ledger/') && f.path.endsWith('.jsonl') && !f.directory) {
    for (const line of decode(f).toString().trim().split('\n')) if (line) collectAttachments(JSON.parse(line), objects)
  }
  for (const [path,id] of objects) {
    const object = fileData(regular(child(join(home,'attachments/v1'),path)))
    if (object.sha256 !== id) throw new Error('Attachment digest mismatch: ' + id)
    attachments.push({ path, ...object })
  }
  const scheduleFile = join(home,'storages/schedule.json')
  const schedule = existsSync(scheduleFile) ? json(scheduleFile) : {}
  const schedules = Object.entries(schedule.tables?.tasks ?? {}).filter(([, task]) => refs.has(task.target?.sessionId ?? task.sessionId))
  const data = { schedules, format, home, dir, teamDirectory: basename(teamHome), profile, state, records, donorFiles, sessions, attachments, workspaces,
    archived: registry.global.archivedSessionIds.filter(id => refs.has(id)), pinned: registry.global.pinnedSessionIds.filter(id => refs.has(id)) }
  const bytes = seal(data,password)
  writeFileSync(out,bytes,{flag:'wx',mode:0o600,flush:true})
  return { archive: out, sha256: sha(bytes), sessions: sessions.length, attachments: attachments.length, records: records.length }
}

function undo(steps) {
  for (const s of [...steps].reverse()) {
    if (existsSync(s.old)) {
      if (existsSync(s.target)) rmSync(s.target,{recursive:true})
      renameSync(s.old,s.target)
    } else if (!s.existed && !existsSync(s.staged) && existsSync(s.target)) rmSync(s.target,{recursive:true})
    if (existsSync(s.staged)) rmSync(s.staged,{recursive:true})
  }
}
function checkJournal(dir, allowCompleted = false) {
  const file = join(dir,'.godbot-restore.json')
  if (!existsSync(file)) return
  const saved = json(file)
  if (saved.status !== 'complete' || allowCompleted) {
    const database = join(dir,'godbot.sqlite3')
    if (existsSync(database)) checkpoint(database)
    undo(saved.steps)
    if (saved.previous) safeReplace(file,JSON.stringify(saved.previous))
    else rmSync(file)
    return 'rolled-back'
  }
  return 'complete'
}
function restore({ home, dir, file, password, mappings }) {
  const data = unseal(regular(file), password)
  if (data.format !== format) throw new Error('Unsupported workspace backup format')
  if (!Array.isArray(data.records) || data.records.some(row => ['members', 'teams'].includes(row.collection)))
    throw new Error('Invalid Bot workspace records')
  const teamHome = workspaceHome(dir)
  const previousState = join(teamHome, 'state.json')
  const prior = existsSync(previousState) ? json(previousState) : {}
  const oldIds = sessionRefs(prior)
  sessionInventory(home,oldIds)
  const newIds = includeDescendants(sessionRefs(data.state),data.sessions)
  const sourceDirectory = data.teamDirectory
  if (![currentTeamDirectory, previousTeamDirectory].includes(sourceDirectory)) throw new Error('Invalid workspace directory in archive')
  const pairs = [[join(data.dir, sourceDirectory), teamHome], [data.dir, dir], [data.home, home], ...mappings]
  const map = remapper(pairs)
  const records = mapFields(data.records, map)
  for (const r of records) if (r.collection === 'githubSources') r.value.paused = true
  const token = randomUUID()
  const steps = []
  const stage = (target, fill) => {
    verifyParents(target)
    mkdirSync(dirname(target),{recursive:true,mode:0o700})
    const staged = target + '.godbot-new-' + token, old = target + '.godbot-old-' + token
    if (steps.some(s => s.target === target)) throw new Error('Duplicate restoration target')
    steps.push({ target, staged, old, existed: existsSync(target) })
    fill(staged)
  }
  const journal = join(dir,'.godbot-restore.json')
  const database = join(dir,'godbot.sqlite3')
  const previous = existsSync(journal) ? json(journal) : null
  let begun = false
  try {
    stage(database, p => nativeDatabase(p,records))
    const state = mapFields(portableTeamState(data.state), map)
    stage(teamHome, p => {
      unpackTree(p,data.donorFiles,managed)
      writeFileSync(join(p,'state.json'),JSON.stringify(state),{mode:0o600})
    })
    const owned = new Set()
    for (const log of data.sessions) {
      const bytes = decode(log)
      const compressed = log.name.endsWith('zstd')
      const [originalHeader] = logLines(bytes,compressed)
      if (!newIds.has(log.id) || originalHeader.id !== log.id || originalHeader.parentSession !== log.parentSession || owned.has(log.id)) throw new Error('Invalid or duplicate owned Session')
      owned.add(log.id)
      const header = mapFields(originalHeader,map)
      const target = child(join(home,'sessions'),logRelative(header, log.name))
      if (existsSync(target) && !oldIds.has(log.id)) throw new Error('Session belongs to another workspace: ' + log.id)
      stage(target, p => writeFileSync(p,relocateLog(bytes,compressed,header),{mode:0o600}))
    }
    const validPath = /^(?:objects|file-objects)\/([0-9a-f]{2})\/([0-9a-f]{64})$|^files\/([0-9a-f]{2})\/([0-9a-f]{64})\/[^/]+$/
    for (const item of data.attachments) {
      const m = validPath.exec(item.path)
      if (!m || (m[1] ?? m[3]) !== item.sha256.slice(0,2) || (m[2] ?? m[4]) !== item.sha256) throw new Error('Invalid attachment path')
      const target = child(join(home,'attachments/v1'),item.path)
      const bytes = decode(item)
      if (existsSync(target)) {
        if (sha(regular(target)) !== item.sha256) throw new Error('Conflicting existing attachment')
      } else stage(target,p => writeFileSync(p,bytes,{mode:0o600}))
    }
    const reg = registryPath(home)
    const registry = existsSync(reg) ? json(reg) : emptyRegistry()
    const table = registry.tables.workspaces
    for (const ws of data.workspaces) {
      if (!Array.isArray(ws.sessionIds) || !ws.sessionIds.every(s => newIds.has(s))) throw new Error('Unowned Session in workspace manifest')
      const {id,...row} = mapFields(ws,map)
      const old = table[id]
      if (old && old.path !== row.path && old.sessionIds.some(x => !oldIds.has(x))) throw new Error('Workspace registry collision')
      // Updating a project path already registered on B must retain its unrelated Sessions.
      const existing = Object.entries(table).find(([,val]) => val.path === row.path)
      if (existing && existing[0] !== id) {
        const [otherId, other] = existing
        const shared = other.sessionIds.filter(s => !oldIds.has(s))
        if (shared.length) throw new Error('A different populated workspace already uses ' + row.path)
        delete table[otherId]
        registry.global.workspaceIds = registry.global.workspaceIds.filter(x => x !== otherId)
      }
      table[id] = { ...row, sessionIds: [...new Set([...(old?.sessionIds ?? []).filter(s => !oldIds.has(s)),...row.sessionIds])] }
      registry.global.workspaceIds = [...new Set([...registry.global.workspaceIds,id])]
    }
    for (const [k, list] of [['archivedSessionIds',data.archived],['pinnedSessionIds',data.pinned]]) {
      registry.global[k] = [...new Set([...(registry.global[k] ?? []).filter(s => !oldIds.has(s)),...list.filter(s => newIds.has(s))])]
    }
    const scheduleFile = join(home,'storages/schedule.json')
    if ((data.schedules ?? []).length || existsSync(scheduleFile)) {
      const schedules = existsSync(scheduleFile) ? json(scheduleFile) : { unit: { name:'schedule',version:2 }, tables:{tasks:{}} }
      const tasks = schedules.tables.tasks
      for (const [id, task] of Object.entries(tasks)) if (oldIds.has(task.target?.sessionId ?? task.sessionId)) delete tasks[id]
      for (const [id, task] of data.schedules ?? []) {
        if (!newIds.has(task.target?.sessionId ?? task.sessionId) || Object.hasOwn(tasks,id)) throw new Error('Unowned schedule or conflicting target')
        tasks[id] = { ...task, status:task.status === 'active' ? 'paused' : task.status }
      }
      stage(scheduleFile, p => writeFileSync(p,JSON.stringify(schedules),{mode:0o600}))
    }
    stage(reg, p => writeFileSync(p,JSON.stringify(registry),{mode:0o600}))
    // WAL filenames follow the database pathname. Fold the destination's last
    // commits into its rollback copy before the staged database takes that name.
    if (existsSync(database)) checkpoint(database)
    safeReplace(journal,JSON.stringify({status:'applying',steps,previous}))
    begun = true
    for (const s of steps) {
      if (s.existed) renameSync(s.target,s.old)
      renameSync(s.staged,s.target)
    }
    safeReplace(journal,JSON.stringify({status:'complete',steps}))
    if (previous?.status === 'complete') for (const s of previous.steps) {
      try { rmSync(s.old,{recursive:true,force:true}) } catch { /* Old rollback material can be cleaned up offline. */ }
    }
    return { restored: true, sessions: owned.size, attachments: data.attachments.length, records: records.length,
      recovery: 'godbot workspace rollback', nativeCliSessions: 'Verify the original session and CLI login on this machine.' }
  } catch (error) {
    if (begun) { undo(steps); if (previous) safeReplace(journal,JSON.stringify(previous)); else rmSync(journal,{force:true}) }
    else for (const s of steps) if (existsSync(s.staged)) rmSync(s.staged,{recursive:true})
    throw error
  }
}

export async function workspaceCommand(argv) {
  const [verb,...args] = argv
  if (!['backup','restore','recover','rollback'].includes(verb)) throw new Error('Use workspace backup|restore|recover|rollback --home DSH_HOME [--profile web] [--file ARCHIVE --password-file FILE] [--map OLD=NEW]')
  const { values:v } = parseArgs({args,options:{home:{type:'string'},profile:{type:'string',default:'web'},'state-dir':{type:'string'},
    file:{type:'string'},'password-file':{type:'string'},map:{type:'string',multiple:true}}})
  if (!v.home || !isAbsolute(v.home) || !/^[a-zA-Z0-9_-]+$/.test(v.profile)) throw new Error('Supply an absolute --home and a valid profile')
  const home = realpathSync(v.home), dir = v['state-dir'] ? realpathSync(v['state-dir']) : join(home,'godbot',v.profile)
  const opts = {home,dir,profile:v.profile}
  const leaseFile = join(dir,'godbot-owner.sqlite3')
  if (!existsSync(leaseFile)) throw new Error('Initialize this NativeCrew profile before using workspace backup/restore')
  const lease = new DatabaseSync(leaseFile)
  try {
    try { lease.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE') } catch { throw new Error('Stop this NativeCrew Host before backup or restore') }
    const recovered = checkJournal(dir,verb==='rollback')
    if (verb==='recover' || verb==='rollback') return { state: recovered ?? 'clean' }
    if (!v.file || !v['password-file']) throw new Error('Provide --file and --password-file')
    const password = regular(resolve(v['password-file'])).toString().replace(/\r?\n$/, '')
    if (!password) throw new Error('Backup password is empty')
    if (verb === 'backup') return backup({...opts,out:resolve(v.file),password})
    const mappings = (v.map ?? []).map(item => {
      const i = item.indexOf('=')
      const from = item.slice(0,i), to = item.slice(i+1)
      if (i < 1 || !isAbsolute(from) || !isAbsolute(to)) throw new Error('Each --map must specify two absolute paths FROM=TO')
      return [resolve(from),realpathSync(to)]
    })
    return restore({...opts, file:resolve(v.file), password, mappings})
  } finally { lease.close() }
}

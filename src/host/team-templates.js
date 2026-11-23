import { createHash, randomUUID } from 'node:crypto'
import { mapWorkflow } from '../team/workflow-file.js'
import { normalizeWorkflow } from '../team/workflow-graph.js'
import { botWorkspaceId } from './bot-task-workspace.js'
import { saveWorkflow } from './workflows.js'

const version = 'godbot-team/v1'
const running = new WeakMap()
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const string = (v, max, allowEmpty = false) => {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) throw new Error('模板包含无效文本或缺少名称。')
  return v
}
const list = (v, max) => {
  if (!Array.isArray(v) || v.length > max) throw new Error('模板列表格式或长度不正确。')
  return v
}
function timing(schedule) {
  switch (schedule.kind) {
    case 'rrule': return { kind: 'rrule', rrule: string(schedule.rrule, 2000) }
    case 'at':
    case 'after': return { kind: 'at', at: string(schedule.at ?? schedule.scheduledAt, 64) }
    case 'every': {
      const n = schedule.every_seconds ?? schedule.everySeconds
      if (!Number.isSafeInteger(n) || n < 1) throw new Error('无效的重复周期。')
      return { kind: 'every', every_seconds: n }
    }
    case 'daily':
    case 'weekly':
    case 'cron': {
      const k = schedule.kind, part = schedule[k] ?? schedule
      const zone = string(part.time_zone ?? part.timeZone, 80)
      if (k === 'cron') return { kind: k, cron: { expression: string(part.expression, 200), time_zone: zone } }
      const time = string(part.time, 12)
      if (k === 'daily') return { kind: k, daily: { time, time_zone: zone } }
      const weekdays = list(part.weekdays, 7)
      if (!weekdays.length || !weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7)) throw new Error('无效的星期。')
      return { kind: k, weekly: { time, time_zone: zone, weekdays } }
    }
    default: throw new Error('不支持此计划的时间格式。')
  }
}

function normalize(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (data?.format !== version) throw new Error('请选择 NativeCrew v1 团队模板。')
  const refs = new Set()
  const ref = value => {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,45}$/.test(value) || refs.has(value)) throw new Error('模板条目标识冲突。')
    refs.add(value); return value
  }
  const bots = list(data.bots, 60).map(b => ({ ref: ref(b.ref), name: string(b.name, 40), role: string(b.role ?? '', 24, true),
    instructions: string(b.instructions ?? '', 32000, true), skills: [...new Set(list(b.skills ?? [], 100).map(s => string(s, 80)))] }))
  if (!bots.length) throw new Error('模板需要至少一名成员。')
  const members = new Set(bots.map(b => b.ref))
  const rooms = list(data.rooms, 50).map(r => {
    const roster = [...new Set(list(r.members, 12))]
    if (!roster.length || !roster.every(m => members.has(m)) || (r.admin && !roster.includes(r.admin))) throw new Error('模板群组关联无效。')
    return { ref: ref(r.ref), name: string(r.name, 60), members: roster, admin: r.admin || null, mode: r.mode === 'everyone' ? 'everyone' : 'admin' }
  })
  const plans = list(data.plans ?? [], 100).map(p => {
    if (!refs.has(p.target)) throw new Error('模板计划目标无效。')
    return { target: p.target, title: string(p.title, 120), prompt: string(p.prompt, 32000), timing: timing(p.timing) }
  })
  const workflows = list(data.workflows ?? [], 100).map(flow => normalizeWorkflow(flow, members))
  return { format: version, bots, rooms, plans, ...(workflows.length ? { workflows } : {}) }
}

function exportWorkflows(service, ids, clean) {
  return service.store.all('workflows')
    .filter(flow => flow.teamId === botWorkspaceId && flow.nodes.every(node => ids.has(node.ownerId)))
    .map(flow => mapWorkflow(flow, ids, clean))
}

async function exportTemplate(rt, service, roomId) {
  const rooms = Object.values(rt.state.rooms).filter(r => (!roomId || r.id === roomId) && r.members.every(id => rt.botOf(id) && !rt.botOf(id).private))
  if (roomId && !rooms.length) throw new Error('群组不存在。')
  const bots = Object.values(rt.state.bots).filter(b => !b.private && (!roomId || rooms[0].members.includes(b.id)))
  const ids = new Map(bots.map((b, i) => [b.id, 'bot-' + i]))
  for (const [i, r] of rooms.entries()) ids.set(r.id, 'room-' + i)
  const clean = text => rt.redactSecrets ? rt.redactSecrets(String(text ?? '')) : String(text ?? '')
  const sched = await rt.scheduleEndpoint('schedules', {})
  const tasks = sched.tasks.filter(t => ids.has(t.roomId ?? t.botId) && !['finished','ended'].includes(t.status))
  const plans = tasks.map(t => ({ target: ids.get(t.roomId ?? t.botId), title: clean(t.title), prompt: clean(t.prompt), timing: timing(t) }))
  for (const p of Object.values(rt.state.godbotPlanDrafts ?? {})) if (p.status === 'paused' && ids.has(p.targetId)) {
    plans.push({ target: ids.get(p.targetId), title: clean(p.title), prompt: clean(p.prompt), timing: p.timing })
  }
  return normalize({ format: version, bots: bots.map(b => ({
    ref: ids.get(b.id), name: clean(b.name), role: clean(b.role), instructions: clean(b.instructions),
    skills: [...new Set([...rt.expandCapabilities(b.capabilities ?? [])].filter(s => rt.state.capabilities.items[s]?.kind === 'skill').concat(b.godbotRequestedSkills ?? []))],
  })), rooms: rooms.map(r => ({ ref: ids.get(r.id), name: clean(r.name), members: r.members.map(i => ids.get(i)), admin: ids.get(r.admin), mode: r.mode })),
  plans, workflows: exportWorkflows(service, ids, clean) })
}

function freeName(base, rows, max) {
  const names = new Set(Object.values(rows).map(r => r.name?.toLowerCase()))
  let index = 1
  let name = base
  while (names.has(name.toLowerCase())) { const suffix = ' ' + (++index); name = base.slice(0, max - suffix.length) + suffix }
  return name
}

async function installTemplate(rt, service, data, requestId) {
  const db = service.store
  const fingerprint = hash(data)
  const id = 'template/' + requestId
  const existing = db.get('teamTemplateImports', id)
  if (existing && existing.fingerprint !== fingerprint) throw new Error('此导入 ID 已用于另一份模板。')
  if (existing?.complete) return existing.result
  const imported = existing ?? db.put('teamTemplateImports', { id, fingerprint, nonce: randomUUID() })
  await rt.ensureWorkspace()
  const mapping = {}
  for (const entry of [...data.bots, ...data.rooms]) {
    const origin = 'godbot/template/' + imported.nonce + '/' + entry.ref
    const key = id + '/' + entry.ref
    const reserve = db.get('teamTemplateBindings', key) ?? db.put('teamTemplateBindings', { id: key, target: randomUUID() })
    const binding = { id: reserve.target, claim(s) { if (s !== reserve.target) db.update('teamTemplateBindings', key, { target: s }) } }
    const room = !!entry.members
    const rows = room ? rt.state.rooms : rt.state.bots
    let result = Object.values(rows).find(x => x.godbotOrigin === origin)
    if (!result) {
      const name = freeName(entry.name, rows, room ? 60 : 40)
      const opts = { origin, name, reservation: binding }
      if (room) {
        // Imported groups need a real working folder even when the template did not specify one.
        const workDir = await rt.keepTeamFolder() ?? rt.defaultTeamFolder()
        result = await rt.importNativeCrewRoom({ ...opts, workDir, members: entry.members.map(m => mapping[m]), admin: mapping[entry.admin] ?? null, mode: entry.mode })
      } else {
        result = await rt.importNativeCrewMember({ ...opts, pickModel: true, role: entry.role, instructions: entry.instructions })
      }
    }
    if (!room) result.godbotRequestedSkills = entry.skills
    mapping[entry.ref] = result.id
  }
  const drafts = rt.state.godbotPlanDrafts ??= {}
  const draftIds = data.plans.map((p, i) => {
    const planId = imported.nonce + '-' + i
    drafts[planId] ??= { id: planId, status: 'paused', targetId: mapping[p.target], title: p.title, prompt: p.prompt, timing: p.timing }
    return planId
  })
  await rt.save()
  const owners = new Map(Object.entries(mapping))
  return db.transaction(() => {
    const workflows = (data.workflows ?? []).map(flow =>
      saveWorkflow(db, { teamId: botWorkspaceId, ...mapWorkflow(flow, owners) }).id)
    const result = { mapping, plans: draftIds, workflows,
      skills: data.bots.flatMap(b => b.skills.map(skill => ({ botId: mapping[b.ref], skill }))) }
    db.update('teamTemplateImports', id, { complete: true, result })
    return result
  })
}

export async function templateAction(rt, service, req) {
  switch (req.action) {
    case 'team-workspace.templateExport': return exportTemplate(rt, service, req.roomId)
    case 'team-workspace.templatePreview': return normalize(req.template)
    case 'team-workspace.templateImport': {
      if (rt.readOnly()) throw new Error('当前工作区为只读。')
      if (!/^[\da-f-]{36}$/i.test(req.requestId ?? '')) throw new Error('缺少有效的模板导入 ID。')
      const data = normalize(req.template)
      // Serialize all imports; two differently named requests can still reserve the same display name.
      const previous = running.get(service) ?? Promise.resolve()
      const work = previous.catch(() => {}).then(() => installTemplate(rt, service, data, req.requestId))
      running.set(service, work)
      try { return await work } finally { if (running.get(service) === work) running.delete(service) }
    }
    case 'team-workspace.templatePlans':
      return Object.values(rt.state.godbotPlanDrafts ?? {})
    case 'team-workspace.templateEnable': {
      if (rt.readOnly()) throw new Error('当前工作区为只读。')
      const p = rt.state.godbotPlanDrafts?.[req.id]
      if (!p || p.status !== 'paused') throw new Error('计划当前无法启用。')
      const bot = rt.botOf(p.targetId), room = rt.roomOf(p.targetId)
      const scheduler = rt.ctx.get?.('schedule')
      if (!scheduler || (!bot && !room)) throw new Error('目标会话或 DSH 调度服务不可用。')
      const sessionId = bot ? rt.chatOf(bot.id) : rt.sessionOfRoom(room)
      p.status = 'enabling'
      try { await rt.save() } catch (error) { p.status = 'paused'; throw error }
      const created = await scheduler.create({ title: p.title, prompt: p.prompt, target: { kind: 'session', sessionId }, timing: p.timing })
      p.status = 'enabled'
      p.scheduleId = created.id
      await rt.save()
      return p
    }
  }
  throw new Error('未知的模板操作。')
}

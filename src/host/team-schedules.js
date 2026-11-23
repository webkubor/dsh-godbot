import { checkOnlyScheduleMarker } from './run-origin.js'

function targetSession(rt, id) {
  const bot = rt.botOf(id)
  const room = rt.roomOf(id)
  if (!bot && !room) throw new Error('请选择工作区内的 Bot 或群聊。')
  return { kind: 'session', sessionId: bot ? rt.chatOf(bot.id) : rt.sessionOfRoom(room) }
}

// DSH owns calendar validation, DST resolution, and the persisted next occurrence.
function timing(when) {
  const kind = when?.kind
  switch (kind) {
    case 'at':
      return { kind, at: when.at }
    case 'every':
      if (!Number.isSafeInteger(when.minutes) || when.minutes < 1 ||
          !Number.isSafeInteger(when.minutes * 60)) throw new Error('重复间隔须为正整数分钟。')
      return { kind, every_seconds: when.minutes * 60 }
    case 'daily':
    case 'weekly': {
      const time = /^\d{2}:\d{2}$/.test(when.time) ? when.time + ':00' : when.time
      const calendar = { time, time_zone: when.timeZone }
      if (kind === 'weekly') calendar.weekdays = when.weekdays
      return { kind, [kind]: calendar }
    }
    case 'cron':
      return { kind, cron: { expression: when.expression, time_zone: when.timeZone } }
    case 'rrule':
      return { kind, rrule: when.rrule }
    default:
      throw new Error('请选择任务的执行时间。')
  }
}

function patchOf(rt, req) {
  const patch = {}
  if (req.title !== undefined) {
    if (typeof req.title !== 'string' || !req.title.trim()) throw new Error('请输入任务名称。')
    patch.title = req.title.trim()
  }
  if (req.prompt !== undefined) {
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new Error('请输入任务指令。')
    patch.prompt = req.prompt.trim()
  }
  if (req.target !== undefined) patch.target = targetSession(rt, req.target)
  if (req.when !== undefined) patch.timing = timing(req.when)
  return patch
}

function checked(result) {
  if (!result?.code) return result
  const errors = {
    schedule_not_found: '任务已删除，请刷新列表。',
    schedule_conflict: '任务已更改，请刷新后重新操作。',
    schedule_execution_pending: '此任务仍在执行或等待下一次允许投递的时间。',
    delivery_cursor_not_found: '这页投递记录已过期，请重新打开历史。',
  }
  throw new Error(errors[result.code] ?? result.code)
}

export async function createTeamSchedule(rt, req) {
  if (rt.readOnly()) throw new Error('当前 Bot 工作区为只读。')
  const scheduler = rt.ctx.get('schedule')
  if (!scheduler) throw new Error('当前 DSH 宿主没有启用自动化任务。')
  const patch = patchOf(rt, req)
  if (!patch.title || !patch.prompt || !patch.target || !patch.timing) throw new Error('请填写任务名称、指令、执行目标和时间。')
  // DSH can deliver a newly due schedule before its returned ID is saved in NativeCrew.
  if (req.checkOnly === true) patch.prompt = checkOnlyScheduleMarker + patch.prompt
  const entry = checked(await scheduler.create(patch))
  if (req.checkOnly === true) {
    rt.state.scheduleCheckIns = { ...rt.state.scheduleCheckIns, [entry.id]: true }
    try { await rt.save({ required: true }) }
    catch (error) {
      let removed = false
      try {
        checked(await scheduler.edit({ id: entry.id, action: 'delete' }))
        removed = true
      } catch {}
      if (removed) delete rt.state.scheduleCheckIns[entry.id]
      else error.automationMayExist = true
      throw error
    }
  }
  return entry
}

export async function teamScheduleAction(rt, req) {
  const list = () => rt.scheduleEndpoint('schedules', {})
  if (req.action === 'team-workspace.scheduleList') return list()

  const history = req.action === 'team-workspace.scheduleHistory'
  if (!history && rt.readOnly()) throw new Error('当前 Bot 工作区为只读。')
  const scheduler = rt.ctx.get('schedule')
  if (!scheduler) throw new Error('当前 DSH 宿主没有启用自动化任务。')
  if (req.action === 'team-workspace.scheduleCreate') {
    await createTeamSchedule(rt, req)
    return list()
  }

  // The Host-wide service also contains tasks for unrelated DSH Sessions.
  const task = (await list()).tasks.find(item => item.id === req.id && item.sessionId === req.sessionId)
  if (!task) throw new Error('在指定的 Bot 或群聊中找不到此任务。')
  const id = task.id
  if (history) return checked(await scheduler.history({ id, limit: req.limit ?? 20, before: req.before }))
  if (req.action === 'team-workspace.scheduleRun') {
    checked(await scheduler.run({ id }))
  } else {
    const expectedUpdatedAt = req.expectedUpdatedAt === undefined ? task.updatedAt ?? null : req.expectedUpdatedAt
    let edit
    switch (req.action) {
      case 'team-workspace.scheduleEdit':
        edit = { action: 'update', patch: patchOf(rt, req) }
        break
      case 'team-workspace.schedulePause':
      case 'team-workspace.scheduleResume':
        edit = { action: 'update', patch: { active: req.action === 'team-workspace.scheduleResume' } }
        break
      case 'team-workspace.scheduleDelete':
        edit = { action: 'delete' }
        break
      default:
        throw new Error('未知的计划任务操作。')
    }
    checked(await scheduler.edit({ id, expectedUpdatedAt, ...edit }))
    if (edit.action === 'delete' && rt.state?.scheduleCheckIns?.[id]) {
      delete rt.state.scheduleCheckIns[id]
      await rt.save()
    }
  }
  return list()
}

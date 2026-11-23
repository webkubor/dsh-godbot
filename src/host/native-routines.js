import { assignRun, inspectRun } from './automation-runs.js'
import { nextRoutineTime, normalizeRoutineTiming } from './routine-timing.js'
import { runOrigin } from './run-origin.js'
import { record, required, teamMember } from './team.js'
import { startWorkflowSnapshot } from './workflows.js'

const collection = 'nativeRoutines'
const maxHistory = 50
// Recheck the wall clock after system sleep or a change to the host clock.
const maxWakeDelay = 60000

function settings(req, store, prior) {
  const title = required(req.title, '任务说明')
  const schedule = normalizeRoutineTiming(req.schedule)
  if (title.length > 32000) throw new Error('任务说明最多 32000 字。')
  const checkOnly = req.checkOnly === undefined ? prior?.checkOnly === true : req.checkOnly === true
  const target = req.target ?? prior?.target ?? 'member'
  if (target === 'workflow') {
    const pinned = prior?.workflowSnapshot
    const workflow = pinned && pinned.id === req.workflowId && pinned.revision === req.workflowRevision
      ? pinned : store.get('workflows', req.workflowId)
    if (!workflow || workflow.teamId !== req.teamId) throw new Error('所选工作流不属于当前团队。')
    if (workflow.revision !== req.workflowRevision) throw new Error('工作流版本已更新，请重新选择固定版本。')
    for (const node of workflow.nodes) teamMember(store, req.teamId, node.ownerId)
    const { id, teamId, name, revision, nodes, edges } = workflow
    return { title, schedule, target, checkOnly, ownerId: null, criteria: null, workflowSnapshot: { id, teamId, name, revision, nodes, edges } }
  }
  if (target !== 'member') throw new Error('无法识别自动化任务的执行类型。')
  const criteria = required(req.criteria, '验收条件')
  if (criteria.length > 32000) throw new Error('验收条件最多 32000 字。')
  return { title, schedule, target, checkOnly, criteria, ownerId: teamMember(store, req.teamId, req.ownerId).id, workflowSnapshot: null }
}

function publicRoutine({ history, seq, workflowSnapshot, ...routine }) {
  if (!workflowSnapshot) return routine
  return { ...routine, workflowId: workflowSnapshot.id, workflowName: workflowSnapshot.name, workflowRevision: workflowSnapshot.revision }
}

function dispatchOccurrence(service, row) {
  if (service.runtime?.readOnly()) throw new Error('当前 Bot 工作区为只读。')
  const initiator = runOrigin('schedule', row.id, 'owner', row.checkOnly === true)
  if (row.target !== 'workflow') return assignRun(service, row, row, undefined, initiator)
  const run = startWorkflowSnapshot(service, row.workflowSnapshot, row.id, initiator)
  return { runId: run.id, teamId: run.teamId, workflowId: run.workflowId, workflowRevision: run.workflowRevision }
}

function future(schedule, now, anchor = now) {
  const nextAt = nextRoutineTime(schedule, now, anchor)
  if (nextAt === null) throw new Error('请选择未来的一次性执行时间。')
  return nextAt
}

export class NativeRoutines {
  constructor(service) {
    this.service = service
    this.store = service.store
  }

  owner(req) {
    if (!['automation.routine.list', 'automation.routine.history'].includes(req.action))
      return this.service.botTasks.mutate(req, scoped => this.apply(scoped))
    return this.apply(req)
  }

  apply(req) {
    const { teamId, id } = req
    this.store.require('teams', teamId)
    const action = req.action.slice('automation.routine.'.length)
    if (action === 'list') {
      const routines = this.store.all(collection).filter(row => row.teamId === teamId).map(publicRoutine)
      const workflows = this.store.all('workflows').filter(w => w.teamId === teamId)
        .map(({ id, name, revision }) => ({ id, name, revision }))
      return { routines, workflows }
    }
    const now = Date.now()
    if (action === 'create') {
      const fields = settings(req, this.store)
      const nextAt = future(fields.schedule, now)
      const row = this.store.put(collection, record({ teamId, ...fields, status: 'active', nextAt, revision: 1,
        anchor: now, lastAt: null, lastError: null, history: [] }))
      queueMicrotask(() => this.arm())
      return publicRoutine(row)
    }

    const row = this.store.get(collection, id)
    if (!row || row.teamId !== teamId) throw new Error('该团队没有这项自动化任务。')
    if (action === 'history') {
      const items = row.history.map(entry => {
        if (!entry.runId) return entry
        const result = inspectRun(this.service, row, entry.runId)
        const { rootTaskId, state, reason } = result
        if (!result.workflowId) return { ...entry, rootTaskId, state, reason }
        return { ...entry, rootTaskId, state, reason, workflowId: result.workflowId, workflowRevision: result.workflowRevision,
          nodes: result.tasks.filter(task => task.workflowNodeId).map(task => ({ nodeId: task.workflowNodeId, taskId: task.id,
            title: task.title, status: task.status, evidenceRevision: task.evidenceRevision, reviewedEvidenceRevision: task.reviewedEvidenceRevision })) }
      })
      return { items }
    }
    if (action === 'run') {
      if (typeof req.requestId !== 'string' || !req.requestId.trim() || req.requestId.length > 256)
        throw new Error('手动执行需要有效的请求 ID。')
      const result = dispatchOccurrence(this.service, row)
      this.saveOccurrence(row, { id: req.requestId, trigger: 'manual', dueAt: now, at: now, runId: result.runId })
      return result
    }
    if (req.revision != null && req.revision !== row.revision) throw new Error('任务配置已变更，请刷新后重试。')
    let patch
    switch (action) {
      case 'update': {
        patch = settings(req, this.store, row)
        if (JSON.stringify(row.schedule) !== JSON.stringify(patch.schedule)) {
          const nextAt = future(patch.schedule, now)
          Object.assign(patch, { anchor: now, nextAt: row.status === 'paused' ? null : nextAt,
            status: row.status === 'paused' ? 'paused' : 'active' })
        }
        break
      }
      case 'pause':
        if (row.status !== 'active') throw new Error('当前计划无法暂停。')
        patch = { status: 'paused', nextAt: null }
        break
      case 'resume':
        if (row.status !== 'paused') throw new Error('当前计划无法恢复。')
        patch = { status: 'active', nextAt: future(row.schedule, now, row.anchor) }
        break
      case 'delete':
        this.store.remove(collection, row.id)
        queueMicrotask(() => this.arm())
        return publicRoutine({ ...row, status: 'deleted', nextAt: null })
      default: throw new Error('未知的自动化操作。')
    }
    const updated = this.store.update(collection, row.id, { ...patch, revision: row.revision + 1 })
    queueMicrotask(() => this.arm())
    return publicRoutine(updated)
  }

  saveOccurrence(row, entry, patch = {}) {
    const receipt = row.workflowSnapshot ? { ...entry, workflowId: row.workflowSnapshot.id, workflowRevision: row.workflowSnapshot.revision } : entry
    const history = [receipt, ...row.history].slice(0, maxHistory)
    this.store.update(collection, row.id, { ...patch, history, lastAt: entry.at, lastError: entry.reason ?? null })
  }

  runDue(now = Date.now()) {
    if (this.service.closing) return
    for (const row of this.store.all(collection)) {
      if (row.status !== 'active' || row.nextAt > now) continue
      // A sleeping or offline host catches up once. Jump directly to the next
      // original slot so missed daily or interval work cannot flood the queue.
      const nextAt = nextRoutineTime(row.schedule, now, row.anchor)
      const patch = nextAt === null ? { nextAt, status: 'finished', revision: row.revision + 1 } : { nextAt }
      const entry = { id: 'scheduled/' + row.nextAt, trigger: 'scheduled', dueAt: row.nextAt, at: now }
      try {
        this.store.transaction(() => {
          const result = dispatchOccurrence(this.service, row)
          this.saveOccurrence(row, { ...entry, runId: result.runId }, patch)
        })
      } catch (error) {
        // The queue transaction has rolled back. Record the undelivered slot
        // and advance the plan, preserving the operator's stop/import controls.
        const state = this.store.get('teams', row.teamId)?.stopped ? 'skipped' : 'failed'
        this.saveOccurrence(row, { ...entry, state, reason: String(error?.message ?? error) }, patch)
      }
    }
  }

  wake() {
    if (this.service.closing) return
    try {
      this.runDue()
      this.arm()
    } catch (error) {
      // A temporarily unwritable database must not take down the host or turn
      // an already-due occurrence into a zero-delay retry loop.
      process.emitWarning('NativeCrew 自动化调度稍后重试：' + error.message, { code: 'GODBOT_ROUTINE_RETRY' })
      this.timer = setTimeout(() => this.wake(), 30000)
      this.timer.unref()
    }
  }

  arm() {
    clearTimeout(this.timer)
    if (this.service.closing) return
    const rows = this.store.all(collection).filter(row => row.status === 'active')
    if (!rows.length) return
    const earliest = rows.reduce((at, row) => Math.min(at, row.nextAt), Infinity)
    this.timer = setTimeout(() => this.wake(), Math.min(maxWakeDelay, Math.max(0, earliest - Date.now())))
    this.timer.unref()
  }

  close() { clearTimeout(this.timer) }
}

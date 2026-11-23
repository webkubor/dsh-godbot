// Test adapter for the retired standalone-member runtime.
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { memberWorkspace } from './member-workspace.js'
import { mentionSpans, nameProblem } from '../../src/team/mentions.js'
import { TeamActions as BotTasks, activeTeam, teamMember, now, record, required } from '../../src/host/team.js'

export { activeTeam, teamMember, now, record, required }

function directory(path) {
  if (!isAbsolute(required(path, 'Absolute working directory'))) throw new Error('Use an absolute working directory')
  const cwd = realpathSync(path)
  if (!statSync(cwd).isDirectory()) throw new Error('Workspace must be a directory')
  return cwd
}
export function createTeam(store, req) {
  return store.put('teams', record({ name: required(req.name, 'Team name'), cwd: directory(req.cwd), stopped: false, leadId: null }))
}
function memberName(store, teamId, value, memberId) {
  const name = required(value, 'Member name')
  const problem = nameProblem(name)
  if (problem) throw new Error(problem)
  if (store.all('members').some(m => m.teamId === teamId && m.id !== memberId && m.name.toLowerCase() === name.toLowerCase())) {
    throw new Error('Member name already in use')
  }
  return name
}
function memberNote(value, limit, label) {
  if (typeof value !== 'string') throw new Error(label + ' must be text')
  const text = value.trim()
  if (Array.from(text).length > limit) throw new Error(label + ' exceeds ' + limit + ' characters')
  return text
}
function within(root, dir) {
  const offset = relative(root, dir)
  return offset === '' || (offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset))
}
export function profileChanges(store, member, req, stateDir) {
  const fields = {}
  if (Object.hasOwn(req, 'accountProfileId')) fields.accountProfileId = req.accountProfileId
  if ('name' in req) fields.name = memberName(store, member.teamId, req.name, member.id)
  if ('role' in req) fields.role = memberNote(req.role, 4000, 'Role')
  if ('memory' in req) fields.memory = memberNote(req.memory, 16000, 'Fixed memory')
  if (('role' in fields && fields.role !== (member.role ?? '')) || ('memory' in fields && fields.memory !== (member.memory ?? ''))) {
    fields.profileUpdatedAt = now()
  }
  if (!('cwd' in req)) {
    if (!Object.keys(fields).length) throw new Error('Choose a member profile setting')
    return { fields }
  }
  const cwd = directory(req.cwd)
  if (cwd === member.cwd) return { fields }
  const mode = member.workspaceMode ?? 'shared'
  if (mode === 'worktree') {
    if (!member.workspaceRoot || !within(member.workspaceRoot, cwd)) throw new Error('Choose a directory inside this member’s own managed worktree')
    return { fields, workspace: { cwd, workspaceRoot: member.workspaceRoot } }
  }
  if (within(join(realpathSync(stateDir), 'worktrees'), cwd)) throw new Error('This directory belongs to a managed NativeCrew worktree')
  return { fields, workspace: memberWorkspace(cwd, mode, member.id, stateDir) }
}
export function addMember(store, req, stateDir) {
  const team = activeTeam(store, req.teamId)
  const kind = req.kind
  if (!['codex', 'claude', 'antigravity', 'dsh', 'acp'].includes(kind)) throw new Error('Unsupported agent kind')
  const name = memberName(store, team.id, req.name)
  const role = memberNote(req.role ?? '', 4000, 'Role')
  const memory = memberNote(req.memory ?? '', 16000, 'Fixed memory')
  const id = randomUUID()
  const workspaceMode = req.workspaceMode ?? 'shared'
  if (workspaceMode === 'shared-readonly' && kind !== 'codex') {
    throw new Error('A shared read-only workspace requires the Codex read-only sandbox')
  }
  const cwd = directory(req.cwd || team.cwd)
  if (stateDir && within(join(realpathSync(stateDir), 'worktrees'), cwd)) throw new Error('This directory belongs to a managed NativeCrew worktree')
  const workspace = memberWorkspace(cwd, workspaceMode, id, stateDir)
  const member = store.put('members', record({
    id, teamId: team.id, name, role, memory, kind, ...workspace, ...(req.accountProfileId ? { accountProfileId: req.accountProfileId } : {}), nativeId: null, activeTurnId: null,
    status: workspaceMode === 'worktree' ? 'preparing' : 'idle',
    capabilities: { steer: ['codex', 'dsh'].includes(kind), interrupt: true, resume: true },
  }))
  if (!team.leadId || (!team.leadSelected && kind === 'dsh' && store.get('members', team.leadId)?.kind !== 'dsh')) store.update('teams', team.id, { leadId: member.id })
  return member
}

export class TeamActions extends BotTasks {
  constructor(store, enqueue, stopTurn) {
    super(store, enqueue)
    this.stopTurn = stopTurn
    this.assignmentInstruction = 'Use report_result with the task ID and concrete evidence when ready.'
  }

  assign(req, actor, rootRunId, externalEvent, workflow) {
    const source = actor?.activeTurnId && this.store.get('turns', actor.activeTurnId)
    return super.assign(req, actor && { ...actor, runId: source?.runId, contextTaskId: source?.contextTaskId }, rootRunId, externalEvent, workflow)
  }

  send(req, actor) {
    const { store } = this
    const team = activeTeam(store, req.teamId)
    if (actor && actor.teamId !== team.id) throw new Error('Sender does not belong to this team')
    const text = required(req.text, 'Message')
    const original = req.replyTo && store.require('messages', req.replyTo)
    if (original && original.teamId !== team.id) throw new Error('Reply belongs to another team')
    const source = actor?.activeTurnId && store.get('turns', actor.activeTurnId)
    if (actor && original && (original.runId ?? null) !== (source?.runId ?? null))
      throw new Error('Reply belongs to another run')
    const members = store.all('members').filter((m) => m.teamId === team.id)
    const mentions = mentionSpans(text, members).flatMap((s) =>
      s.all ? members.map((m) => m.id) : [s.bot.id],
    )
    const addresses = req.to?.length ? req.to : mentions.length ? mentions : [original?.from ?? team.leadId]
    if (!Array.isArray(addresses)) throw new Error('Recipients must be an array')
    const to = [...new Set(addresses.map((a) => (a === 'user' ? 'user' : teamMember(store, team.id, a).id)))]
    return this.deliver({
      teamId: team.id,
      from: actor?.id ?? 'user',
      to,
      text,
      kind: 'message',
      unattended: Boolean(actor),
      exchangeId: original?.exchangeId,
      replyTo: original?.id,
      taskId: original?.taskId,
      runId: source?.runId ?? original?.runId,
      contextTaskId: source?.contextTaskId ?? original?.contextTaskId,
    })
  }

  // Earlier records predate assignmentId. Their initial task delivery is the
  // matching sent message and remains addressable after upgrading the host.
  assignment(task) {
    return (
      this.store.get('messages', task.assignmentId) ??
      this.store
        .all('messages')
        .findLast(
          (m) =>
            m.taskId === task.id &&
            (!m.kind || m.kind === 'assignment') &&
            m.to?.includes(task.ownerId) &&
            !m.replyTo,
        )
    )
  }

  currentAssignment(task, turn) {
    const message = this.assignment(task)
    return message && task.ownerId === turn.memberId && message.id === turn.messageId
  }

  turnStarted(turn) {
    const task = this.store.get('tasks', turn.taskId)
    if (task?.status === 'assigned' && this.currentAssignment(task, turn))
      this.change(task, { status: 'working', activeTaskTurnId: turn.id })
  }

  turnEnded({ member, turn, status, reason, answer }) {
    const { store } = this
    const original = store.get('messages', turn.messageId)
    if (!original) return
    const task = store.get('tasks', original.taskId ?? turn.taskId)
    const assigned = task && this.currentAssignment(task, turn)
    if (assigned && task.status === 'transferring') {
      if (status === 'unknown')
        this.markFailed(task, 'unknown', reason || 'Could not verify termination of the previous assignment')
      else this.redispatch(task, task.pendingOwnerId)
      return
    }
    if (assigned && ['assigned', 'working'].includes(task.status)) {
      if (status === 'completed') this.change(task, { status: 'awaiting-report', activeTaskTurnId: null })
      else this.markFailed(task, status, reason || `Assignment turn ended: ${status}`)
    }
    if (
      !answer?.trim() ||
      store.all('messages').some((m) => m.turnId === turn.id && m.replyTo === original.id)
    )
      return
    // A submitted report is the canonical answer. A worker's closing chatter
    // must not create a second report or wake the requester a second time.
    if (assigned && task.reportMessageId && task.reportAssignmentId === original.id) return
    const kind = original.kind ?? (task ? 'assignment' : 'message')
    const isReply = kind === 'message'
    const originIsReport = kind === 'report'
    const ackTo = kind === 'ack' ? ['user'] : [original.from]
    this.deliver(
      {
        teamId: member.teamId,
        from: member.id,
        to: ackTo,
        kind: isReply || originIsReport ? 'ack' : 'progress',
        text: answer,
        turnId: turn.id,
        taskId: original.taskId,
        runId: original.runId,
        contextTaskId: original.contextTaskId,
        unattended: original.unattended,
        exchangeId: original.exchangeId,
        replyTo: original.id,
        status,
      },
      { enqueue: isReply && status === 'completed' && !store.require('teams', member.teamId).stopped },
    )
  }

  verifyReporter(task, actor, req) {
    if (actor && actor.id !== task.ownerId) throw new Error('Only the assigned member may submit this task')
    const current = this.assignment(task)
    if (!current) throw new Error('Task has no dispatched assignment')
    if (req.assignmentId && current.id !== req.assignmentId) throw new Error('Task assignment changed')
    if (actor) {
      const active = this.store.get('turns', this.store.get('members', actor.id)?.activeTurnId)
      if ((active?.runId ?? null) !== (task.runId ?? null))
        throw new Error('Cannot submit evidence from a different run')
      const source = active && this.store.get('messages', active.messageId)
      if (source?.taskId === task.id && source.kind === 'assignment' && source.id !== current.id)
        throw new Error('Task assignment changed')
      if ((task.attempt ?? 1) > 1 && !req.assignmentId && active && source?.id !== current.id)
        throw new Error('Use the current assignment ID to report this attempt')
    }
    return current
  }

  cancelQueuedAssignment(task) {
    const original = this.assignment(task)
    if (!original) return
    for (const command of this.store.all('commands')) {
      if (command.messageId === original.id && command.status === 'queued')
        this.store.update('commands', command.id, { status: 'cancelled' })
    }
  }

  transfer(req) {
    const task = this.task(req, true)
    const owner = teamMember(this.store, task.teamId, req.ownerId ?? req.to)
    if (task.ownerId === owner.id) throw new Error('Choose a different task owner')
    if (['completed', 'skipped', 'transferring'].includes(task.status))
      throw new Error('This task cannot be transferred')
    const previous = this.store.require('members', task.ownerId)
    if (task.failure?.kind === 'unknown' && ['unknown', 'disconnected'].includes(previous.status)) {
      throw new Error('Reconnect the previous owner and resolve its unknown turn before transferring')
    }
    const active = this.store.get('turns', previous.activeTurnId)
    if (active && this.currentAssignment(task, active)) {
      if (!this.stopTurn) throw new Error('The previous assignment is still running')
      const transferring = this.change(task, { status: 'transferring', pendingOwnerId: owner.id })
      this.stopTurn(task.ownerId, active.id)
      return transferring
    }
    return this.redispatch(task, owner.id)
  }

}

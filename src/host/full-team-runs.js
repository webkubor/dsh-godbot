import { runOrigin } from './run-origin.js'
import { createHash, randomUUID } from 'node:crypto'
import { AutomationError } from './automation-runs.js'
import { activeTeam, record, required } from './team.js'

const tasks = 'fullTeamTasks'
const works = 'fullTeamWork'
const evidence = 'fullTeamEvidence'
const running = row => row?.status === 'running'
const marker = id => '[NativeCrew CI ' + id + ']'
const unavailable = () => new AutomationError(404, 'No accessible bound Bot or group for this target')

export class FullTeamRuns {
  constructor(service) {
    this.service = service
    this.store = service.store
    // The Host can die between an external dispatch and its receipt. Never replay
    // that dispatch or sign off on an outcome whose terminal event was lost.
    for (const task of this.store.all(tasks).filter(running)) {
      this.store.update(tasks, task.id, { status: 'unknown', detail: 'Host restarted before the NativeCrew receipt' })
    }
  }

  targets(teamId) {
    return this.service.botTasks?.targets(teamId) ?? []
  }

  async authorize(teamId, id) {
    if (!this.targets(teamId).some(target => target.id === id)) throw unavailable()
    return id
  }

  async submit(principal, requestId, input) {
    if (this.service.closing) throw new AutomationError(503, 'Host is stopping')
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256 || input.ownerId != null)
      throw new AutomationError(400, 'A request ID is required. The grant specifies the full-team target.')
    const title = required(input.title, 'Task title')
    const criteria = required(input.criteria, 'Acceptance criteria')
    const targetId = await this.authorize(principal.teamId, principal.targetId)
    const receipt = JSON.stringify([principal.id, requestId])
    const fingerprint = createHash('sha256').update(JSON.stringify([targetId, title, criteria])).digest('hex')
    const prior = this.store.get('automationRequests', receipt)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AutomationError(409, 'Request ID already used for different input')
      return { runId: prior.runId, teamId: principal.teamId, targetId }
    }
    if (this.service.runtime?.readOnly()) throw new AutomationError(409, 'Bot workspace is read-only')
    activeTeam(this.store, principal.teamId)
    this.assertIdle(targetId)
    const rootTaskId = randomUUID(), runId = randomUUID()
    const run = record({ id: runId, rootTaskId, teamId: principal.teamId, principalId: principal.id, targetId, title, criteria, attempt: 1 })
    this.store.transaction(() => {
      this.store.put('automationRuns', run)
      this.store.put('automationRequests', { id: receipt, fingerprint, runId })
      this.task(run, rootTaskId, targetId)
    })
    this.dispatch(run)
    return { runId, teamId: run.teamId, targetId }
  }

  task(run, id, targetId, parentTaskId, workId = id) {
    const prior = this.store.get(tasks, id)
    const row = this.store.put(tasks, record({ ...prior, id, runId: run.id, teamId: run.teamId, targetId, workId,
      parentTaskId, attempt: run.attempt, status: 'running', roomSeq: null, questionId: null, questionSession: null, waitingForChildren: false, reviewedEvidenceRevision: null, evidenceRevision: prior?.evidenceRevision ?? 0, detail: null }))
    this.store.put(works, { id: workId, taskId: id, runId: run.id })
    return row
  }

  live(id) {
    if (!id) return
    const key = this.store.get(works, id)
    const row = key && this.store.get(tasks, key.taskId)
    return running(row) && row.workId === id ? row : undefined
  }

  assertIdle(targetId) {
    if (this.store.all(tasks).some(row => row.targetId === targetId && running(row))) throw new AutomationError(409, 'A CI run already owns this target')
  }

  dispatch(run, feedback) {
    const rt = this.service.runtime
    const work = this.store.require(tasks, run.rootTaskId).workId
    const [kind, id] = run.targetId.split('/')
    const initiator = runOrigin('ci', run.principalId)
    const text = [marker(work), run.title, 'Acceptance criteria: ' + run.criteria, feedback && 'Owner requested a revision: ' + feedback].filter(Boolean).join('\n')
    const send = async () => {
      if (kind === 'room') {
        rt.openWork(work, { room: id })
        await rt.sendUser({ sessionId: id, requestId: work, initiator, content: [{ type: 'text', text }] })
      } else {
        rt.openWork(work, { to: id })
        await rt.deliver({ role: 'request', fromName: 'NativeCrew CI', toId: id, exchangeId: work, text, initiator })
      }
    }
    void send().catch(() => this.end(work, 'unknown', 'Delivery could not be confirmed'))
  }

  end(id, status, detail) {
    const row = this.live(id)
    if (row) this.store.update(tasks, row.id, { status, detail })
  }

  report(id, text, receipt) {
    const row = this.live(id)
    if (!row) return
    if (!text?.trim()) return this.end(id, 'unknown', 'No attributable evidence was returned')
    const revision = row.evidenceRevision + 1
    this.store.transaction(() => {
      this.store.put(evidence, record({ runId: row.runId, taskId: row.id, kind: 'report', revision, attempt: row.attempt, evidence: text, receipt }))
      this.store.update(tasks, row.id, { status: 'reported', waitingForChildren: false, evidenceRevision: revision })
    })
  }

  attach(rt) {
    if (this.rt === rt || !rt.openWork) return
    this.detach?.()
    this.rt = rt
    const wrap = (object, key, make) => {
      const old = object[key]
      const next = make(old.bind(object))
      object[key] = next
      return () => { if (object[key] === next) object[key] = old }
    }
    const disposers = []
    const hook = (object, key, make) => disposers.push(wrap(object, key, make))
    const activeRooms = roomId => this.store.all(tasks).filter(row => running(row) && row.targetId === 'room/' + roomId)
    const current = sessionId => {
      const info = rt.live.get(sessionId)?.info
      return this.live(rt.workOf(info)) || this.live(info?.exchangeId)
    }
    const permitted = (row, targetId) => this.targets(row.teamId).some(target => target.id === targetId)
    hook(rt, 'openWork', old => (id, args) => {
      const parent = this.live(args.parent)
      if (parent) {
        const target = args.to ? 'bot/' + args.to : args.room ? 'room/' + args.room : 'subagent/' + args.child
        if (!args.child && !permitted(parent, target)) throw unavailable()
        this.task(this.store.require('automationRuns', parent.runId), id, target, parent.id)
      }
      return old(id, args)
    })
    hook(rt, 'holdWork', old => (id, text) => {
      const task = this.live(id)
      if (task) this.store.update(tasks, task.id, { waitingForChildren: true })
      return old(id, text)
    })
    hook(rt, 'closeWork', old => (id, name, text, extra) => {
      const result = old(id, name, text, extra)
      this.service.botTasks?.botReply(id, text)
      const row = this.live(id)
      if (row && !row.targetId.startsWith('room/')) this.report(id, text, { workId: id, source: 'handoff' })
      return result
    })
    hook(rt, 'settleSubWork', old => (id, text, child) => {
      const work = this.live(id) ?? this.live(child)
      const result = old(id, text, child)
      if (work) this.report(work.workId, text, { workId: work.workId, source: 'subagent' })
      return result
    })
    for (const name of ['dropWork', 'abandonWork']) hook(rt, name, old => (id, ...args) => {
      this.end(id, name === 'abandonWork' ? 'stopped' : 'unknown', 'NativeCrew ' + name)
      const result = old(id, ...args)
      if (name === 'dropWork' || result) this.service.botTasks?.botFailed(id, 'unknown', 'Bot 已结束此派工，尚无结果回执。')
      return result
    })
    hook(rt, 'postToRoom', old => (room, sender, text, extra, ...rest) => {
      const child = this.live(extra?.sub)
      if (child) text = marker(child.workId) + '\n' + text
      return old(room, sender, text, extra, ...rest)
    })
    hook(rt, 'deliver', old => async args => {
      const reply = this.store.get(works, args.replyTo)
      if (!args.toId && args.role === 'reply' && (reply || this.service.botTasks?.ownsWork(args.replyTo))) return
      if (args.role === 'room') {
        const round = [...rt.roomProgress.values()].find(r => r.roomId === args.roomId && r.startSeq != null)
        const parent = round && activeRooms(args.roomId).find(row => row.roomSeq === round.startSeq)
        if (parent) {
          if (!permitted(parent, 'bot/' + args.toId)) {
            this.end(parent.workId, 'unknown', 'Group access changed during the run')
            throw unavailable()
          }
          rt.openWork(args.exchangeId, { parent: parent.workId, to: args.toId })
          args = { ...args, work: args.exchangeId }
        }
      }
      return old(args)
    })
    hook(rt.ledger, 'append', old => (book, entry) => {
      const result = old(book, entry)
      if (book.startsWith('group-')) {
        for (const row of activeRooms(book.slice(6))) {
          const sourceMatches = row.parentTaskId ? Boolean(entry.botId) : Boolean(entry.session && !entry.botId)
          if (entry.seq && sourceMatches && !row.roomSeq && entry.text?.split('\n', 2).includes(marker(row.workId))) {
            this.store.update(tasks, row.id, { roomSeq: entry.seq })
          } else if (entry.event === 'round' && row.roomSeq && entry.from <= row.roomSeq && entry.to >= row.roomSeq) {
            const receipt = { source: 'group-ledger', book, from: entry.from, to: entry.to, workId: row.workId }
            const mixed = rt.ledger.range(book, entry.from, entry.to).some(line => line.session && line.seq !== row.roomSeq && !line.botId)
            if (mixed || entry.from !== row.roomSeq) this.end(row.workId, 'unknown', 'Another post shared this group round')
            else if (entry.stopped) this.end(row.workId, 'stopped', 'Group round was stopped')
            else if (entry.failed?.length) this.end(row.workId, 'failed', 'Group member failed')
            else if (!this.store.forRun(tasks, row.runId).some(task => task.parentTaskId === row.id && task.attempt === row.attempt))
              this.end(row.workId, 'unknown', 'No attributable group member turn')
            else void rt.ledger.written(book).then(() => {
              if (this.rt !== rt || this.service.closing) return
              this.report(row.workId, 'Group round ' + entry.from + '–' + entry.to, receipt)
              if (!row.parentTaskId) rt.closeWork(row.workId, 'NativeCrew CI', '')
            }, () => { if (!this.service.closing) this.end(row.workId, 'unknown', 'Group ledger write failed') })
          }
        }
      }
      return result
    })
    disposers.push(rt.ctx.on('subagent/end', info => {
      const work = this.live(info?.runId) ?? this.live(info?.id)
      if (work && info.stopReason !== 'completed') {
        const outcome = { aborted: 'stopped', error: 'failed', failed: 'failed' }[info.stopReason] ?? 'unknown'
        this.end(work.workId, outcome, 'Subagent outcome: ' + (info.stopReason ?? 'unconfirmed'))
      }
    }, { prepend: true }))
    disposers.push(rt.ctx.on('tools/execute', async (exec, next) => {
      const task = current(exec.agent?.session?.id ?? exec.agent?.id)
      if (task && ((exec.name === 'message_bot' && exec.arguments?.reply_to === 'user') ||
        (exec.name === 'post_to_group' && !exec.arguments?.report_back))) {
        throw new Error('CI delegations require a tracked reply to the requesting Bot')
      }
      return next()
    }, { prepend: true }))
    disposers.push(rt.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      this.service.botTasks?.observeEnd(session.id, rt.live.get(session.id), event.data?.reason)
      const row = current(session.id)
      if (!row) return
      const entry = rt.live.get(session.id)
      const question = rt.state.questions?.[session.id]
      if (question?.id) this.store.update(tasks, row.id, { questionId: question.id, questionSession: session.id })
      if (entry.joined?.some(item => rt.workOf(item.info) !== row.workId)) return this.end(row.workId, 'unknown', 'Mixed requests in one NativeCrew turn')
      if (event.data?.reason?.kind === 'error') return this.end(row.workId, 'failed', 'DSH model turn failed')
      if (event.data?.reason?.kind === 'aborted') return this.end(row.workId, 'stopped', 'DSH turn stopped')
      if (entry.info?.role === 'room') {
        this.report(row.workId, entry.texts?.join('\n\n'), { source: 'group-member-turn', sessionId: session.id, exchangeId: row.workId, turnId: entry.turn })
        rt.closeWork(row.workId, rt.botOf(rt.selfOf(session.id))?.name ?? 'Group member', entry.texts?.join('\n') ?? '')
      }
    }, { prepend: true }))
    const detach = () => {
      if (this.rt !== rt) return
      for (const dispose of disposers.reverse()) dispose()
      this.rt = undefined
      this.detach = undefined
    }
    this.detach = detach
    rt.ctx.effect(() => detach, 'NativeCrew CI full-team run receipts')
  }

  async inspect(principal, runId, exported = false) {
    const run = this.store.get('automationRuns', runId)
    if (!run?.targetId || run.teamId !== principal.teamId || run.targetId !== principal.targetId) throw new AutomationError(404, 'Unknown run')
    await this.authorize(run.teamId, run.targetId)
    const current = this.store.forRun(tasks, run.id).filter(task => task.attempt === run.attempt)
    const accessible = new Set(this.targets(run.teamId).map(target => target.id))
    if (current.some(row => !row.targetId.startsWith('subagent/') && !accessible.has(row.targetId))) throw unavailable()
    const rt = this.rt
    const questions = Object.entries(rt.state.questions ?? {}).flatMap(([sessionId, q]) =>
      current.some(row => row.questionId === q.id && row.questionSession === sessionId) ? [{ id: q.id, type: 'question' }] : [])
    const pending = (rt.approvalsView?.() ?? []).filter(q => {
      const info = rt.live.get(q.sessionId)?.info
      return current.some(row => row.workId === rt.workOf(info) || row.workId === info?.exchangeId)
    }).map(q => ({ id: q.id, type: 'approval' })).concat(questions)
    let state = 'running', reason = 'NativeCrew work in progress'
    if (current.some(row => row.status === 'unknown')) { state = 'unknown'; reason = 'NativeCrew outcome needs reconciliation' }
    else if (current.some(row => row.status === 'failed')) { state = 'failed'; reason = 'A required NativeCrew turn failed' }
    else if (current.some(row => row.status === 'stopped')) { state = 'stopped'; reason = 'Required work stopped' }
    else if (pending.length || current.some(row => row.status === 'reported')) { state = 'needs_input'; reason = pending.length ? 'An owner approval is pending' : 'Owner review required' }
    else if (current.length && current.every(row => row.status === 'completed')) { state = 'completed'; reason = 'Owner accepted every work receipt' }
    const result = { runId, targetId: run.targetId, rootTaskId: run.rootTaskId, teamId: run.teamId, state, reason, tasks: current, pending }
    if (exported) {
      const all = this.store.forRun(tasks, run.id)
      if (all.some(row => !row.targetId.startsWith('subagent/') && !accessible.has(row.targetId))) throw unavailable()
      result.reports = this.store.forRun(evidence, run.id)
    }
    return result
  }

  async review(req) {
    const run = this.store.require('automationRuns', req.runId)
    if (!run.targetId || run.teamId !== req.teamId) throw unavailable()
    const view = await this.inspect(run, run.id)
    if (this.service.runtime?.readOnly()) throw new AutomationError(409, 'Bot workspace is read-only')
    if (view.pending.length) throw new AutomationError(409, 'An owner interaction is outstanding')
    const task = this.store.require(tasks, req.taskId)
    if (this.store.require('automationRuns', run.id).attempt !== run.attempt || task.runId !== run.id || task.attempt !== run.attempt || task.status !== 'reported' || task.evidenceRevision !== req.revision)
      throw new AutomationError(409, 'Evidence has changed')
    if (!['accept', 'rework'].includes(req.decision)) throw new AutomationError(400, 'Unknown decision')
    if (req.decision === 'accept' && task.questionId) throw new AutomationError(409, 'The Bot requested an answer. Start a revision using the answered conversation.')
    const feedback = required(req.evidence, 'Review evidence')
    if (req.decision === 'rework') this.assertIdle(run.targetId)
    if (req.decision === 'rework' && this.store.forRun(tasks, run.id).some(running)) throw new AutomationError(409, 'Wait for outstanding work before starting a revision')
    const next = this.store.transaction(() => {
      this.store.put(evidence, record({ runId: run.id, taskId: task.id, kind: 'review', revision: task.evidenceRevision, attempt: run.attempt, decision: req.decision, evidence: feedback }))
      if (req.decision === 'accept') {
        this.store.update(tasks, task.id, { status: 'completed', reviewedEvidenceRevision: task.evidenceRevision })
        return
      }
      const revised = this.store.update('automationRuns', run.id, { attempt: run.attempt + 1 })
      this.task(revised, run.rootTaskId, run.targetId, undefined, randomUUID())
      return revised
    })
    if (next) this.dispatch(next, feedback)
    return { reviewed: task.id, revision: task.evidenceRevision }
  }

  reviews(teamId) {
    const targets = new Set(this.targets(teamId).map(target => target.id))
    return this.store.all(tasks).flatMap(task => {
      if (task.teamId !== teamId || task.status !== 'reported') return []
      const run = this.store.get('automationRuns', task.runId)
      if (run?.attempt !== task.attempt || !targets.has(run.targetId) || !this.store.forRun(tasks, run.id)
        .every(row => row.targetId.startsWith('subagent/') || targets.has(row.targetId))) return []
      const latest = this.store.forRun(evidence, run.id).findLast(row => row.taskId === task.id && row.kind === 'report')
      return [{ runId: run.id, taskId: task.id, title: run.title, targetId: task.targetId, revision: task.evidenceRevision, evidence: latest?.evidence }]
    })
  }
}

import { createHash } from 'node:crypto'

const collection = 'usageDeferred'
const prefix = 'godbot-budget-'
function keyFor(session, message) {
  // DSH can recreate the reminder envelope when delivery raced a restart.
  // Its authenticated schedule source carries the original ID and occurrence.
  // NativeCrew likewise resends the same exchange under a fresh inbox MessageId.
  const {source} = message
  let identity = message.id
  if (source?.kind === 'schedule') identity = message.content
  else if (source?.kind === 'bot' && source.exchangeId) identity = [source.role,source.exchangeId]
  return createHash('sha256').update(JSON.stringify([session,source?.kind,identity])).digest('hex')
}
export function taskBudgetReceipt(store, sessionId, workId) {
  if (!sessionId || !workId) return
  return store.get(collection, keyFor(sessionId, { source: { kind: 'bot', role: 'request', exchangeId: workId } }))
}
// What a Bot's agent CLI already said by itself only shows: that turn spends nothing.
const continuation = m => ['user-question-reply','subagent-settled','agent-message'].includes(m.source?.kind) ||
  (m.source?.kind === 'bot' && (
    (['reply','report'].includes(m.source.role) && typeof m.source.replyTo === 'string') ||
    (m.source.role === 'post' && (m.source.late || m.source.progress || m.source.done || m.source.failed)) ||
    m.source.role === 'background'))
// The scheduler injects these as non-waking context when its record changes.
// Restoring one with followup would turn a configuration notice into new work.
const passiveNotice = m => m.source?.kind === 'schedule' && m.content?.[0]?.type === 'text' &&
  m.content[0].text.startsWith('[SCHEDULE CHANGE]\n')
const automated = m => ['bot','schedule','goal','subagent-settled','agent-message'].includes(m.source?.kind)
const targetOf = (rt,id) => rt.isBotSession(id) ? rt.selfOf(id) : rt.roomOf(id)?.id
const pending = r => ['held','releasing'].includes(r.status)
const hasInsertion = (session,id) => session.snapshotEvents().some(e =>
  (e.type === 'agent/inbox/spliced' && e.data.inserted?.some(m => m.id === id)) ||
  (e.type === 'user/message' && e.data.id === id))

// A rejected DSH pre-step has already claimed its input. Store that input before
// returning a rejection. Replay has its own stable MessageId and delivery receipt.
export class BotBudget {
  constructor(policy, ctx) {
    this.policy = policy
    this.service = policy.service
    this.store = policy.store
    ctx.on('agent/pre-step',(payload,next) => this.preStep(payload,next),{prepend:true})
    this.changed()
  }

  attach(rt) {
    // Selecting the speaker itself can cost tokens, before the chosen member starts.
    rt.allowNativeCrewRouting = room => !this.policy.refusal('profile',true) &&
      room.members.some(id => !this.policy.refusal(id,true))
  }

  view(subject) {
    return this.store.all(collection).filter(r => (subject === 'profile' || r.owner === subject) &&
      (pending(r) || r.status === 'unknown')).map(({id,owner,sessionId,origin,status,limit,resetsAt,passive}) =>
      ({id,owner,sessionId,origin,status,limit,resetsAt,passive}))
  }

  async preStep({agent,messages,step},next) {
    if (step !== 1 || !messages?.length || this.service.closing) return next()
    const rt = this.service.runtime
    if (!rt) return next()
    const owner = targetOf(rt,agent.id)
    if (!owner) return next()
    const allowed = []
    for (const msg of messages) {
      const replay = typeof msg.id === 'string' && msg.id.startsWith(prefix)
      const id = replay ? msg.id.slice(prefix.length) : keyFor(agent.id,msg)
      const prior = this.store.get(collection,id)
      // On recovery DSH can present the original claimed input again. Once its
      // replacement was reserved, only the replacement may enter a model step.
      if (!replay && prior && prior.status !== 'held') continue
      const denied = !continuation(msg) && this.policy.refusal(owner,automated(msg))
      if (!denied) {
        if (!replay && prior) this.store.update(collection,id,{status:'sent',message:null})
        allowed.push(msg)
        continue
      }
      this.store.put(collection,{id,sessionId:agent.id,owner,origin:msg.source?.kind,
        status:'held',passive:passiveNotice(msg),message:prior?.message ?? msg, ...denied})
      if (msg.source?.role === 'room') rt.roomWaiters.get(msg.source.exchangeId)?.resolve({working:true})
      this.scheduleAt(denied.resetsAt)
    }
    if (allowed.length === messages.length) return next()
    if (!allowed.length) return {kind:'reject'}
    // DSH passes its claimed array to the rest of the waterfall and to its
    // final step assembly. A manual message sharing this step may still enter.
    messages.splice(0,messages.length,...allowed)
    return next()
  }

  scheduleAt(when) {
    if (this.closed || this.service.closing || (this.timer && this.wakesAt <= when)) return
    clearTimeout(this.timer)
    this.wakesAt = when
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.running) { this.again = true; return }
      this.running = this.drain().catch(() => this.scheduleAt(this.policy.clock()+5000)).finally(() => {
        this.running = null
        if (this.again) { this.again = false; this.changed() }
      })
    },Math.min(0x7fffffff,Math.max(0,when-this.policy.clock())))
    this.timer.unref()
  }

  changed() { this.scheduleAt(this.policy.clock()) }

  async drain() {
    const rows = this.store.all(collection).filter(pending)
    if (!rows.length) return
    const rt = this.service.runtime
    for (const row of rows) {
      if (this.closed || this.service.closing) return
      if (targetOf(rt,row.sessionId) !== row.owner || rt.readOnly()) {
        this.store.update(collection,row.id,{status:'unknown'})
        continue
      }
      const denied = this.policy.refusal(row.owner,automated(row.message))
      if (denied && row.status === 'held') {
        this.store.update(collection,row.id,denied)
        this.scheduleAt(denied.resetsAt)
        continue
      }
      const agent = await rt.resolveAgent(row.sessionId)
      if (this.closed || this.service.closing) return
      const current = this.store.get(collection,row.id)
      if (!pending(current)) continue
      const replayId = prefix + row.id
      if (current.status === 'releasing') {
        this.store.update(collection,row.id,hasInsertion(agent.session,replayId)
          ? {status:'sent',message:null} : {status:'unknown'})
        continue
      }
      // A restored native inbox might still own the original. Leave it in its
      // ordinary queue and let preStep settle the durable hold when claimed.
      if ([...agent.inbox.nextStep,...agent.inbox.nextTurn].some(m => m.id === row.message.id)) {
        this.scheduleAt(this.policy.clock()+1000)
        continue
      }
      this.store.update(collection,row.id,{status:'releasing'})
      try {
        const message = {...row.message,id:replayId}
        if (passiveNotice(message)) agent.inject(message)
        else agent.followup(message)
        const flushed = await rt.ctx.sessions.flush(agent.session)
        if (!flushed) throw new Error('DSH did not acknowledge persistence of the deferred message')
        if (!this.closed && !this.service.closing && this.store.get(collection,row.id).status === 'releasing')
          this.store.update(collection,row.id,{status:'sent',message:null})
      } catch {
        if (!this.closed && !this.service.closing) this.store.update(collection,row.id,{status:'unknown'})
      }
    }
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
  }
}

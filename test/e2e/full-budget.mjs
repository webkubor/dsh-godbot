import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { logLines } from '../../src/host/backup-files.js'
import { openFullTeam } from './native-ui.mjs'
import { until } from './host.mjs'

export async function fullBudget(host,note,epoch) {
  await openFullTeam(host)
  const owner = (action,subject,settings) => host.rpc('dispatch',{request:{action,subject,settings}})
  const set = (id,settings) => owner('budget.configure',id,settings)
  const view = id => owner('budget.view',id)
  const make = name => host.bot('create-bot',{name,role:'Review tasks',model:'deepseek-official/deepseek-flash'})
  const a = await make('Budget Writer'), b = await make('Budget Reviewer')
  const room = await host.bot('create-room',{name:'Budget room',members:[a.id,b.id],admin:b.id})
  const runs = new Map(), ids = {}
  const makeMark = tag => (ids[tag] = tag+'-'+randomUUID().slice(0,8))
  for (const key of ['prime','manual','held','peer','room','scheduledRoom','reset']) makeMark(key)
  host.model.reply = body => {
    if (!body.tools?.length) return 'auxiliary request'
    // DSH may append context messages after the user prompt. The latest user
    // block carrying a fixture marker identifies the operation being executed.
    const input = [...body.messages].reverse().filter(m => m.role === 'user')
      .map(m => JSON.stringify(m.content)).find(text => Object.values(ids).some(id => text.includes(id))) ?? ''
    const mark = Object.values(ids).filter(m => input.includes(m)).sort((a,b) => input.lastIndexOf(b)-input.lastIndexOf(a))[0]
    if (mark) runs.set(mark,(runs.get(mark) ?? 0)+1)
    return mark ? 'receipt '+mark : 'ack'
  }
  const send = (id, msg) => host.bot('send',{sessionId:id,text:msg})
  const read = async (h,bot,mark) => JSON.stringify(await h.bot('chat',{botId:bot.id})).includes('receipt '+mark)
  const later = when => new Date(when).toISOString()
  const schedule = (bot,mark,when) => host.bot('schedule-create',{target:bot.id,title:'do '+mark,prompt:mark,when:{kind:'at',at:later(when)}})
  await send(a.id,ids.prime)
  await until(async () => (await view(a.id)).daily.tokens > 0 && await read(host,a,ids.prime),'full team member usage and receipt')
  await set(a.id,{dailyTokens:1,stops:'unattended'})
  await send(a.id,ids.manual)
  await until(() => read(host,a,ids.manual),'direct owner message under unattended-only member cap')
  const wakeAt = Math.max(epoch+12000,Date.now()+12000)
  await schedule(a,ids.held,wakeAt)
  await schedule(b,ids.peer,wakeAt)
  const hold = await until(async () => (await view(a.id)).deferred.find(d => d.origin === 'schedule' && !d.passive),'one-off schedule deferred at member cap')
  try { await until(() => read(host,b,ids.peer),'unrestricted peer schedule executed') }
  catch (error) {
    const records = await host.bot('schedules')
    note('schedule-diagnostic',{runs:[...runs],members:[a.id,b.id],deferred:(await view('profile')).deferred,
      tasks:records.tasks.map(t => ({title:t.title,state:t.state,target:t.target,owner:t.botId})),
      localModelCalls:host.model.calls.slice(-10).map(c=>({session:c.sessionId,markers:Object.values(ids).filter(id=>JSON.stringify(c.body.messages).includes(id))}))})
    throw error
  }
  assert.equal(runs.get(ids.held) ?? 0,0)
  // The profile budget must also apply to an automatically selected speaker.
  await set('profile',{monthlyTokens:1,stops:'unattended'})
  await host.rpc('dispatch',{request:{action:'team-workspace.routing',roomId:room.id,enabled:true}})
  let classifications = 0
  const reply = host.model.reply
  host.model.reply = body => { if (JSON.stringify(body.system).includes('NativeCrew room routing.')) classifications++; return reply(body) }
  await send(room.id,ids.room)
  const groupHold = await until(async () => (await view('profile')).deferred.find(d => d.owner === b.id && d.origin === 'bot'),'group-assigned member deferred at profile cap')
  assert.equal(classifications,0)
  assert.equal(runs.get(ids.room) ?? 0,0)
  const tasks = await host.bot('schedules')
  assert.equal(tasks.tasks.find(t => t.title === 'do '+ids.held).state,'finished')
  await host.restart()
  assert.ok((await view('profile')).deferred.some(row => row.id === groupHold.id))
  assert.ok((await view(a.id)).deferred.some(row => row.id === hold.id))
  const boundary = new Date(epoch)
  boundary.setUTCMonth(boundary.getUTCMonth()+1,1); boundary.setUTCHours(1,0,0,0)
  host.env.GODBOT_E2E_EPOCH = String(boundary.getTime())
  await host.restart()
  // An uncapped manual request may proceed even if it shares a step with a
  // non-waking schedule-change notice. A new period admits the waiting jobs.
  await set('profile',{})
  await until(() => read(host,a,ids.held),'one-off reminder resumed after reset')
  let posted
  try { posted = await until(async () => (await host.bot('room-chat',{roomId:room.id})).items.find(r => r.text?.includes('receipt '+ids.room)),'held room result delivered to the original group') }
  catch (error) {
    const rows = (await host.bot('group-rows',{roomId:room.id,from:0,to:2e9})).rows
    note('group-budget-diagnostic',{runs:[...runs],deferred:(await view('profile')).deferred,rows:rows.map(r=>({kind:r.kind,bot:r.botId,text:r.text?.slice(0,250)}))})
    throw error
  }
  assert.ok(posted.botId === b.id || posted.name === b.name,JSON.stringify(posted))
  assert.equal(runs.get(ids.held),1)
  assert.equal(runs.get(ids.room),1)
  await host.restart()
  assert.equal((await view('profile')).deferred.length,0)
  // Ensure neither an already-fired DSH schedule nor the durable hold replays on restart.
  await send(b.id,ids.reset)
  await until(() => read(host,b,ids.reset),'full team target still accepts new work')
  if (runs.get(ids.held) !== 1 || runs.get(ids.room) !== 1) {
    const db = new DatabaseSync(join(host.home,'godbot/web/godbot.sqlite3'),{readOnly:true})
    const records = db.prepare("SELECT data FROM records WHERE collection='usageDeferred'").all().map(r => JSON.parse(r.data))
    db.close()
    const root = join(host.home,'sessions')
    const files = readdirSync(root,{recursive:true}).filter(f=>f.endsWith('session.v4.jsonl.zstd') && records.some(r=>f.includes(r.sessionId)))
    const journal = []
    for (const f of files) for (const line of logLines(readFileSync(join(root,f)),true)) {
      const events = [line]
      while (events.length) {
        const value = events.pop()
        if (value?.source?.kind === 'schedule' && value.content && value.id) {
          journal.push({file:f.split('/').at(-2),id:value.id,type:line.type,text:JSON.stringify(value.content).slice(0,270)})
          break
        }
        if (value && typeof value === 'object') events.push(...Object.values(value))
      }
    }
    note('durable-budget-diagnostic',{runs:[...runs],journal,receipts:records.map(({message,...r})=>r)})
  }
  assert.equal(runs.get(ids.held),1)
  assert.equal(runs.get(ids.room),1)
  note('full-team-budget',{member:a.id,group:room.id,memberHold:hold.id,profileHold:groupHold.id,manual:ids.manual,
    scheduled:ids.held,unrestrictedPeer:ids.peer,groupMessage:ids.room,heldClassificationCalls:classifications,scheduledModelCalls:runs.get(ids.held),groupModelCalls:runs.get(ids.room)})
}

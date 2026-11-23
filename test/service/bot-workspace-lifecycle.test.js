import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { workspaceOperations } from '../../src/host/plugin.js'
import { NativeCrewService, readOnlyWorkspaceSnapshot } from '../../src/host/service.js'
import { Store } from '../../src/host/store.js'

function runtime() {
  let reason = 'Bot team is read-only'
  const bot = { id: 'existing-bot', name: 'Existing Bot' }
  return { state:{ bots:{[bot.id]:bot},rooms:{},mainBotIds:[bot.id] },chatOf:id=>id+'-part',
    botOf:id=>id===bot.id?bot:undefined, readOnly:()=>reason, setReadOnly:value=>{reason=value},
    refresh:async()=>{}, onSaved:()=>()=>{} }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
test('read-only mount can inspect the real Bot roster and new tasks without migrating or touching legacy work', async t => {
  const dir = await mkdtemp(join(tmpdir(),'godbot-readonly-mount-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const rt = runtime()
  assert.equal(readOnlyWorkspaceSnapshot(dir,rt).bots[0].id,'existing-bot')
  assert.equal(existsSync(join(dir,'godbot-owner.sqlite3')),false)
  const raw = new Store(dir)
  raw.put('teams',{id:'retired'})
  raw.put('tasks',{id:'retired-task', teamId:'retired'})
  raw.put('tasks',{id:'current-task', teamId:'godbot-workspace'})
  raw.put('botTaskDeliveries',{ id:'queued', botId:'existing-bot', messageId:'m', state:'queued' })
  raw.close()
  const scope = workspaceOperations(rt, () => {
    const service = new NativeCrewService({stateDir:dir, runtime:rt})
    return { service, start:async()=>{}, close:()=>service.close() }
  })
  t.after(()=>scope.close())
  assert.equal(await scope.ready(),undefined)
  assert.throws(()=>new NativeCrewService({stateDir:dir, runtime:rt}),/read-only/)
  const view = readOnlyWorkspaceSnapshot(dir,rt)
  assert.equal(view.readOnly,true)
  assert.equal(view.bots[0].sessionId,'existing-bot-part')
  assert.deepEqual(view.tasks.map(t=>t.id),['current-task'])
  const check = new DatabaseSync(join(dir,'godbot.sqlite3'),{readOnly:true})
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM records WHERE collection='teams'").get().n,1)
    assert.equal(check.prepare("SELECT json_extract(data,'$.state') AS state FROM records WHERE collection='botTaskDeliveries'").get().state,'queued')
  } finally { check.close() }
  rt.setReadOnly(undefined)
  const [a,b] = await Promise.all([scope.ready(),scope.ready()])
  assert.equal(a,b)
  assert.deepEqual(a.service.database.all('teams'),[])
  assert.equal(a.service.botTasks.snapshot().bots[0].name,'Existing Bot')
  rt.setReadOnly('Team became read-only')
  for (const action of ['budget.configure','provider-account-default','sandbox-settings-set','automation.grant','automation.people.invite','task.create']) {
    assert.throws(()=>a.service.dispatch({action}),/read-only/)
  }
})

test('an unloaded workspace never publishes a late service and cleanup runs once on startup error', async () => {
  const rt = runtime()
  rt.setReadOnly(undefined)
  const gate = Promise.withResolvers()
  let starts=0,closes=0
  const scope=workspaceOperations(rt,()=>({start:async()=>{starts++;await gate.promise}, close:async()=>{closes++}}))
  const a=scope.ready(), b=scope.ready()
  await flush()
  assert.equal(starts,1)
  const stopped=scope.close()
  gate.resolve()
  await Promise.all([assert.rejects(a,/关闭/),assert.rejects(b,/关闭/),stopped])
  assert.throws(()=>scope.existing(),/就绪|关闭/)
  await scope.close()
  assert.equal(closes,1)
  const broken=workspaceOperations(rt,()=>({start:async()=>{throw new Error('startup aborted')},close:async()=>{closes++}}))
  await assert.rejects(broken.ready(),/startup aborted/)
  await broken.close()
  assert.equal(closes,2)
})

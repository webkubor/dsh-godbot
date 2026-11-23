import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { openExternal } from '../../src/drivers/external/index.js'
import { NativeCrewService } from '../fixtures/member-service.js'
import { rpc } from '../e2e/fixtures/ticket-client.mjs'

async function waitFor(read) {
  for (let n=0;n<500;n++) {
    const value = read()
    if (value) return value
    await delay(10)
  }
  throw new Error('Timed out waiting for native member')
}

test('a resident external MCP accepts writes from its current native prompt, including after reuse', async t => {
  const root = await mkdtemp(join(tmpdir(),'godbot-mcp-turn-'))
  let connections = 0, bridge
  const service = new NativeCrewService({stateDir:join(root,'db'),openDriver:async options => {
    connections++
    bridge = {url:options.mcp.url,headers:{Authorization:'Bearer ' + options.mcp.token}}
    return openExternal({...options,config:{command:process.execPath,
      args:[fileURLToPath(new URL('../external/fixtures/fake-claude.mjs',import.meta.url))]}})
  }})
  t.after(async () => { await service.close(); await rm(root,{recursive:true,force:true}) })
  await service.ready()
  const team = service.dispatch({action:'team.create',name:'Cohort',cwd:root})
  const member = service.dispatch({action:'member.add',teamId:team.id,name:'Writer',kind:'claude'})
  for (const phase of ['first','second']) {
    const cmd = service.dispatch({action:'member.send',memberId:member.id,text:'GODBOT-MEMBER-MCP '+phase})
    await waitFor(() => {
      const turnId = service.store.get('commands',cmd.id)?.turnId
      return turnId && service.store.get('turns',turnId)?.endedAt
    })
    const command = service.store.get('commands',cmd.id)
    assert.equal(service.store.get('turns',command.turnId)?.status,'completed')
    const text = service.store.all('events').filter(e=>e.turnId===command.turnId && e.type==='text').map(e=>e.text).join('')
    assert.match(text,new RegExp('TEAM SENT '+phase))
    const current = service.resident.get(member.id).bridge
    const late = await rpc(bridge,'tools/call',{name:'send_message',arguments:{to:'user',text:'idle',turnContext:current.turn.key}})
    assert.ok(late.isError)
  }
  assert.equal(connections,1)
  const old = service.resident.get(member.id).bridge
  const nativeId = service.store.get('members',member.id).nativeId
  service.dispatch({action:'member.reconnect',memberId:member.id})
  await waitFor(() => connections===2 && service.store.get('members',member.id).status==='idle')
  assert.equal(service.store.get('members',member.id).nativeId,nativeId)
  service.dispatch({action:'member.send',memberId:member.id,text:'ask-claude-perm'})
  const pending = await waitFor(()=>service.store.all('interactions').find(row=>row.status==='pending'))
  const current = service.resident.get(member.id).bridge
  await assert.rejects(old.onCall({name:'send_message',arguments:{to:'user',text:'old session',turnContext:current.turn.key}}),/no active/)
  const wrongContext = await rpc(bridge,'tools/call',{name:'send_message',arguments:{to:'user',text:'old turn',turnContext:old.turn.key}})
  assert.ok(wrongContext.isError)
  service.dispatch({action:'interaction.respond',interactionId:pending.id,decision:'deny'})
  await waitFor(()=>service.store.get('members',member.id).status==='idle')
  assert.deepEqual(service.store.all('messages').map(r=>r.text),['first','second'])
})

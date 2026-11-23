import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { NativeCrewService } from '../fixtures/member-service.js'
import { buildTerminalLaunch } from '../../src/host/terminal-launch.js'
import { getSandboxWorkspace } from '../../src/host/sandbox-accounts.js'

async function until(fn) {
  for (let i = 0; i < 200; i++) {
    const value = fn()
    if (value) return value
    await delay(10)
  }
  throw new Error('Member did not settle')
}

async function baseline(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'godbot-sandbox-member-')))
  const registry = join(root, 'registry'), shared = join(root, 'shared'), other = join(root, 'other')
  await Promise.all([registry, shared, other].map(dir => mkdir(dir, { mode: 0o700 })))
  const oldRegistry = process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
  process.env.GODBOT_SANDBOX_ACCOUNTS_DIR = registry
  const transport = join(root, 'fixture-transport')
  const log = join(root, 'launches')
  await writeFile(transport, '#!'+process.execPath+'\n'+
    "const fs=require('node:fs'); const args=process.argv.slice(2); const action=args[args.indexOf('--')+5]; "+
    "fs.appendFileSync("+JSON.stringify(log)+", String(action)+'\\n'); " +
    "if (args.includes('-R')) { console.log('ready'); process.stdin.resume() } " +
    "else if (action==='check') console.log('ready');", {mode:0o700})
  const account = (id, hostPath, guestPath) => ({
    id, name: 'Account '+id, machineId: id==='a'?'a'.repeat(32):'b'.repeat(32), uid: 1000,
    programs: { antigravity:'/opt/guest/agy', claude:'/opt/guest/claude', codex:'/opt/guest/codex' },
    start: [transport], ssh:[transport],
    workspaces:[{ hostPath, guestPath, readOnly:false, filesystem:'virtiofs', source:'workspace' }],
  })
  const save = (id, ws) => writeFile(join(registry,id+'.json'), JSON.stringify(ws), { mode:0o600 })
  await save('a',account('a', shared, '/guest/shared')); await save('b',account('b', other, '/guest/other'))
  const opens=[], stateDir=join(root,'state')
  const make = () => new NativeCrewService({stateDir, driverConfig:{antigravity:{env:{SYNTHETIC_HOST_ONLY:'fixture'}}},
    openDriver: async opts => {
      opens.push(opts)
      return { nativeId:opts.resumeId??randomUUID(), capabilities:{resume:true}, async close(){},
        async start({turnId}){opts.onEvent({type:'done',status:'completed',turnId})} }
    }})
  let service = make(); await service.ready()
  t.after(async()=>{
    await service.close()
    if (oldRegistry == null) delete process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
    else process.env.GODBOT_SANDBOX_ACCOUNTS_DIR=oldRegistry
    await rm(root,{recursive:true,force:true})
  })
  const act=(action,req={})=> service.dispatch({action,...req})
  const {id:teamId}=act('team.create',{name:'Sandbox tests',cwd:shared})
  const add=(name,opts={})=>act('member.add',{kind:'antigravity',teamId,name,...opts})
  const member=id=>service.store.require('members',id)
  async function restart(){await service.close();service=make();await service.ready()}
  return {act,add,opens,shared,other,save,account,member,restart,log,service:()=>service}
}

test('opt-in persists per profile; a sandbox member is pinned, while unbound members keep the local driver',async t=>{
  const s=await baseline(t)
  assert.deepEqual(s.act('sandbox-settings'),{enabled:false,accounts:[]})
  const plain=s.add('Plain')
  assert.equal(plain.accountProfileId,undefined)
  assert.throws(()=>s.add('Requires option',{accountProfileId:'a'}),/启用/)
  assert.equal(s.service().store.all('members').length,1)
  assert.throws(()=>s.act('sandbox-settings-set',{enabled:'true'}),/enable/)
  assert.equal(s.act('sandbox-settings-set',{enabled:true}).accounts.length,2)
  const select=s.add('Changes')
  s.act('member.profile',{memberId:select.id,accountProfileId:'b',cwd:s.other})
  await until(()=>s.member(select.id).cwd===s.other)
  assert.equal(s.member(select.id).accountProfileId,'b')
  const invalid=()=>s.add('Invalid',{accountProfileId:'b',cwd:s.shared})
  assert.throws(invalid,/outside/)
  const pinned=s.add('Pinned',{accountProfileId:'a'})
  assert.equal(pinned.sandboxBinding.hostCwd,s.shared)
  assert.equal(pinned.sandboxBinding.guestCwd,'/guest/shared')
  await s.save('a',s.account('a',s.shared,'/guest/changed-before-first-message'))
  await assert.rejects(s.service().handle(pinned),/绑定已改变/)
  assert.equal(s.opens.length,0)
  const reselected=s.act('member.profile',{memberId:pinned.id,accountProfileId:'b',cwd:s.other})
  assert.equal(reselected.sandboxBinding.guestCwd,'/guest/other')
  await s.save('a',s.account('a',s.shared,'/guest/shared'))
  s.act('member.profile',{memberId:pinned.id,accountProfileId:'a',cwd:s.shared})
  await s.service().handle(pinned); await s.service().handle(plain)
  assert.equal(s.opens[0].sandboxLaunch.guestCwd,'/guest/shared')
  assert.equal(s.opens[0].config.env,undefined)
  assert.equal(s.opens[1].sandboxLaunch,undefined)
  assert.equal(s.opens[1].config.env.SYNTHETIC_HOST_ONLY,'fixture')
  const old=s.member(pinned.id)
  assert.throws(()=>s.act('member.profile',{memberId:old.id,accountProfileId:'b',cwd:s.other}),/新建会话/)
  await s.restart()
  assert.equal(s.act('sandbox-settings').enabled,true)
  await s.service().handle(s.member(old.id))
  assert.equal(s.opens.at(-1).resumeId,old.nativeId)
  assert.equal(s.opens.at(-1).sandboxLaunch.bindingId,old.sandboxBinding.bindingId)
  await s.service().detach(old.id)
  const swapped=s.account('a',s.shared,'/guest/remapped');await s.save('a',swapped)
  await assert.rejects(s.service().handle(s.member(old.id)),/绑定已改变/)
  assert.throws(()=>s.act('member.newSession',{memberId:old.id,summary:'same account'}),/绑定已改变/)
  assert.throws(()=>s.act('member.newSession',{memberId:old.id,accountProfileId:'b',cwd:s.shared}),/outside/)
  assert.equal(s.member(old.id).nativeId,old.nativeId)
  s.act('member.newSession',{memberId:old.id,accountProfileId:'b',cwd:s.other})
  await until(()=>s.member(old.id).nativeId===null)
  const switched=s.member(old.id)
  assert.equal(switched.cwd,s.other);assert.equal(switched.accountProfileId,'b')
  assert.equal(switched.sandboxBinding.guestCwd,'/guest/other')
  assert.equal(s.service().store.all('commands').length,0)
  s.act('sandbox-settings-set',{enabled:false})
  assert.throws(()=>s.act('member.send',{memberId:old.id,text:'blocked'}),/启用/)
  await assert.rejects(s.service().handle(switched),/启用/)
  s.act('member.newSession',{memberId:old.id,accountProfileId:null,cwd:s.shared})
  await until(()=>s.member(old.id).accountProfileId===null)
  await s.service().handle(s.member(old.id));assert.equal(s.opens.at(-1).sandboxLaunch,undefined)
})

test('sandbox PTY rechecks the pinned account and mount, and metadata has no host fallback',async t=>{
  const s=await baseline(t);s.act('sandbox-settings-set',{enabled:true})
  const m=s.add('Claude VM',{accountProfileId:'a',kind:'claude'})
  assert.deepEqual(await s.service().claudeStats({memberId:m.id}),{available:false,reason:'sandbox'})
  const menu=await s.service().slashCommands({memberId:m.id})
  assert.ok(Array.isArray(menu))
  await s.service().handle(m)
  const lease=await s.service().claimMemberTerminal(m.id)
  try{
    const sandboxLaunch=await s.service().sandboxTerminal(lease)
    const launch=await buildTerminalLaunch({...lease,sandboxLaunch})
    assert.equal(launch.file,sandboxLaunch.command);assert.equal(launch.cwd,s.shared)
    assert.ok(launch.args.includes('-tt'));assert.ok(launch.args.includes('--resume'));assert.ok(launch.args.includes(lease.sessionId))
    await sandboxLaunch.close()
    const mapped=getSandboxWorkspace({accountId:'a',kind:'claude',cwd:s.shared})
    await assert.rejects(s.service().sandboxTerminal({...lease,sandboxBinding:{...mapped,bindingId:'different'}}),/绑定已改变/)
  }finally{await lease.release()}
  assert.ok((await readFile(s.log,'utf8')).includes('stop'))
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProviderAccounts, assertProviderAccountSelectable, getDefaultProviderAccount } from '../../src/host/provider-accounts.js'
import { setSandboxEnabled } from '../../src/host/sandbox-settings.js'
import { NativeCrewService } from '../fixtures/member-service.js'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "godbot-account's-test-")))
  const registry = join(root, 'registry'), state = join(root, 'state'), other = join(root, 'other')
  for (const dir of [registry, state, other]) await mkdir(dir, { mode: 0o700 })
  const prior = process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
  process.env.GODBOT_SANDBOX_ACCOUNTS_DIR = registry
  t.after(async () => {
    if (prior === undefined) delete process.env.GODBOT_SANDBOX_ACCOUNTS_DIR
    else process.env.GODBOT_SANDBOX_ACCOUNTS_DIR = prior
    await rm(root, { recursive: true, force: true })
  })
  const log = join(root, 'ssh.jsonl'), ssh = join(root, 'ssh')
  await writeFile(ssh, '#!' + process.execPath + '\n' +
    'const fs=require("node:fs"), a=process.argv.slice(2), p=a.indexOf("--")+5;\n' +
    'fs.appendFileSync('+ JSON.stringify(log) +', JSON.stringify(a[p] || "start")+"\\n");\n' +
    'if(a[p]==="identity") console.log(JSON.stringify({status:"signed-in",email:a[p+2]+"@example.test",hidden:"DO-NOT-RETURN"}));', { mode: 0o700 })
  const manifest = { id: 'slot-a', name: '沙箱 A', machineId: 'a'.repeat(32), uid: 1000, start: [ssh], ssh: [ssh],
    programs: { antigravity: '/bin/agy', claude: '/bin/claude' },
    workspaces: [{ hostPath: root, guestPath: '/guest', readOnly: false, source: 'work', filesystem: 'virtiofs' }] }
  const save = async () => writeFile(join(registry, 'slot-a.json'), JSON.stringify(manifest), { mode: 0o600 })
  await save()
  return { root, registry, state, other, log, manifest, save }
}

const byKind = (view, kind) => view.providers.find(p => p.kind === kind)
const row = (view, kind, id) => byKind(view, kind).accounts.find(a => a.id === id)

test('owner catalog separates CLI identities, names and defaults by slot and profile; passive views never start a VM', async t => {
  const f = await fixture(t)
  const config = { antigravity: { command: '/does/not/exist' } }
  const service = new NativeCrewService({ stateDir: f.state, driverConfig: config })
  await service.ready()
  t.after(() => service.close())
  const call = (action, rest = {}) => service.dispatch({ action, ...rest })
  let view = call('provider-accounts')
  assert.deepEqual(view.providers.map(p => p.accounts.length), [1, 1, 1])
  assert.equal(row(view, 'antigravity', null).available, false)
  assert.throws(() => call('provider-account-default', { kind:'antigravity', accountId:'slot-a' }), /启用/)
  assert.throws(() => service.mutate({action:'provider-account-default',kind:'antigravity',accountId:'slot-a'}, {id:'bot'}), /Unsupported/)
  call('sandbox-settings-set', { enabled: true })
  view = call('provider-accounts')
  assert.equal(row(view, 'antigravity', 'slot-a').managed, false)
  assert.equal(row(view, 'antigravity', 'slot-a').inUse, false)
  const team=call('team.create',{name:'Existing team',cwd:f.root})
  const existing=call('member.add',{teamId:team.id,name:'Existing member',kind:'antigravity',accountProfileId:'slot-a'})
  service.teamBridge.rt={state:{bots:{existing:{sandboxKind:'claude',accountProfileId:'slot-a'}}},engineOfBot:()=>null}
  assert.equal(row(call('provider-accounts'),'antigravity','slot-a').inUse,true)
  assert.equal(row(call('provider-accounts'),'claude','slot-a').inUse,true)
  service.teamBridge.rt=undefined
  assert.equal(row(view, 'antigravity', 'slot-a').identity.status, 'unchecked')
  assert.equal(row(view, 'codex', 'slot-a'), undefined)
  const where = { kind: 'antigravity', accountId: 'slot-a' }
  assert.throws(() => call('provider-account-default', {kind:'codex',accountId:'slot-a'}), /unavailable/)
  assert.throws(() => call('provider-account-save', {...where,name:'evil\nname'}), /名称/)
  view = call('provider-account-save', {...where, name:'Primary Google'})
  assert.equal(row(view, 'antigravity', 'slot-a').managed, true)
  assert.equal(row(view, 'claude', 'slot-a').customName, null)
  assert.equal(call('provider-account-login', where).opened, false)
  assert.match(call('provider-account-login', where).command,/sandbox login slot-a antigravity$/)
  call('provider-account-default', where)
  assert.deepEqual(getDefaultProviderAccount(f.state, 'antigravity'), {
    id:'slot-a',name:'Primary Google',workspaces:[{hostPath:f.root, guestPath:'/guest', readOnly:false}],
  })
  assert.equal(getDefaultProviderAccount(f.state, 'claude'),null)
  await assert.rejects(stat(f.log),{code:'ENOENT'})
  const pending = call('provider-account-check',where)
  assert.equal(call('provider-account-check',where), pending)
  call('provider-account-save',{...where,name:'Renamed while checking'})
  view = await pending
  const stored = row(view,'antigravity','slot-a')
  assert.equal(stored.name,'Renamed while checking')
  assert.equal(stored.identity.email,'antigravity@example.test')
  assert.ok(Number.isFinite(Date.parse(stored.identity.checkedAt)))
  assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2)
  assert.ok(!JSON.stringify(view).includes('DO-NOT-RETURN'))
  assert.ok(!(await readFile(join(f.state,'provider-accounts.json'),'utf8')).includes('DO-NOT-RETURN'))
  assert.equal((await stat(join(f.state,'provider-accounts.json'))).mode & 0o777,0o600)
  call('provider-account-save',{...where,name:''})
  assert.equal(row(call('provider-accounts'),'antigravity','slot-a').name,'antigravity@example.test')
  const removed = call('provider-account-remove',where)
  assert.equal(row(removed,'antigravity','slot-a').inUse,false)
  assert.equal(service.store.get('members',existing.id).accountProfileId,'slot-a')
  assert.throws(()=>assertProviderAccountSelectable(f.state,'antigravity','slot-a'),/重新添加/)
  assert.equal(row(removed,'antigravity','slot-a').removed,true)
  assert.equal(row(removed,'antigravity','slot-a').managed,false)
  assert.equal(byKind(removed,'antigravity').defaultAccountId,null)
  assert.throws(()=>call('provider-account-default',where),/重新添加/)
  assert.throws(()=>call('provider-account-check',where),/重新添加/)
  assert.throws(()=>call('provider-account-remove',{kind:'antigravity',accountId:null}),/不能移出/)
  assert.equal(row(removed,'claude','slot-a').removed,false)
  call('provider-account-save',{...where,name:''})
  assert.doesNotThrow(()=>assertProviderAccountSelectable(f.state,'antigravity','slot-a'))
  call('provider-account-default',where)
  assert.equal(new ProviderAccounts(f.state,config).view().providers[0].defaultAccountId,'slot-a')
  setSandboxEnabled(f.other,true)
  assert.equal(row(new ProviderAccounts(f.other,config).view(),'antigravity','slot-a').customName,null)
  assert.equal(getDefaultProviderAccount(f.other,'antigravity'),null)
  call('sandbox-settings-set',{enabled:false})
  assert.equal(getDefaultProviderAccount(f.state,'antigravity'),null)
  assert.equal(row(call('provider-accounts'),'antigravity','slot-a'),undefined)
  assert.throws(()=>call('provider-account-login',where), /启用/)
  call('sandbox-settings-set',{enabled:true})
  assert.equal(getDefaultProviderAccount(f.state,'antigravity').id,'slot-a')
  await rm(join(f.registry,'slot-a.json'))
  assert.equal(byKind(call('provider-accounts'),'antigravity').defaultAvailable,false)
  assert.equal(byKind(call('provider-accounts'),'antigravity').defaultAccountId,'slot-a')
  assert.throws(()=>getDefaultProviderAccount(f.state,'antigravity'),/首选沙箱账号已不可用/)
  f.manifest.machineId='b'.repeat(32); await f.save()
  assert.equal(row(call('provider-accounts'),'antigravity','slot-a').identity.status,'unchecked')
  assert.equal(row(call('provider-accounts'),'antigravity','slot-a').name,'沙箱 A')
  assert.equal(byKind(call('provider-accounts'),'antigravity').defaultAvailable,false)
  assert.throws(()=>getDefaultProviderAccount(f.state,'antigravity'),/首选沙箱账号已不可用/)
  assert.equal(byKind(call('provider-account-default',where),'antigravity').defaultAvailable,true)
  assert.equal(getDefaultProviderAccount(f.state,'antigravity').id,'slot-a')
  call('provider-account-default',{kind:'antigravity',accountId:null})
  assert.equal(getDefaultProviderAccount(f.state,'antigravity'),null)
})

test('local login is a fixed host launch plan and only opens a terminal on a deliberate request',async t=>{
  const f=await fixture(t)
  const launches=[]
  const app = new ProviderAccounts(f.state,{claude:{command:process.execPath}},{openTerminal:async command=>{
    launches.push(command);return true
  }})
  const ask={action:'provider-account-login',kind:'claude',accountId:null,command:'untrusted;wrong',args:['--bad']}
  const preview=app.dispatch(ask)
  assert.equal(launches.length,0)
  assert.equal(preview.opened,false)
  assert.match(preview.command,/auth login$/)
  assert.ok(!preview.command.includes('untrusted'))
  assert.deepEqual(await app.dispatch({...ask,open:true}),{...preview,opened:true})
  assert.deepEqual(launches,[preview.command])
})

test('all three local identity probes read only the native account fields without a prompt, and preserve signed-out vs unavailable',async t=>{
  const f=await fixture(t)
  const config={}
  const nativeFixtures={
    claude:`if sys.argv[1:] != ['auth','status','--json']: sys.exit(2)
print(json.dumps({'loggedIn':True,'email':'claude@example.test','accessToken':'HIDDEN'}))`,
    codex:`if sys.argv[1:] != ['app-server']: sys.exit(2)
for line in sys.stdin:
    q=json.loads(line)
    if q['method']=='initialize': print(json.dumps({'id':1,'result':{}}),flush=True)
    elif q['method']=='initialized': continue
    elif q['method']=='account/read' and q['params']=={'refreshToken':False}:
        print(json.dumps({'id':2,'result':{'account':{'type':'chatgpt','email':'codex@example.test'},'hidden':'HIDDEN'}}),flush=True)
    else: sys.exit(2)`,
    antigravity:`if len(sys.argv)!=3 or sys.argv[1]!='--settings': sys.exit(2)
q=json.loads(sys.argv[2])['statusLine']
subprocess.run(shlex.split(q['command']),input=json.dumps({'product':'antigravity','email':'agy@example.test','accessToken':'HIDDEN'}),text=True,stdout=subprocess.DEVNULL)
time.sleep(4)`,
  }
  for(const [kind,source] of Object.entries(nativeFixtures)){
    const command=join(f.root,kind)
    await writeFile(command,'#!/usr/bin/env python3\nimport sys,json,subprocess,time,shlex\n'+source,{mode:0o700})
    config[kind]={command}
  }
  const app=new ProviderAccounts(f.state,config)
  for(const [kind,email] of Object.entries({claude:'claude@example.test',codex:'codex@example.test',antigravity:'agy@example.test'})){
    const result=await app.dispatch({action:'provider-account-check',kind,accountId:null})
    assert.equal(row(result,kind,null).identity.status,'signed-in')
    assert.equal(row(result,kind,null).identity.email,email)
    assert.ok(!JSON.stringify(result).includes('HIDDEN'))
  }
  await writeFile(config.claude.command,"#!/bin/sh\necho '{\"loggedIn\":false}'\nexit 1\n")
  const signedOut=await app.dispatch({action:'provider-account-check',kind:'claude',accountId:null})
  assert.equal(row(signedOut,'claude',null).identity.status,'signed-out')
  await writeFile(config.claude.command,'#!/bin/sh\necho unrelated-error\nexit 1\n')
  const unknown=await app.dispatch({action:'provider-account-check',kind:'claude',accountId:null})
  assert.equal(row(unknown,'claude',null).identity.status,'unavailable')
  assert.equal(row(unknown,'claude',null).identity.email,null)
})

test('refresh cannot publish another VM identity or restore a removed account',async t=>{
  const f=await fixture(t), app=new ProviderAccounts(f.state,{})
  setSandboxEnabled(f.state,true)
  const where={kind:'antigravity',accountId:'slot-a'}
  const first=app.dispatch({action:'provider-account-check',...where})
  f.manifest.machineId='b'.repeat(32); await f.save()
  await assert.rejects(first,/绑定已改变/)
  assert.equal(row(app.view(),'antigravity','slot-a').identity.status,'unchecked')
  const second=app.dispatch({action:'provider-account-check',...where})
  app.dispatch({action:'provider-account-remove',...where})
  await assert.rejects(second,/移出/)
  assert.equal(row(app.view(),'antigravity','slot-a').identity.status,'unchecked')
})

test('AGY waits for native identity and reports timeout and sign-out separately',async t=>{
  const f=await fixture(t), fake=join(f.root,'agy')
  const probe=fileURLToPath(new URL('../../src/host/provider-accounts-probe.py',import.meta.url))
  const check="import runpy,json,sys; print(json.dumps(runpy.run_path(sys.argv[1])['antigravity'](sys.argv[2], timeout=0.7)))"
  const native=async (word,phase)=>{
    const fixture=`#!/usr/bin/env python3
import sys,json,subprocess,shlex,time
q=json.loads(sys.argv[2])['statusLine']['command']
print(${JSON.stringify(word)},flush=True)
subprocess.run(shlex.split(q),input=json.dumps({'product':'antigravity','agent_state':${JSON.stringify(phase)}}),text=True)
time.sleep(3)`
    await writeFile(fake,fixture,{mode:0o700})
    const {stdout}=await promisify(execFile)('python3',['-I','-B','-c',check,probe,fake])
    return JSON.parse(stdout).status
  }
  assert.equal(await native('Initializing','initializing'),'unavailable')
  assert.equal(await native('Not signed in','initializing'),'unavailable')
  assert.equal(await native('Not signed in','authenticating'),'signed-out')
})

test('PTY cleanup confirms the child exits even when signalling its macOS process group returns EPERM',async()=>{
  const file=fileURLToPath(new URL('../../src/host/provider-accounts-probe.py',import.meta.url))
  await promisify(execFile)('python3',['-I','-B','-c',`
import os,runpy,subprocess,sys,time
from unittest.mock import patch
stop=runpy.run_path(sys.argv[1])['stop']
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
try:
    with patch('os.killpg',side_effect=PermissionError(1,'fixture')):
        stop(child.pid)
    try: os.kill(child.pid,0)
    except ProcessLookupError: pass
    else: raise AssertionError('child still alive')
finally:
    child.kill()
    child.wait()
`,file],{timeout:8000})
})

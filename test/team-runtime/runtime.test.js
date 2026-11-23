import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { initProfile } from '@deepseek-ai/dsh-app-boot'
import { workspaceHome } from '../../src/host/workspace-home.js'
import { getTeamRuntime, hasStandaloneWorkspace, mountTeamRuntime, teamRuntimeStatus } from '../../src/host/team-runtime.js'
import { WorkspaceAgentAdapter } from '../../src/host/team-runtime/local-agents.js'
import { fakeContext } from './fake-ctx.js'

async function profile(t, overlays = []) {
  const home = await mkdtemp(join(tmpdir(), 'godbot-team-host-'))
  const dir = join(home, 'profiles', 'web')
  initProfile(dir, [])
  const child = fakeContext()
  const profileContext = { home, dir, name: 'web', patchPath: join(dir, 'cordis.patch.yml'), overlays, installAnchor: join(dir, 'package.json') }
  child.profileContext = profileContext
  let injected = 0
  const owner = fakeContext()
  Object.assign(owner, {
    profileContext,
    typertGateway: { claimsEndpoint: () => false },
    inject(services, start) {
      injected++
      assert.ok(services.includes('profileContext'))
      owner.started = start(child)
    },
  })
  t.after(async () => {
    await child.dispose()
    await owner.dispose()
    await rm(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, owner, child, stateDir: join(home, 'godbot', 'web'), injected: () => injected }
}

test('the managed runtime loads one durable workspace in the owning NativeCrew profile', async t => {
  const { home, owner, child, stateDir, injected } = await profile(t)
  const expectedHome = join(stateDir, 'team-workspace')
  await mkdir(expectedHome, { recursive: true })
  await writeFile(join(expectedHome, 'state.json'), JSON.stringify({
    version: 1, mainBotId: 'm1', bots: { m1: { id: 'm1', name: 'Local lead', createdAt: 1 } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  const options = { updateCheck: false, github: false, diagnosticsFile: false, home: join(home, 'bot'), checkRatio: 0.45 }
  mountTeamRuntime(owner, stateDir, options)
  mountTeamRuntime(owner, stateDir, options)
  await owner.started
  assert.equal(teamRuntimeStatus(owner).mode, 'embedded')
  const rt = await getTeamRuntime(owner)
  assert.equal(injected(), 1)
  assert.equal(rt.home, expectedHome)
  assert.equal(rt.dshHome, home)
  assert.equal(rt.config.workspace, join(expectedHome, 'workspace'))
  assert.equal(rt.config.checkRatio, 0.45)
  assert.equal(existsSync(join(home, 'bot')), false)
  assert.ok(child.calls.includes('route POST /api/godbot/team'))
  assert.ok(child.calls.includes('route GET /api/godbot/team/feed'))
  const state = await rt.channelCall('state', {})
  assert.equal(state.ok, true, JSON.stringify(state.error))
  assert.equal(state.value.bots[0].name, 'Local lead')
  assert.equal(state.value.bots[0].avatar.shape, 'godbot')
  assert.equal(state.value.bots[0].color, 'cyan')
  assert.equal(rt.phoneView().server, '')

})

test('a Main Bot that kept the old defaults Chief, Chief of Staff becomes NativeCrew, Team Lead once', async t => {
  async function open(extra) {
    const { home, owner, stateDir } = await profile(t)
    const workspace = join(stateDir, 'team-workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'state.json'), JSON.stringify({
      version: 1, mainBotId: 'm1', ...extra,
      bots: { m1: { id: 'm1', name: 'Chief', role: 'Chief of Staff', createdAt: 1 }, w1: { id: 'w1', name: 'Writer', createdAt: 2 } },
      rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
    }))
    mountTeamRuntime(owner, stateDir, { updateCheck: false, github: false, diagnosticsFile: false, home: join(home, 'bot') })
    await owner.started
    const rt = await getTeamRuntime(owner)
    const state = await rt.channelCall('state', {})
    assert.equal(state.ok, true, JSON.stringify(state.error))
    const saved = JSON.parse(await readFile(join(workspace, 'state.json'), 'utf8'))
    return { bots: Object.fromEntries(state.value.bots.map(bot => [bot.id, [bot.name, bot.role]])), saved }
  }
  const upgraded = await open()
  assert.deepEqual(upgraded.bots, { m1: ['NativeCrew', 'Team Lead'], w1: ['Writer', undefined] })
  assert.deepEqual([upgraded.saved.bots.m1.name, upgraded.saved.bots.m1.role], ['NativeCrew', 'Team Lead'])
  assert.deepEqual([upgraded.saved.mainRenamed, upgraded.saved.mainRoleRenamed], [true, true])
  // A team already renamed before the role changed gets only the new role.
  const named = await open({ mainRenamed: true })
  assert.deepEqual(named.bots.m1, ['Chief', 'Team Lead'])
  // Once updated, a name or role the user picks later, the old ones included, stays.
  const chosen = await open({ mainRenamed: true, mainRoleRenamed: true })
  assert.deepEqual(chosen.bots.m1, ['Chief', 'Chief of Staff'])
})

test('an upgraded and rolled-back workspace reopens the original directory and flags conflicting histories', async t => {
  const { stateDir, owner } = await profile(t)
  const previous = join(stateDir, 'ds-bot')
  await mkdir(previous, { recursive: true })
  await writeFile(join(previous, 'state.json'), JSON.stringify({
    version: 1, mainBotId: 'm1', bots: { m1: { id: 'm1', name: 'Before upgrade', createdAt: 1, color: 'violet', avatar: { shape: 'star' } } },
    rooms: {}, exchanges: [], exchangeTurns: {}, questions: {},
  }))
  mountTeamRuntime(owner, stateDir, { updateCheck: false, diagnosticsFile: false })
  await owner.started
  const runtime = await getTeamRuntime(owner)
  assert.equal(runtime.home, previous)
  assert.equal(runtime.state.bots.m1.avatar.shape, 'star')
  assert.equal(runtime.state.bots.m1.color, 'violet')
  const fresh = join(stateDir, 'team-workspace')
  assert.equal(existsSync(fresh), false)
  await mkdir(fresh)
  assert.throws(() => workspaceHome(stateDir), /Two team workspace directories/)
})

test('an enabled standalone workspace owns its routes and keeps its original data directory', async t => {
  const { owner, injected, stateDir, home } = await profile(t, [{ insert: [{ id: 'bot', name: 'ds-bot' }] }])
  mountTeamRuntime(owner, stateDir)
  assert.equal(teamRuntimeStatus(owner).mode, 'standalone')
  assert.equal(injected(), 0)
  assert.equal(existsSync(join(home, 'bot')), false)
  assert.equal(existsSync(stateDir), false)
  await assert.rejects(getTeamRuntime(owner), { code: 'GODBOT_TEAM_DISABLED' })
  const disabled = [{ group: true, disabled: true, config: [{ name: 'ds-bot' }] }, { name: 'ds-bot/web-search' }]
  assert.equal(hasStandaloneWorkspace(disabled), false)
  assert.equal(hasStandaloneWorkspace([{ group: true, config: [{ name: 'ds-bot' }] }]), true)
})

test('a runtime already registered outside a bundle is also treated as standalone', async t => {
  const { owner, stateDir, injected } = await profile(t)
  owner.typertGateway.claimsEndpoint = name => name === 'dsBot/call'
  mountTeamRuntime(owner, stateDir)
  assert.equal(teamRuntimeStatus(owner).mode, 'standalone')
  assert.equal(injected(), 0)
})

test('a failed installation disposes its own partial effects and leaves diagnostics available', async t => {
  const { owner, child, stateDir } = await profile(t)
  let clean
  child.fiber = { dispose: () => { clean = child.dispose(); return clean } }
  mountTeamRuntime(owner, stateDir, { updateCheck: false, diagnosticsFile: false, browserPlugin: 'invalid' })
  await owner.started
  await clean
  assert.ok(clean)
  assert.equal(teamRuntimeStatus(owner).mode, 'unavailable')
  await assert.rejects(getTeamRuntime(owner), /Choose refs, script, task/)
})

test('a restored Claude model resolves its native thinking levels without probing unrelated routes', async () => {
  const route = 'local-claude-code'
  const reasoning = { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
  const probes = []
  const adapter = new WorkspaceAgentAdapter({
    customAgents: () => [], probeCwd: tmpdir, spawnEngine(kind, id) {
      probes.push(id)
      return { defaultReasoning: reasoning, listModels: async () => [{ id: 'sonnet', reasoning }], close: async () => {} }
    },
  })
  await adapter.listModels(route)
  await adapter.resolveModel('local-codex-cli', 'default')
  assert.deepEqual(probes, [])
  assert.deepEqual((await adapter.resolveModel(route, 'sonnet')).reasoning, reasoning)
  assert.deepEqual((await adapter.resolveModel(route, 'default')).reasoning, reasoning)
  assert.deepEqual(probes, [route])
  await adapter.dispose()
})

test('native route admission preserves model modalities and negotiated ACP support', async t => {
  let acpImages
  const codex = 'local-codex-cli'
  const acp = 'local-antigravity'
  const adapter = new WorkspaceAgentAdapter({
    customAgents: () => [],
    probeCwd: tmpdir,
    spawnEngine(kind) {
      return {
        listModels: async () => kind === 'acp'
          ? [{ id: 'gemini-3.8-flash' }]
          : [{ id: 'text-model', inputModalities: ['text'] }, { id: 'vision-model', inputModalities: ['text', 'image'] }],
        ...(kind === 'acp' ? { supportsImages: () => acpImages } : {}),
        close: async () => {},
      }
    },
  })
  t.after(() => adapter.dispose())

  assert.equal((await adapter.resolveModel(acp, 'gemini-3.8-flash')).inputModalities, undefined)
  acpImages = true
  await adapter.probeModels(acp)
  assert.deepEqual((await adapter.resolveModel(acp, 'gemini-3.8-flash')).inputModalities, ['text', 'image'])
  acpImages = false
  assert.deepEqual((await adapter.resolveModel(acp, 'gemini-3.8-flash')).inputModalities, ['text'])
  assert.deepEqual((await adapter.listModels(acp)).find(row => row.id === 'gemini-3.8-flash').inputModalities, ['text'])

  await adapter.probeModels(codex)
  assert.deepEqual((await adapter.resolveModel(codex, 'text-model')).inputModalities, ['text'])
  assert.deepEqual((await adapter.resolveModel(codex, 'vision-model')).inputModalities, ['text', 'image'])
  assert.equal((await adapter.resolveModel(codex, 'default')).inputModalities, undefined)
})

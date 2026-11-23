import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { IDLE_MS, RETRY_MS, install, profileCommand, sourceOf } from '../../src/host/team-runtime/core/update.js'
import {
  GITHUB_API, assetName, archiveManifest, compatibility, downloadArchive, newer, newestRelease, releasesApi, sidecarDigest,
} from '../../src/host/team-runtime/core/update-release.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const [major, minor, patch] = PKG.version.split('-')[0].split('.').map(Number)
// A stable release newer than whatever this checkout is: offered on either channel.
const NEXT = `${major}.${minor}.${patch + 1}`
const REPO = 'webkubor/nativecrew'
const LIST = `https://api.github.com/repos/${REPO}/releases?per_page=30`
const sha = data => createHash('sha256').update(data).digest('hex')

const dirs = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-update-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// A ustar entry, the way npm pack writes package/package.json.
function tarEntry(name, body, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
  header.write('00000000000\0', 136)
  header.fill(' ', 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)])
}
const tgz = entries => gzipSync(Buffer.concat([...entries.map(([name, body, type]) => tarEntry(name, Buffer.from(body), type)), Buffer.alloc(1024)]))
const manifestFor = (version, extra = {}) => JSON.stringify({ name: PKG.name, version, engines: PKG.engines, peerDependencies: PKG.peerDependencies, ...extra })
const archiveFor = (version, extra) => tgz([['package/README.md', '# NativeCrew\n'], ['package/package.json', manifestFor(version, extra)]])

function release(version, { data = archiveFor(version), digest = true, prerelease = version.includes('-'), draft = false, sidecar = false } = {}) {
  const name = assetName(PKG.name, version)
  const url = `https://github.com/${REPO}/releases/download/v${version}/${name}`
  const assets = [{ name, browser_download_url: url, size: data.length, ...(digest ? { digest: `sha256:${sha(data)}` } : {}) }]
  if (sidecar) assets.push({ name: `${name}.sha256`, browser_download_url: `${url}.sha256`, size: 90 })
  return { body: { tag_name: `v${version}`, html_url: `https://github.com/${REPO}/releases/tag/v${version}`, draft, prerelease, assets }, url, data }
}

function fakeNet(routes) {
  const calls = []
  const answer = (url) => {
    calls.push(url)
    const value = typeof routes[url] === 'function' ? routes[url]() : routes[url]
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`${url} answered 404`)
    return value
  }
  return {
    calls,
    async json(url) { return answer(url) },
    async text(url) { return String(answer(url)) },
    async download(url, path, { onProgress } = {}) {
      const data = answer(url)
      writeFileSync(path, data, { flag: 'wx' })
      onProgress?.(data.length, data.length)
    },
  }
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

// An installed DSH as its install anchor names it: the package.json and its `dsh` bin.
function fakeDsh({ name = '@deepseek-ai/dsh' } = {}) {
  const dir = scratch()
  mkdirSync(join(dir, 'lib'))
  writeFileSync(join(dir, 'lib/bin.js'), '')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: PKG.engines.dsh, bin: { dsh: 'lib/bin.js' } }))
  return join(dir, 'package.json')
}

const setDependency = (profile, spec) => {
  const path = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, [PKG.name]: spec } }))
}

// A stand-in for child_process.spawn: each run prints `output`, may change the
// profile (`install`, in the command's working directory) and exits with `code`.
function fakeSpawn({ code = 0, output = '', install } = {}) {
  const calls = []
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} })
    setImmediate(() => {
      install?.(options.cwd, args)
      if (output) child.stderr.emit('data', output)
      child.emit('close', code)
    })
    return child
  }
  return { calls, spawnProcess }
}

// The team runtime's update module with the profile, plugin manager, network and clock it reads.
// `hmr` gives the host DSH's in-place reload service; `cli` the profile facts and the
// installed DSH that DSH's CLI is found from; `spawn` runs that CLI.
function harness({ releases, routes = {}, mode, dsh = PKG.engines.dsh, peers = Object.keys(PKG.peerDependencies), install: answer, home = scratch(), hmr = false, cli = false, spawn } = {}) {
  const dshHome = scratch()
  const profile = join(dshHome, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const archives = scratch()
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries([...peers.map(name => [name, `link:/dsh/${name}`]), [PKG.name, `file:/old/${PKG.name}-${PKG.version}-000000000000.tgz`]]),
  }))
  const installs = []
  const manager = {
    listBundles: async () => [{ name: PKG.name, source: `file:/old/${PKG.name}-${PKG.version}-000000000000.tgz` }],
    installBundle: async (spec, options) => {
      installs.push({ spec, options })
      return answer ? answer(spec) : { application: 'restart-required', version: NEXT }
    },
  }
  const net = fakeNet({ [LIST]: releases.map(entry => entry.body), ...Object.fromEntries(releases.map(entry => [entry.url, entry.data])), ...routes })
  const clock = { now: 1_000_000_000_000 }
  const warnings = []
  const services = {
    pluginManager: manager,
    profileContext: { dir: profile, ...(cli ? { name: 'web', home: dshHome, installAnchor: fakeDsh() } : {}) },
    loader: { import: async () => ({ getDshRuntimeVersion: () => dsh }), unwrapExports: value => value },
    ...(hmr ? { hmr: {} } : {}),
  }
  const rt = {
    ctx: { get: name => services[name], effect() {} },
    config: { updateArchiveDir: archives, ...(mode ? { updateMode: mode } : {}) },
    home,
    live: new Map(),
    readOnly: () => undefined,
    warn: (...args) => warnings.push(args),
    updateNet: net,
    updateClock: () => clock.now,
    ...(spawn ? { updateSpawn: spawn } : {}),
  }
  install(rt)
  return { rt, net, clock, installs, archives, home, warnings, manager, profile, dshHome, services }
}

// Download the release, let NativeCrew sit idle, and let the clock install it.
async function installWhenIdle({ rt, clock }) {
  await rt.updateTick()
  await rt.updatePrepare()
  await rt.updateTick()
  clock.now += IDLE_MS
  await rt.updateTick()
  await settle()
}

test('a packed archive install updates from GitHub releases; a folder or link does not', () => {
  assert.equal(sourceOf('file:/Users/me/.local/share/dsh-godbot/packages/dsh-godbot-0.2.0-abc.tgz').kind, 'archive')
  assert.equal(sourceOf('/tmp/dsh-godbot-0.2.0.tar.gz').kind, 'archive')
  assert.equal(sourceOf('link:/Users/me/code/dsh-godbot').kind, 'path')
  assert.equal(sourceOf('file:/Users/me/code/dsh-godbot').kind, 'path')
  assert.equal(sourceOf('dsh-godbot@0.2.0').kind, 'registry')
  assert.equal(sourceOf('github:webkubor/nativecrew#v0.2.0').kind, 'git')
  assert.equal(sourceOf('https://example.com/dsh-godbot-0.2.0.tgz').kind, 'tarball')
})

test('the newest release carrying the archive wins, prereleases only on that channel', async () => {
  const stable = release('0.3.0')
  const rc = release('0.4.0-rc.1')
  const draft = release('0.5.0', { draft: true })
  const bare = { body: { tag_name: 'v0.6.0', draft: false, prerelease: false, assets: [] } }
  const net = fakeNet({ [LIST]: [rc.body, draft.body, bare.body, stable.body] })
  const found = await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net })
  assert.equal(found.version, '0.3.0')
  assert.equal(found.asset.sha256, sha(stable.data))
  assert.equal(found.notesUrl, stable.body.html_url)
  assert.equal((await newestRelease({ repo: REPO, name: PKG.name, prerelease: true, net })).version, '0.4.0-rc.1')
  assert.equal(await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [] }) }), null)
})

test('GODBOT_UPDATE_API points the release list at another server', async () => {
  assert.equal(releasesApi({}), GITHUB_API)
  assert.equal(releasesApi({ GODBOT_UPDATE_API: 'file:///etc/passwd' }), GITHUB_API)
  assert.equal(releasesApi({ GODBOT_UPDATE_API: 'http://127.0.0.1:9000/' }), 'http://127.0.0.1:9000/')
  const local = 'http://127.0.0.1:9000/repos/webkubor/nativecrew/releases?per_page=30'
  assert.equal(await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [local]: [] }), api: 'http://127.0.0.1:9000/' }), null)
})

test('a release without GitHub\'s digest needs a .sha256 beside its archive', async () => {
  const withSidecar = release('0.3.0', { digest: false, sidecar: true })
  const sum = `${sha(withSidecar.data)}  ${PKG.name}-0.3.0.tgz\n`
  const found = await newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [withSidecar.body], [`${withSidecar.url}.sha256`]: sum }) })
  assert.equal(found.asset.sha256, sha(withSidecar.data))
  assert.equal(sidecarDigest('not-a-hash file'), null)
  const unvouched = release('0.3.0', { digest: false })
  await assert.rejects(newestRelease({ repo: REPO, name: PKG.name, prerelease: false, net: fakeNet({ [LIST]: [unvouched.body] }) }), /states no SHA-256/)
})

test('an archive is kept only when its bytes match the release', async () => {
  const dir = scratch()
  const good = Buffer.from('archive bytes')
  const asset = { url: 'https://example.com/a.tgz', size: good.length, sha256: sha(good) }
  const path = await downloadArchive({ dir, name: PKG.name, version: '9.9.9', asset, net: fakeNet({ [asset.url]: good }) })
  assert.equal(path, join(dir, assetName(PKG.name, `9.9.9-${asset.sha256.slice(0, 12)}`)))
  // Present with the same hash: used as it is, not fetched again.
  const offline = fakeNet({})
  assert.equal(await downloadArchive({ dir, name: PKG.name, version: '9.9.9', asset, net: offline }), path)
  assert.deepEqual(offline.calls, [])
  const tampered = { ...asset, sha256: sha(Buffer.from('something else')) }
  await assert.rejects(downloadArchive({ dir, name: PKG.name, version: '9.9.8', asset: tampered, net: fakeNet({ [asset.url]: good }) }), /does not match/)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('9.9.8')), [])
})

test('the manifest is read from inside the archive, long names included', () => {
  const dir = scratch()
  const plain = join(dir, 'plain.tgz')
  writeFileSync(plain, archiveFor('1.2.3'))
  assert.equal(archiveManifest(plain).version, '1.2.3')
  const pax = join(dir, 'pax.tgz')
  writeFileSync(pax, tgz([['PaxHeader/x', '30 path=package/package.json\n', 'x'], ['package/ignored-short-name', manifestFor('1.2.4')]]))
  assert.equal(archiveManifest(pax).version, '1.2.4')
  const empty = join(dir, 'empty.tgz')
  writeFileSync(empty, tgz([['package/README.md', 'no manifest']]))
  assert.throws(() => archiveManifest(empty), /no package\/package.json/)
})

test('an archive installs only for the running DSH and the peers the profile links', () => {
  const want = { name: PKG.name, version: '1.0.0', dsh: '0.2.2', linked: ['@deepseek-ai/dsh-web'] }
  const manifest = { name: PKG.name, version: '1.0.0', engines: { dsh: '0.2.2' }, peerDependencies: { '@deepseek-ai/dsh-web': '0.2.2' } }
  assert.equal(compatibility(manifest, want), null)
  assert.deepEqual(compatibility({ ...manifest, engines: { dsh: '0.3.0' } }, want), { reason: 'dsh', dsh: '0.3.0', current: '0.2.2' })
  assert.deepEqual(compatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh-new': '0.2.2' } }, want), { reason: 'peers', peers: ['@deepseek-ai/dsh-new'] })
  assert.equal(compatibility({ ...manifest, version: '1.0.1' }, want).reason, 'mismatch')
  assert.equal(newer('0.2.0', '0.2.0-rc.3'), true)
  assert.equal(newer('0.2.0-rc.10', '0.2.0-rc.9'), true)
})

test('auto mode downloads a release, waits until NativeCrew is idle, then installs it', async () => {
  const next = release(NEXT)
  const { rt, clock, installs, archives, home } = harness({ releases: [next] })
  await rt.updateTick()
  await rt.updatePrepare()
  let view = rt.updateView()
  assert.equal(view.source, 'archive')
  assert.equal(view.phase, 'ready')
  assert.equal(view.available, true)
  assert.equal(view.mode, 'auto')
  const archive = join(archives, assetName(PKG.name, `${NEXT}-${sha(next.data).slice(0, 12)}`))
  assert.ok(existsSync(archive))

  // A Bot at work holds the install back.
  rt.live.set('bot-1', { turn: { id: 't1' } })
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'turns', count: 1 }])
  const stopTerminal = rt.addUpdateBlocker(() => ({ kind: 'terminals', count: 1 }))
  rt.live.clear()
  clock.now += IDLE_MS * 2
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'terminals', count: 1 }])
  stopTerminal()
  assert.equal(installs.length, 0)

  // Idle: the first quiet minute starts the wait, IDLE_MS later it installs.
  await rt.updateTick()
  assert.deepEqual(rt.updateView().waiting, [{ kind: 'idle' }])
  clock.now += IDLE_MS
  await rt.updateTick()
  await settle()
  assert.deepEqual(installs.map(entry => entry.spec), [archive])
  view = rt.updateView()
  assert.equal(view.phase, 'installed')
  assert.equal(view.installed, NEXT)
  assert.equal(view.available, false)
  const marker = JSON.parse(readFileSync(join(home, 'update.json'), 'utf8'))
  assert.equal(marker.from, PKG.version)
  assert.equal(marker.to, NEXT)
  assert.equal(marker.auto, true)
})

test('notify mode keeps the downloaded release for a click; off mode only asks when told', async () => {
  const next = release(NEXT)
  const notify = harness({ releases: [next], mode: 'notify' })
  await notify.rt.updateTick()
  await notify.rt.updatePrepare()
  notify.clock.now += IDLE_MS * 3
  await notify.rt.updateTick()
  await notify.rt.updateTick()
  assert.equal(notify.rt.updateView().phase, 'ready')
  assert.equal(notify.installs.length, 0)
  notify.rt.updateStart()
  await settle()
  assert.equal(notify.installs.length, 1)

  const off = harness({ releases: [next], mode: 'off' })
  await off.rt.updateTick()
  assert.deepEqual(off.net.calls, [])
  // A click on Check finds it without downloading; Update downloads and installs.
  const checked = await off.rt.updateCheck({ fresh: true })
  assert.equal(checked.available, true)
  assert.equal(checked.phase, 'idle')
  assert.deepEqual(off.net.calls, [LIST])
  off.rt.updateStart()
  await off.rt.updatePrepare()
  await settle()
  assert.equal(off.installs.length, 1)
  assert.equal(off.rt.updateView().phase, 'installed')
})

test('the update mode is kept in the data folder', async () => {
  const home = scratch()
  const first = harness({ releases: [], home })
  assert.equal(first.rt.updateSettings({ mode: 'notify' }).mode, 'notify')
  assert.throws(() => first.rt.updateSettings({ mode: 'sometimes' }), /auto, notify or off/)
  assert.equal(harness({ releases: [], home }).rt.updateView().mode, 'notify')
})

test('a release built for another DSH is shown but never installed', async () => {
  const next = release(NEXT, { data: archiveFor(NEXT, { engines: { dsh: '9.9.9' } }) })
  const { rt, clock, installs } = harness({ releases: [next] })
  await rt.updateTick()
  await rt.updatePrepare()
  const view = rt.updateView()
  assert.deepEqual(view.blocked, { reason: 'dsh', dsh: '9.9.9', current: PKG.engines.dsh })
  assert.equal(view.available, false)
  clock.now += IDLE_MS * 3
  await rt.updateTick()
  await rt.updateTick()
  assert.equal(installs.length, 0)
  assert.throws(() => rt.updateStart(), /needs DSH 9\.9\.9/)
})

test('a failed download is tried again later; a failed automatic install is not', async () => {
  const next = release(NEXT)
  let broken = true
  const { rt, clock, installs, net } = harness({
    releases: [next],
    routes: { [next.url]: () => (broken ? Buffer.from('corrupted') : next.data) },
    install: () => ({ error: { code: 'pnpm-failed', diagnostic: 'pnpm exited 1' } }),
  })
  await rt.updateTick()
  await rt.updatePrepare()
  assert.equal(rt.updateView().phase, 'failed')
  broken = false
  clock.now += 60_000
  await rt.updateTick()
  assert.equal(net.calls.filter(url => url === next.url).length, 1)
  clock.now += RETRY_MS
  await rt.updateTick()
  await rt.updatePrepare()
  assert.equal(rt.updateView().phase, 'ready')

  await rt.updateTick()
  clock.now += IDLE_MS
  await rt.updateTick()
  await settle()
  assert.equal(installs.length, 1)
  assert.equal(rt.updateView().phase, 'failed')
  clock.now += IDLE_MS * 5
  await rt.updateTick()
  await rt.updateTick()
  assert.equal(installs.length, 1)
})

// A download that hangs until it is stopped, for the release at `url`.
function hangOn(net, url) {
  const download = net.download
  net.download = (target, path, options) => target === url
    ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    : download(target, path, options)
}

test('turning updates off stops a download without calling it a failure', async () => {
  const next = release(NEXT)
  const { rt, net } = harness({ releases: [next] })
  hangOn(net, next.url)
  await rt.updateTick()
  assert.equal(rt.updateView().phase, 'downloading')
  const pending = rt.updatePrepare()
  assert.equal(rt.updateSettings({ mode: 'off' }).phase, 'idle')
  await pending
  const view = rt.updateView()
  assert.equal(view.phase, 'idle')
  assert.equal(view.error, null)
  assert.equal(view.available, true)
})

test('a newer release found mid-download replaces the one being fetched', async () => {
  const next = release(NEXT)
  const later = release(`${major}.${minor}.${patch + 2}`)
  const { rt, net, archives } = harness({ releases: [next], routes: { [later.url]: later.data } })
  hangOn(net, next.url)
  await rt.updateTick()
  assert.equal(rt.updateView().phase, 'downloading')
  net.json = async () => [later.body, next.body]
  await rt.updateCheck({ fresh: true })
  await rt.updatePrepare()
  const view = rt.updateView()
  assert.equal(view.latest, later.body.tag_name.slice(1))
  assert.equal(view.phase, 'ready')
  assert.deepEqual(readdirSync(archives).filter(name => name.endsWith('.tgz')), [assetName(PKG.name, `${view.latest}-${sha(later.data).slice(0, 12)}`)])
})

test('the start that runs the new version reports the update', () => {
  const home = scratch()
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: '0.0.1', to: PKG.version }))
  const { rt } = harness({ releases: [], home })
  assert.equal(rt.updateView().phase, 'updated')
  assert.equal(existsSync(join(home, 'update.json')), false)

  // Installed but not restarted yet: the old version does not install it again.
  writeFileSync(join(home, 'update.json'), JSON.stringify({ from: PKG.version, to: NEXT }))
  const waiting = harness({ releases: [], home })
  assert.equal(waiting.rt.updateView().phase, 'installed')
  assert.equal(waiting.rt.updateView().installed, NEXT)
  assert.equal(existsSync(join(home, 'update.json')), true)
})

test('DSH\'s CLI installs only where DSH reloads in place, into the profile it finds by name', () => {
  const dshHome = scratch()
  const dir = join(dshHome, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const profileContext = { name: 'web', dir, home: dshHome, installAnchor: fakeDsh() }
  const ctx = services => ({ get: name => services[name] })
  const command = profileCommand(ctx({ hmr: {}, profileContext }))
  assert.equal(command.command, process.execPath)
  assert.equal(command.args[0], join(dirname(profileContext.installAnchor), 'lib/bin.js'))
  assert.deepEqual(command.args.slice(1), ['plugin', '--profile', 'web'])
  assert.equal(command.cwd, dir)
  assert.equal(command.env.DSH_HOME, dshHome)
  // Without an in-place reload the plugin manager in this process installs for the next start itself.
  assert.equal(profileCommand(ctx({ profileContext })), null)
  // A profile the CLI would not find by its name, another app's install, the desktop app's profile.
  assert.equal(profileCommand(ctx({ hmr: {}, profileContext: { ...profileContext, dir: scratch() } })), null)
  assert.equal(profileCommand(ctx({ hmr: {}, profileContext: { ...profileContext, installAnchor: fakeDsh({ name: '@deepseek-ai/dsh-desktop' }) } })), null)
  assert.equal(profileCommand(ctx({ hmr: {}, profileContext: { ...profileContext, name: 'Desktop' } })), null)
  assert.equal(profileCommand(ctx({ hmr: {}, profileContext: { dir } })), null)
  // The same profile reached through a link is still the one running here.
  const elsewhere = scratch()
  symlinkSync(join(dshHome, 'profiles'), join(elsewhere, 'profiles'))
  assert.equal(profileCommand(ctx({ hmr: {}, profileContext: { ...profileContext, home: elsewhere } })).env.DSH_HOME, elsewhere)
})

test('where DSH reloads in place, its CLI installs the release and this process keeps running the current version', async () => {
  const next = release(NEXT)
  const cli = fakeSpawn({ install: (profile, args) => setDependency(profile, `file:${args.at(-1)}`) })
  const h = harness({ releases: [next], hmr: true, cli: true, spawn: cli.spawnProcess })
  await installWhenIdle(h)
  const archive = join(h.archives, assetName(PKG.name, `${NEXT}-${sha(next.data).slice(0, 12)}`))
  // Nothing went through the plugin manager here, which would load the new version into this process.
  assert.deepEqual(h.installs, [])
  assert.equal(cli.calls.length, 1)
  const [{ command, args, options }] = cli.calls
  assert.equal(command, process.execPath)
  assert.deepEqual(args.slice(1), ['plugin', '--profile', 'web', 'add', '--save-exact', archive])
  assert.equal(options.cwd, h.profile)
  assert.equal(options.env.DSH_HOME, h.dshHome)
  const view = h.rt.updateView()
  assert.deepEqual([view.phase, view.installed, view.current, view.available], ['installed', NEXT, PKG.version, false])
  // The note waits for the start that runs the new version.
  const marker = JSON.parse(readFileSync(join(h.home, 'update.json'), 'utf8'))
  assert.deepEqual([marker.from, marker.to, marker.auto, marker.error], [PKG.version, NEXT, true, undefined])
  h.clock.now += IDLE_MS * 3
  await h.rt.updateTick()
  await h.rt.updateTick()
  assert.equal(cli.calls.length, 1)
})

test('a release DSH\'s CLI could not install leaves the running version in place and is not retried by itself', async () => {
  const next = release(NEXT)
  const output = 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/jose: Not Found - 404\ndsh: plugin command failed; diagnostics: /profile/.plugin-manager/logs/pnpm.log\n'
  const cli = fakeSpawn({ code: 1, output })
  const h = harness({ releases: [next], hmr: true, cli: true, spawn: cli.spawnProcess })
  await installWhenIdle(h)
  const view = h.rt.updateView()
  assert.equal(view.phase, 'failed')
  assert.match(view.error, /^dsh plugin add exited 1: ERR_PNPM_FETCH_404/)
  assert.match(view.error, /plugin command failed; diagnostics/)
  assert.equal(existsSync(join(h.home, 'update.json')), false)
  h.clock.now += IDLE_MS * 3
  await h.rt.updateTick()
  await h.rt.updateTick()
  assert.equal(cli.calls.length, 1)
  assert.deepEqual(h.installs, [])

  // An exit without the profile naming the verified archive is no install either.
  const silent = fakeSpawn()
  const other = harness({ releases: [next], hmr: true, cli: true, spawn: silent.spawnProcess })
  await installWhenIdle(other)
  assert.equal(other.rt.updateView().phase, 'failed')
  assert.match(other.rt.updateView().error, /left @dsh-plugins\/nativecrew at file:\/old\//)
  assert.equal(existsSync(join(other.home, 'update.json')), false)
})

const DIAGNOSTIC = 'dsh: warning: 1 entry did not activate\ngodbot (dsh-godbot): failed to import: Error: ENOENT: no such file or directory, open \'node_modules/openid-client/node_modules/jose/dist/webapi/jwe/compact/decrypt.js\''
// What the plugin manager answers when the package landed in the profile but its import failed in place.
const notStarted = () => ({ stage: 'enable', target: PKG.name, bundle: PKG.name, version: NEXT, changed: true, application: 'failed', error: { code: 'operation-error', diagnostic: DIAGNOSTIC } })
const restartNote = warnings => warnings.find(([template]) => template.includes('restart DSH to use it'))

test('a release the plugin manager installed but could not start in place waits for the next DSH start', async () => {
  const next = release(NEXT)
  // DSH reloads in place, but its CLI cannot be found: the plugin manager in this process installs.
  // This DSH offers no pluginPackages service to publish its resolution again with.
  const h = harness({ releases: [next], hmr: true, install: notStarted })
  await installWhenIdle(h)
  assert.equal(h.installs.length, 1)
  const view = h.rt.updateView()
  assert.deepEqual([view.phase, view.installed, view.error], ['installed', NEXT, null])
  const marker = JSON.parse(readFileSync(join(h.home, 'update.json'), 'utf8'))
  assert.deepEqual([marker.from, marker.to, marker.error], [PKG.version, NEXT, undefined])
  assert.ok(h.warnings.some(([template]) => template.includes('did not start in this DSH')))
  assert.equal(restartNote(h.warnings).at(-1), 'DSH cannot publish its module resolution again here')

  // A run that failed before the package landed was undone: nothing waits for a restart.
  const refused = harness({
    releases: [next], hmr: true,
    install: () => ({ stage: 'install', target: PKG.name, changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm exited 1' } }),
  })
  await installWhenIdle(refused)
  assert.equal(refused.rt.updateView().phase, 'failed')
  assert.equal(existsSync(join(refused.home, 'update.json')), false)
})

test('a release that did not start in place starts after DSH publishes its module resolution again', async () => {
  const next = release(NEXT)
  const steps = []
  const h = harness({ releases: [next], hmr: true, install: notStarted })
  // The publication runs serialized with DSH's reloads; enabling the bundle again imports the new version.
  h.services.hmr = { runExclusive: async (operation) => { steps.push('exclusive'); return operation() } }
  h.services.pluginPackages = { refresh: async () => { steps.push('refresh') } }
  h.manager.setBundleEnabled = async (name, enabled) => {
    steps.push(['enable', name, enabled])
    return { stage: 'enable', target: name, enabled, changed: false, application: 'applied', warnings: [] }
  }
  await installWhenIdle(h)
  assert.equal(h.installs.length, 1)
  assert.deepEqual(steps, ['exclusive', 'refresh', ['enable', PKG.name, true]])
  const started = h.warnings.find(([template]) => template.includes('started after DSH published its module resolution again'))
  assert.deepEqual(started.slice(1), [NEXT, DIAGNOSTIC])
  assert.equal(restartNote(h.warnings), undefined)
  // The new version's first start reads the note and reports the update.
  const marker = JSON.parse(readFileSync(join(h.home, 'update.json'), 'utf8'))
  assert.deepEqual([marker.from, marker.to, marker.error], [PKG.version, NEXT, undefined])
  assert.deepEqual([h.rt.updateView().phase, h.rt.updateView().installed], ['installed', NEXT])
})

test('a release that does not start again in place still waits for the next DSH start, its bundle untouched', async () => {
  const next = release(NEXT)
  // DSH refuses to publish the resolution: the bundle is not enabled again.
  const refused = harness({ releases: [next], hmr: true, install: notStarted })
  const enabled = []
  refused.services.pluginPackages = { refresh: async () => { throw new Error('profile resolution: replacing "jose" requires a process restart') } }
  refused.manager.setBundleEnabled = async (...args) => { enabled.push(args); return { application: 'applied' } }
  await installWhenIdle(refused)
  assert.deepEqual(enabled, [])
  assert.equal(restartNote(refused.warnings).at(-1), 'publishing the module resolution failed: profile resolution: replacing "jose" requires a process restart')
  assert.deepEqual([refused.rt.updateView().phase, refused.rt.updateView().installed], ['installed', NEXT])
  assert.equal(existsSync(join(refused.home, 'update.json')), true)

  // Enabling the bundle again does not start it either.
  const stuck = harness({ releases: [next], hmr: true, install: notStarted })
  stuck.services.pluginPackages = { refresh: async () => {} }
  stuck.manager.setBundleEnabled = async name => ({ stage: 'enable', target: name, changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'dsh: warning: 1 entry did not activate' } })
  await installWhenIdle(stuck)
  assert.equal(restartNote(stuck.warnings).at(-1), `enabling ${PKG.name} answered dsh: warning: 1 entry did not activate`)
  assert.deepEqual([stuck.rt.updateView().phase, stuck.rt.updateView().installed], ['installed', NEXT])
  assert.equal(existsSync(join(stuck.home, 'update.json')), true)

  // A plugin manager that throws is reported the same way.
  const thrown = harness({ releases: [next], hmr: true, install: notStarted })
  thrown.services.pluginPackages = { refresh: async () => {} }
  thrown.manager.setBundleEnabled = async () => { throw new Error('lock wait timed out') }
  await installWhenIdle(thrown)
  assert.equal(restartNote(thrown.warnings).at(-1), `enabling ${PKG.name} answered lock wait timed out`)
})

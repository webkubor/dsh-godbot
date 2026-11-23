import { execFile, execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { findExecutable } from '../../src/drivers/external/discover.js'
import { hostPeerSpecs } from '../../scripts/host-peers.mjs'
import { startModel } from './model.mjs'
import { clientRegistrations } from './artifacts.mjs'

const run = promisify(execFile)
const dsh = findExecutable('dsh')
const peerCache = new Map()
export const redact = value => String(value).replace(/([?&]token=)[^\s&#]+/giu, '$1[redacted]').replace(/(Bearer\s+)[A-Za-z0-9+/=_-]+/giu, '$1[redacted]')
export async function until(check, explanation, timeout = 30_000) {
  const end = Date.now() + timeout
  let error
  while (Date.now() < end) {
    try {
      const value = await check()
      if (value) return value
    } catch (cause) { error = cause }
    await delay(120)
  }
  throw new Error('Timed out waiting for ' + explanation + (error ? ': ' + redact(error.message) : ''))
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export class EnvironmentError extends Error {}

export async function dshForPreviousArchive(archive, scratch) {
  const version = archive.pkg.engines?.dsh
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version ?? '')) throw new EnvironmentError('The upgrade baseline must declare an exact DSH version')
  if (execFileSync(dsh, ['--version'], { encoding: 'utf8' }).trim() === version) return dsh
  if (process.env.GODBOT_E2E_PREVIOUS_DSH) return process.env.GODBOT_E2E_PREVIOUS_DSH
  const npm = findExecutable('npm')
  if (!npm) throw new EnvironmentError('npm is needed to install DSH ' + version + ' for the upgrade baseline')
  const prefix = join(scratch, 'previous-dsh')
  try {
    await run(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '@deepseek-ai/dsh@' + version],
      { timeout: 180_000, env: { ...process.env, CI: '1' } })
  } catch (error) {
    throw new EnvironmentError('Could not install baseline DSH ' + version + ': ' + redact(error.stderr || error.message))
  }
  const executable = join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  if (!existsSync(executable)) throw new EnvironmentError('The baseline DSH installation has no executable')
  return executable
}

export async function openBrowser() {
  try {
    const override = process.env.GODBOT_E2E_CHROMIUM
    const bundled = chromium.executablePath()
    const executablePath = override || (existsSync(bundled) ? bundled : undefined)
    const source = override ? 'GODBOT_E2E_CHROMIUM' : executablePath ? 'Playwright Chromium' : 'installed Chrome channel'
    const browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' })
    return { browser, source }
  } catch (error) {
    throw new EnvironmentError('Could not launch Chromium. Run npx --no-install playwright-core install --no-shell chromium or set GODBOT_E2E_CHROMIUM. ' + redact(error.message))
  }
}

async function stopGroup(child, signal, exited) {
  try { process.kill(-child.pid, signal) }
  catch (error) {
    if (error.code === 'ESRCH') return
    if (error.code !== 'EPERM') throw error
    // Darwin may see the group leader tearing down before libuv delivers its exit.
    await Promise.race([exited, delay(1000, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null) throw error
  }
}

export async function createHost({ scratch, browser, reportDir, note }, options = {}) {
  if (!dsh) throw new EnvironmentError('dsh CLI is unavailable on PATH')
  const root = await mkdtemp(join(scratch, 'host-'))
  const home = join(root, 'dsh')
  const account = join(root, 'account')
  const bin = join(root, 'bin')
  const workspace = join(root, 'work')
  await Promise.all([root, home, account, bin, workspace].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })))
  await symlink(process.execPath, join(bin, 'node'))
  const git = findExecutable('git')
  if (!git) throw new EnvironmentError('git is required to prepare the isolated test workspace')
  await run(git, ['init', '-q', workspace])
  await run(git, ['-C', workspace, '-c', 'user.name=NativeCrew E2E', '-c', 'user.email=fixture@localhost',
    '-c', 'commit.gpgSign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture workspace'])
  const model = await startModel()
  let context
  try { context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }) }
  catch (error) { await model.close(); throw error }
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const notice = page.getByRole('dialog', { name: /预览版说明|Preview Notice/u })
  await page.addLocatorHandler(notice, () => notice.getByRole('button', { name: /继续|Continue/u }).click())
  const later = page.getByRole('button', { name: /稍后配置|Set up later/u })
  await page.addLocatorHandler(later, () => later.click())
  let boot
  const pendingSources = new Set()
  const wrongSources = []
  page.on('response', res => {
    if (!boot || !res.url().includes('/plugins/') || !res.ok()) return
    const active = boot
    const read = res.text().then(source => {
      const hashes = clientRegistrations(source)
      if (!hashes.length) return
      active.matches.push(...hashes)
      if (hashes.length !== 1 || hashes[0] !== active.clientSha256) wrongSources.push({ expected: active.clientSha256, received: hashes })
    }).catch(error => {
      if (/(?:nativecrew|dsh-godbot)\/client\.js/u.test(res.url()) && active === boot) active.failure = error.message
    })
    pendingSources.add(read)
    read.finally(() => pendingSources.delete(read))
  })
  const warnings = []
  page.on('pageerror', error => warnings.push(redact(error.stack || error.message).slice(0, 2600)))
  const port = await freePort()
  let child, exited, output = '', secretUrl
  let startupMarker
  const url = 'http://127.0.0.1:' + port
  const host = {
    root, home, bin, page, model, workspace, url, reportDir,
    patch: options.patch ?? [], env: options.env ?? {}, artifact: undefined, executable: dsh,
    async install(artifact, executable = dsh) {
      if (child) throw new Error('Stop Host before replacing its package')
      const key = JSON.stringify([executable, artifact.pkg.engines?.dsh, artifact.pkg.peerDependencies])
      if (!peerCache.has(key)) peerCache.set(key, hostPeerSpecs(artifact.pkg, executable))
      const packaged = join(root, 'godbot-' + artifact.sha256 + '.tgz')
      if (!existsSync(packaged)) await symlink(artifact.path, packaged)
      try {
        await run(executable, ['plugin', '--profile', 'web', 'add', '--save-exact', packaged, ...peerCache.get(key)], {
          cwd: root, env: { ...process.env, DSH_HOME: home, CI: '1' }, timeout: 180_000, maxBuffer: 8_000_000,
        })
      } catch (error) { throw new EnvironmentError('Installing the test artifact failed: ' + redact(error.stderr || error.message)) }
      host.artifact = artifact
      host.executable = executable
      note('installed', { archive: artifact.sha256, expectedBuild: artifact.buildId, profile: 'web', dshVersion: artifact.pkg.engines?.dsh })
    },
    async start({ expectedPluginFailure } = {}) {
      if (child || !host.artifact) throw new Error('Install an artifact into a stopped Host first')
      const overlay = join(root, 'overrides.yml')
      await writeFile(overlay, JSON.stringify([
        { id: 'llm-deepseek', config: { baseURL: model.url + '/' } },
        { id: 'godbot', config: { importWorkspaceParent: join(root, 'imports'), drivers: { dsh: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
        ...host.patch,
      ]))
      // No interactive user's model keys or native CLI homes enter the running server.
      const env = {
        HOME: account, PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter), SHELL: '/bin/false',
        LANG: 'en_US.UTF-8', TMPDIR: root, DSH_HOME: home, DEEPSEEK_BASE_URL: model.url,
        DEEPSEEK_API_KEY: 'local-fixture-key',
        // The release under test must stay installed: no update check reaches GitHub.
        GODBOT_UPDATE_CHECK: '0', ...host.env,
      }
      const args = ['--profile', 'web', '--patch', overlay, '--no-open', '--port', String(port)]
      output = ''
      secretUrl = undefined
      startupMarker = undefined
      child = spawn(host.executable, args, { env, cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const collect = chunk => {
        output = (output + chunk).slice(-192_000)
        secretUrl ??= output.match(new RegExp('http://127\\.0\\.0\\.1:' + port + '/\\?token=[^\\s\\x1b]+'))?.[0]
        if (expectedPluginFailure && output.includes(expectedPluginFailure)) startupMarker = expectedPluginFailure
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      exited = new Promise(resolve => { child.once('error', error => { collect(error.message); resolve() }); child.once('exit', resolve) })
      try {
        await until(() => {
          if (startupMarker) return true
          if (child.exitCode !== null || child.signalCode !== null) return true
          return !!secretUrl
        }, 'the isolated DSH web listener', 50_000)
        if (expectedPluginFailure) {
          await until(() => startupMarker, 'the injected startup diagnostic', 12_000)
          const snapshot = await host.snapshot().catch(() => undefined)
          if (snapshot) throw new Error('Faulty Host still accepts NativeCrew operations')
          return
        }
        if (!secretUrl) throw new Error('DSH exited before it could open its browser session')
        boot = { clientSha256: host.artifact.clientSha256, matches: [] }
        await page.goto(secretUrl, { waitUntil: 'domcontentloaded' })
        const snapshot = await until(async () => {
          const value = await host.snapshot()
          if (value.workspaceRuntime?.mode === 'embedded') return value
          if (value.workspaceRuntime?.message) throw new Error(value.workspaceRuntime.message)
        }, 'the embedded NativeCrew Remote', 45_000)
        if (snapshot.buildId !== host.artifact.buildId) throw new Error('Loaded Host build ' + snapshot.buildId + ', expected ' + host.artifact.buildId)
        await until(() => boot.matches.length || boot.failure, 'client registration from the packaged browser plugin', 30_000)
        if (boot.failure || wrongSources.length || boot.matches.some(digest => digest !== host.artifact.clientSha256)) {
          throw new Error('Served NativeCrew client differs from the installed archive: ' + JSON.stringify({ expected: host.artifact.clientSha256, received: boot.matches, failure: boot.failure }))
        }
        note('started', { buildId: snapshot.buildId, clientSha256: host.artifact.clientSha256, workspaceMode: snapshot.workspaceRuntime.mode, workspaceVersion: snapshot.workspaceRuntime.version })
      } catch (error) { throw new Error(redact(error.message) + '\n' + redact(output.slice(-3500))) }
    },
    async rpc(method, args = {}) {
      const endpoint = method.includes('/') ? method : 'godbot/' + method
      const rpcId = randomUUID()
      const res = await context.request.post(url + '/api/' + endpoint, {
        data: { type: 'client-request', rpcId, method: endpoint, payload: { args } },
        headers: { Origin: url }, timeout: 12_000,
      })
      if (!res.ok()) throw new Error('DSH RPC ' + endpoint + ' returned HTTP ' + res.status())
      const frame = await res.json()
      if (frame.rpcId !== rpcId || !frame.result?.ok) throw new Error('DSH RPC ' + endpoint + ': ' + (frame.result?.error?.message ?? 'invalid response'))
      return frame.result.value
    },
    snapshot: () => host.rpc('godbot/snapshot'),
    async bot(endpoint, payload = {}) {
      // The upgrade scenario also drives the RPC shipped in the older test archive.
      const method = host.artifact.pkg.dependencies?.['ds-bot'] ? 'dsBot/call' : 'godbotTeam/call'
      const result = await host.rpc(method, { endpoint, payload })
      if (!result?.ok) throw new Error('Bot ' + endpoint + ': ' + (result?.error?.message ?? 'invalid response'))
      return result.value
    },
    async stop(signal = 'SIGTERM') {
      if (!child) return
      const owned = child
      if (owned.exitCode === null && owned.signalCode === null) {
        await stopGroup(owned, signal, exited)
        await Promise.race([exited, delay(4500, undefined, { ref: false })])
        if (owned.exitCode === null && owned.signalCode === null) {
          await stopGroup(owned, 'SIGKILL', exited)
          await exited
        }
      }
      child = undefined
    },
    async restart() { await host.stop(); await host.start() },
    async capture(name) {
      const path = join(reportDir, name + '.png')
      const secrets = page.locator('pre, input, textarea, [data-sensitive], [data-secret], [role=status]:has-text("仅显示一次"), [role=status]:has-text("邀请链接")')
      await page.screenshot({ path, mask: [secrets] })
      note('screenshot', { file: name + '.png' })
    },
    async close() {
      await host.stop()
      await context.close()
      await model.close()
      await Promise.allSettled([...pendingSources])
      if (warnings.length) note('page-errors', { errors: warnings.slice(-8) })
      if (wrongSources.length) throw new Error('Detected a different browser client registration: ' + JSON.stringify(wrongSources))
    },
  }
  return host
}

export function installedVersions() {
  const version = command => {
    try { return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[0] }
    catch { return null }
  }
  return { dsh: dsh && version(dsh), node: process.version, pnpm: version('pnpm') }
}

// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Updates: compare this package's version with the newest release where it was
// installed from — the npm registry, a GitHub tag for a versioned git install, or
// the repository's GitHub releases for a packed archive (what
// scripts/install-local.mjs installs, and every update after it) — and reinstall
// it through DSH. A linked or local checkout is never offered one.
//
// The host also looks by itself, on a clock, the way magpie's updater does:
// at start and every six hours. A release archive is fetched and verified as soon
// as it is found, so installing is local. With automatic updates on, the archive
// is installed once NativeCrew has been idle for a while (no turn running, no native
// terminal open); otherwise the sidebar and About offer it. A new version runs
// from the next DSH start.
//
// Where DSH reloads plugins in place (its `hmr` service), the install goes through
// DSH's own CLI, `dsh plugin --profile <name> add` (what install-local runs), not
// the plugin manager in this process: that one imports the new version here at
// once. DSH keeps the module resolutions this process made until it publishes a
// changed runtime resolution, so when pnpm moves a copy of one of NativeCrew's
// dependencies during the install (a dedupe) and that table stays the same, the
// new version still opens the old path, its import fails, and NativeCrew stops. The CLI
// leaves the running version alone; the next start loads the new one in a fresh
// process. Where the CLI cannot be found the plugin manager still installs. A
// release that lands in the profile but does not start in place is started again:
// DSH publishes its resolution afresh and the bundle is enabled again, which imports
// the new version from the current layout. If that fails too, the release waits for
// the next DSH start.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  archiveManifest, compatibility, createNet, defaultArchiveDir, downloadArchive, dropPartials, newer, newestRelease, releasesApi,
} from './update-release.js'

export { newer }

const PKG = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'))
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
export const MIRROR_REGISTRY = 'https://registry.npmmirror.com/'
// Every window that opens asks; within this long the last answer stands.
export const CHECK_TTL_MS = 10 * 60_000
export const FETCH_TIMEOUT_MS = 8000
// The first check waits until the host has settled its own start.
const STARTUP_DELAY_MS = 15_000
// The clock: how often the host asks by itself, how long a failed download waits
// before it is tried again, and how long NativeCrew stays idle before an automatic install.
export const AUTO_CHECK_MS = 6 * 60 * 60_000
export const RETRY_MS = 30 * 60_000
export const IDLE_MS = 2 * 60_000
// How long DSH's CLI may take to install a release before the update counts as failed.
export const INSTALL_TIMEOUT_MS = 20 * 60_000
const TICK_MS = 60_000
// auto: check, download and install when idle; notify: check and download, install
// on a click; off: only a click on Check for updates asks.
export const UPDATE_MODES = ['auto', 'notify', 'off']
const VERSION = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/
const APP_BOOT = '@deepseek-ai/dsh-app-boot'
const DSH_CLI = '@deepseek-ai/dsh'

/** A release version without its `v` and build metadata, or null. */
export const cleanVersion = value => VERSION.exec(String(value ?? '').trim())?.[1] ?? null

/**
 * Whether the plugin manager put `version` into the profile and then could not start
 * it: once pnpm has finished it answers `failed` from the enable stage without undoing
 * the profile, so that version runs from the next DSH start.
 */
const landed = (result, version) => result?.application === 'failed' && result.changed === true
  && result.stage === 'enable' && cleanVersion(result.version) === version

/**
 * Start a release the plugin manager installed but could not start in place (see the top
 * of this file and https://github.com/deepseek-ai/deepseek-harness/discussions/14056).
 * Publishing DSH's runtime resolution again drops the module resolutions it kept, and
 * enabling the bundle again imports the new version from the current layout. The bundle
 * stays selected throughout, so a failure here changes nothing the next start reads.
 * @param service DSH's plugin manager.
 * @param packages DSH's `pluginPackages` service, taken before the install stopped this host.
 * @param reloads DSH's `hmr` service, which serializes the publication with its reloads.
 * @returns null once the bundle runs again, else why it does not.
 */
async function startInPlace(service, packages, reloads) {
  if (typeof packages?.refresh !== 'function') return 'DSH cannot publish its module resolution again here'
  if (typeof service?.setBundleEnabled !== 'function') return 'the plugin manager cannot enable bundles'
  try {
    await (typeof reloads?.runExclusive === 'function' ? reloads.runExclusive(() => packages.refresh()) : packages.refresh())
  } catch (error) {
    return `publishing the module resolution failed: ${error?.message ?? error}`
  }
  const on = await Promise.resolve(service.setBundleEnabled(PKG.name, true)).catch(error => ({ error: { code: error?.message ?? String(error) } }))
  if (on?.application === 'applied' && !on.error) return null
  return `enabling ${PKG.name} answered ${on?.error?.diagnostic ?? on?.error?.code ?? on?.application ?? 'nothing'}`
}

/**
 * How the profile installed this package, from the plugin manager's `source` spec:
 * `registry` (name@range), `git` (with `owner`, `repo`, the version `ref` and the
 * other fragment parts when it pins a GitHub tag), `archive` (a packed .tgz on
 * disk), `path` (link:, file: or a folder), `tarball` (over HTTP), or `unknown`.
 */
export function sourceOf(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  if (text === '') return { kind: 'unknown' }
  const local = /^(link|file):/i.test(text) || /^([a-z]:[\\/]|[\\/]|~|\.)/i.test(text)
  if (local && !/^link:/i.test(text) && /\.(?:tgz|tar\.gz)$/i.test(text)) return { kind: 'archive' }
  if (local) return { kind: 'path' }
  const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#(.*))?$/i.exec(text)
  const gitLike = /^(git\+|git:|git@|github:|gitlab:|bitbucket:)/i.test(text) || /\.git(#|$)/i.test(text)
  if (github && (gitLike || !text.startsWith('@'))) {
    const parts = (github[3] ?? '').split('&').filter(Boolean)
    const ref = parts.find(part => !part.includes(':')) ?? ''
    return {
      kind: 'git', owner: github[1], repo: github[2],
      ...(cleanVersion(ref) ? { ref } : {}),
      rest: parts.filter(part => part !== ref),
    }
  }
  if (gitLike) return { kind: 'git' }
  if (/^https?:/i.test(text)) return { kind: 'tarball' }
  return { kind: 'registry' }
}

const normalizeRegistry = url => `${String(url).trim().replace(/\/+$/, '')}/`
export const encodeName = name => (name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name))

export const fetchJson = async (url, headers = {}) => {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

// The registries the plugin manager installs from, in its order: its configured
// first one (else pnpm's own), then the fallbacks, unless that first one is private.
export async function registryPlan(config, manager) {
  if (typeof config.updateRegistry === 'string' && config.updateRegistry !== '') return [normalizeRegistry(config.updateRegistry)]
  const configured = await Promise.resolve(manager?.registries?.()).catch(() => null)
  if (!configured) return [OFFICIAL_REGISTRY, MIRROR_REGISTRY]
  const fallbacks = (configured.fallbackRegistries ?? []).map(normalizeRegistry)
  const own = configured.resolved ? normalizeRegistry(configured.resolved) : null
  const first = configured.registry ? normalizeRegistry(configured.registry) : own ?? OFFICIAL_REGISTRY
  const isPublic = first === OFFICIAL_REGISTRY || fallbacks.includes(first)
  return isPublic ? [...new Set([first, ...fallbacks])] : [first]
}

// The plugin manager's `source` for this package; DSH releases before it reported
// one leave the profile's own dependency entry to say the same.
export async function installSpecOf(ctx) {
  const manager = ctx.get?.('pluginManager')
  const bundles = await Promise.resolve(manager?.listBundles?.()).catch(() => null)
  const own = Array.isArray(bundles) ? bundles.find(bundle => bundle.name === PKG.name) : undefined
  if (typeof own?.source === 'string') return own.source
  const dependencies = profileDependencies(ctx)
  return dependencies?.[PKG.name]
}

/** The profile's own dependencies (package.json), or null where it cannot be read. */
export function profileDependencies(ctx) {
  const dir = ctx.get?.('profileContext')?.dir
  if (typeof dir !== 'string') return null
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies ?? {}
  } catch { return null }
}

/** Find the installed DSH CLI and verify that it opens this same profile. */
export function profileCli(ctx) {
  const { name, dir, home, installAnchor } = ctx.get?.('profileContext') ?? {}
  if (![name, dir, home, installAnchor].every(value => typeof value === 'string' && value !== '')) return null
  // The desktop app manages its own profile, and the CLI refuses it while the app runs.
  if (name.toLowerCase() === 'desktop') return null
  try {
    const manifest = JSON.parse(readFileSync(installAnchor, 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (manifest.name !== DSH_CLI || typeof bin !== 'string') return null
    const cli = resolve(dirname(installAnchor), bin)
    // The CLI finds a profile by name below DSH_HOME; it has to be the one running here.
    if (!existsSync(cli) || realpathSync(join(home, 'profiles', name)) !== realpathSync(dir)) return null
    return { cli, name, dir, home }
  } catch { return null }
}

// In a hot-reloading host, install through a separate CLI so this process keeps
// its existing module resolutions until the next start.
export function profileCommand(ctx) {
  if (ctx.get?.('hmr') === undefined) return null
  const profile = profileCli(ctx)
  if (profile === null) return null
  const { cli, name, dir, home } = profile
  return { command: process.execPath, args: [cli, 'plugin', '--profile', name], cwd: dir, env: { ...process.env, DSH_HOME: home } }
}

// Run a command to its end, keeping the tail of what it printed for a failure message.
function runCommand(spawnProcess, { command, args, cwd, env }, timeoutMs) {
  return new Promise((done) => {
    let output = ''
    const keep = (chunk) => { output = `${output}${chunk}`.slice(-4000) }
    let child
    try {
      child = spawnProcess(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      done({ code: null, output: String(error?.message ?? error) })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      keep(`\nstopped after ${Math.round(timeoutMs / 60_000)} minutes`)
      child.kill?.()
    }, timeoutMs)
    timer.unref?.()
    const finish = (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error !== undefined) keep(`\n${error?.message ?? error}`)
      done({ code, output })
    }
    child.stdout?.on?.('data', keep)
    child.stderr?.on?.('data', keep)
    child.once?.('error', error => finish(null, error))
    child.once?.('close', code => finish(code))
  })
}

/**
 * The version of the DSH that is running us: the app-boot export, or — where that
 * import cannot see it — the nearest @deepseek-ai package.json above the entry script.
 */
export async function runningDsh(ctx) {
  try {
    const loader = ctx.get?.('loader')
    const loaded = await loader?.import?.(APP_BOOT)
    const appBoot = loader?.unwrapExports?.(loaded) ?? loaded?.default ?? loaded
    const version = cleanVersion(appBoot?.getDshRuntimeVersion?.())
    if (version) return version
  } catch { /* the export is not visible here: read the install instead */ }
  let dir = dirname(String(process.argv[1] ?? ''))
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (manifest?.name?.startsWith?.('@deepseek-ai/')) {
        const version = cleanVersion(manifest.version)
        if (version) return version
      }
    } catch { /* not a package directory */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// The public repository the releases live in, for tags and the "what's new" link.
export const repoSlug = () =>
  /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(String(PKG.repository?.url ?? PKG.repository ?? ''))?.[1] ?? null

const repoUrl = () => {
  const repo = repoSlug()
  return repo ? `https://github.com/${repo}` : null
}
const releasesUrl = () => {
  const repo = repoUrl()
  return repo ? `${repo}/releases` : (PKG.homepage ?? null)
}

/**
 * Whether prereleases are offered: a prerelease follows newer prereleases, a
 * release only newer releases, unless the profile config names `updateChannel`.
 */
export const followsPrereleases = config => config.updateChannel === 'prerelease'
  || (config.updateChannel !== 'stable' && PKG.version.includes('-'))

/** Whether update checks run at all: the profile config and GODBOT_UPDATE_CHECK=0 turn them off. */
export const updatesEnabled = config => config.updateCheck !== false && process.env.GODBOT_UPDATE_CHECK !== '0'

/** The user's update mode, kept beside the update note in the data folder. */
export function readUpdateSettings(path, fallback = 'auto') {
  const mode = UPDATE_MODES.includes(fallback) ? fallback : 'auto'
  if (path === null) return { mode }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return { mode: UPDATE_MODES.includes(value?.mode) ? value.mode : mode }
  } catch { return { mode } }
}

function writeUpdateSettings(path, settings) {
  const tmp = `${path}.${randomUUID()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(settings)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export const STARS_TTL_MS = 60 * 60_000

export function install(rt) {
  const { ctx, config } = rt
  const enabled = updatesEnabled(config)
  const manager = () => ctx.get?.('pluginManager')
  const spawnProcess = rt.updateSpawn ?? spawn
  const userAgent = `${PKG.name}/${PKG.version}`
  const net = rt.updateNet ?? createNet({ userAgent, timeoutMs: FETCH_TIMEOUT_MS })
  const archiveDir = typeof config.updateArchiveDir === 'string' && config.updateArchiveDir !== '' ? config.updateArchiveDir : defaultArchiveDir()
  const now = () => (typeof rt.updateClock === 'function' ? rt.updateClock() : Date.now())

  const status = {
    name: PKG.name, current: PKG.version, latest: null, source: 'unknown', notesUrl: releasesUrl(),
    checkedAt: 0, checkFailed: false, phase: 'idle', installed: null, error: null,
  }
  // Where the newest version was found and how it installs: a registry or git
  // `spec`, or a release `asset` that becomes a local `archive` once verified.
  let target = null
  let checking = null
  // The release archive being fetched, and what stops it.
  let preparing = null
  let preparingFor = null
  let preparingAbort = null
  let progress = null
  // Why the downloaded release cannot install into this profile.
  let blocked = null
  // The clock: when it last asked by itself, when a download last failed, since
  // when NativeCrew has been idle, and the version an automatic install failed on
  // (not tried again by itself; a click still can).
  let autoAskedAt = Number.NEGATIVE_INFINITY
  let failedAt = 0
  let downloadFailed = false
  let idleSince = 0
  let autoSkip = null
  let waiting = null

  const settingsPath = typeof rt.home === 'string' ? join(rt.home, 'update-settings.json') : null
  let settings = readUpdateSettings(settingsPath, config.updateMode)

  // An update under hot reload drops this host with its bundle; a note in the data
  // folder carries the result to the start that follows it.
  const markerPath = typeof rt.home === 'string' ? join(rt.home, 'update.json') : null
  if (markerPath !== null && existsSync(markerPath)) {
    let marker = null
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'))
    } catch (error) {
      rt.warn('godbot: could not read the update note: %s', error?.message ?? error)
    }
    if (marker === null) {
      try { unlinkSync(markerPath) } catch { /* gone is what we want */ }
    } else if (marker.to === PKG.version) {
      Object.assign(status, { phase: 'updated', installed: PKG.version })
      try { unlinkSync(markerPath) } catch { /* gone is what we want */ }
    } else if (typeof marker.error === 'string' || marker.from !== PKG.version) {
      rt.warn('godbot: the update to %s did not finish: %s', marker.to ?? 'a newer version', typeof marker.error === 'string' ? marker.error.slice(0, 600) : 'the install did not complete')
      try { unlinkSync(markerPath) } catch { /* gone is what we want */ }
    } else if (cleanVersion(marker.to)) {
      // A clean note on the version that wrote it stays: the new version is on disk
      // and waits for DSH to restart (or a reload is still running the old modules).
      // The next start that runs the new code reports the update then; until then
      // nothing installs it a second time.
      Object.assign(status, { phase: 'installed', installed: cleanVersion(marker.to) })
    }
  }

  const busy = new Set()
  /** Register a check that names work an automatic install must wait for; returns its removal. */
  rt.addUpdateBlocker = (check) => {
    busy.add(check)
    return () => busy.delete(check)
  }
  // What an install would cut short now: running turns, and whatever the blockers name.
  function busyReasons() {
    const reasons = []
    let turns = 0
    for (const entry of rt.live?.values?.() ?? []) if (entry?.turn !== undefined) turns += 1
    if (turns > 0) reasons.push({ kind: 'turns', count: turns })
    for (const check of busy) {
      try {
        const reason = check()
        if (reason) reasons.push(reason)
      } catch (error) {
        rt.warn('godbot: an update blocker failed: %s', error?.message ?? error)
      }
    }
    return reasons
  }

  const installedOrNewer = () => (status.phase === 'installed' || status.phase === 'updated')
    && status.installed !== null && target !== null && !newer(target.version, status.installed)

  const view = () => ({
    name: status.name, current: status.current, latest: status.latest, source: status.source, notesUrl: status.notesUrl,
    repoUrl: repoUrl(), enabled, mode: settings.mode,
    checkedAt: status.checkedAt, checkFailed: status.checkFailed, phase: status.phase, installed: status.installed, error: status.error,
    ...(status.phase === 'downloading' && progress !== null ? { progress: { ...progress } } : {}),
    ...(blocked !== null ? { blocked: { ...blocked } } : {}),
    ...(waiting !== null && (status.phase === 'ready' || status.phase === 'idle') ? { waiting } : {}),
    available: !installedOrNewer() && status.phase !== 'installing' && blocked === null
      && target !== null && status.latest !== null && newer(status.latest, status.current),
  })

  // Asked only while the About page is open, so a closed page never calls GitHub.
  // A failed answer keeps the last count and is asked again next time.
  let stars = { count: null, at: 0 }
  let starring = null
  async function repoStars() {
    const repo = repoSlug()
    if (repo === null) return null
    if (Date.now() - stars.at < STARS_TTL_MS) return stars.count
    starring ??= fetchJson(`https://api.github.com/repos/${repo}`, { 'user-agent': userAgent })
      .then((info) => { if (Number.isInteger(info?.stargazers_count)) stars = { count: info.stargazers_count, at: Date.now() } })
      .catch(error => rt.warn('godbot: star count failed: %s', error?.message ?? error))
      .finally(() => { starring = null })
    await starring
    return stars.count
  }

  async function newestFromRegistry() {
    for (const registry of await registryPlan(config, manager())) {
      try {
        const version = cleanVersion((await fetchJson(`${registry}${encodeName(PKG.name)}/latest`)).version)
        if (version) return { version, spec: `${PKG.name}@${version}`, registry }
      } catch { /* unreachable, or no copy there yet: ask the next one */ }
    }
    return null
  }

  async function newestFromGitHub(source) {
    if (!source.ref) return null
    const release = await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/latest`, { 'user-agent': userAgent })
    const version = cleanVersion(release?.tag_name)
    if (!version) return null
    // The API answers through redirects, so the release's html_url names the
    // repository's current address; the install moves to it.
    const current = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/releases\//.exec(release.html_url ?? '')
    const [owner, repo] = current ? [current[1], current[2]] : [source.owner, source.repo]
    const fragment = [release.tag_name, ...source.rest].join('&')
    return { version, spec: `github:${owner}/${repo}#${fragment}` }
  }

  async function newestFromReleases() {
    const repo = repoSlug()
    if (repo === null) return null
    const found = await newestRelease({ repo, name: PKG.name, prerelease: followsPrereleases(config), net, api: releasesApi() })
    return found === null ? null : { version: found.version, asset: found.asset, notesUrl: found.notesUrl }
  }

  async function runCheck() {
    // The desktop app updates as a whole, with this package inside it.
    const source = process.env.GODBOT_APP === '1' ? { kind: 'app' } : sourceOf(await installSpecOf(ctx))
    status.source = source.kind
    let found = null
    let failed = false
    try {
      if (source.kind === 'registry') found = await newestFromRegistry()
      else if (source.kind === 'git') found = await newestFromGitHub(source)
      else if (source.kind === 'archive') found = await newestFromReleases()
    } catch (error) {
      failed = true
      rt.warn('godbot: update check failed: %s', error?.message ?? error)
    }
    status.checkedAt = now()
    status.checkFailed = failed
    // A release list that could not be read keeps what the last check found: the
    // archive already fetched for it stays ready.
    if (failed && source.kind === 'archive' && target !== null) return
    // Nothing found now (a linked checkout, a moved tag, an unreachable registry)
    // retires the version a check before it found; offering it would install over
    // a source that never updates.
    if (found === null) {
      status.latest = null
      retire()
      return
    }
    status.latest = found.version
    const next = newer(found.version, status.current) ? found : null
    if (next === null) { retire(); return }
    // The same release keeps what was already fetched for it.
    if (target !== null && target.version === next.version && target.asset?.sha256 === next.asset?.sha256) {
      if (next.notesUrl) status.notesUrl = next.notesUrl
      return
    }
    retire()
    target = next
    if (next.notesUrl) status.notesUrl = next.notesUrl
    // The note that reported the last update is a one-time message; a newer
    // release found later in the same run still offers itself.
    if (status.phase === 'updated' || (status.phase === 'installed' && newer(next.version, status.installed ?? status.current))) {
      status.phase = 'idle'
    }
  }

  // Forget the release a check found before: a download under way for it stops.
  function retire() {
    preparingAbort?.abort(new Error('A newer check replaced this download'))
    target = null
    blocked = null
    progress = null
    downloadFailed = false
    waiting = null
    idleSince = 0
    if (status.phase === 'ready' || status.phase === 'downloading' || status.phase === 'failed') Object.assign(status, { phase: 'idle', error: null })
  }

  /** Ask where the package came from for its newest version; a fresh check ignores the last answer. */
  async function check({ fresh = false } = {}) {
    if (!enabled) return view()
    if (checking) {
      await checking
      return view()
    }
    if (!fresh && now() - status.checkedAt < CHECK_TTL_MS) return view()
    checking = runCheck().finally(() => { checking = null })
    await checking
    // A release found by any check is fetched ahead, unless updates are off.
    if (settings.mode !== 'off') void prepare().catch(() => {})
    return view()
  }

  /**
   * Fetch and verify the release archive the last check found, then read its own
   * package.json: it becomes `ready`, or `blocked` when it cannot install here.
   * A failed download is fetched again by itself only RETRY_MS later; `force`
   * (a click on Update) fetches it now.
   */
  function prepare({ force = false } = {}) {
    // A download for a release a newer check replaced is still stopping: this one follows it.
    if (preparing) return preparingFor === target ? preparing : preparing.then(() => prepare({ force }))
    const chosen = target
    if (chosen?.asset === undefined || chosen.archive !== undefined || blocked !== null) return Promise.resolve(view())
    if (status.phase === 'installing' || installedOrNewer()) return Promise.resolve(view())
    if (!force && downloadFailed && now() - failedAt < RETRY_MS) return Promise.resolve(view())
    const abort = new AbortController()
    preparingAbort = abort
    preparingFor = chosen
    progress = { done: 0, total: chosen.asset.size }
    Object.assign(status, { phase: 'downloading', error: null })
    preparing = (async () => {
      dropPartials(archiveDir)
      const archive = await downloadArchive({
        dir: archiveDir, name: PKG.name, version: chosen.version, asset: chosen.asset, net, signal: abort.signal,
        onProgress: (done, total) => { progress = { done, total: total ?? null } },
      })
      if (target !== chosen) return
      const dependencies = Object.keys(profileDependencies(ctx) ?? {})
      const problem = compatibility(archiveManifest(archive), {
        name: PKG.name, version: chosen.version, dsh: await runningDsh(ctx),
        // A profile whose manifest cannot be read leaves the peers to the plugin manager.
        linked: dependencies.length ? dependencies : null,
      })
      if (target !== chosen) return
      progress = null
      downloadFailed = false
      if (problem !== null) {
        blocked = problem
        Object.assign(status, { phase: 'idle', error: null })
        rt.warn('godbot: NativeCrew %s cannot install into this profile: %s', chosen.version, JSON.stringify(problem))
        return
      }
      chosen.archive = archive
      chosen.spec = archive
      Object.assign(status, { phase: 'ready', error: null })
    })()
      .catch((error) => {
        if (target !== chosen) return
        progress = null
        // Stopped on purpose (updates turned off, NativeCrew stopping): nothing failed.
        if (abort.signal.aborted) {
          if (status.phase === 'downloading') Object.assign(status, { phase: 'idle', error: null })
          return
        }
        downloadFailed = true
        failedAt = now()
        rt.warn('godbot: downloading NativeCrew %s failed: %s', chosen.version, error?.message ?? error)
        Object.assign(status, { phase: 'failed', error: String(error?.message ?? error).slice(0, 600) })
      })
      .then(() => view())
      .finally(() => {
        if (preparingAbort === abort) preparingAbort = null
        preparing = null
        preparingFor = null
      })
    return preparing
  }

  /** Start installing the newest version; the answer comes back through `check`. */
  function start({ auto = false } = {}) {
    if (status.phase === 'installing') return view()
    if (target === null) throw new Error('No NativeCrew update is available')
    if (blocked !== null) throw new Error(blockedText(blocked))
    const service = manager()
    // DSH's CLI where the plugin manager would reload this plugin in place; the plugin manager elsewhere.
    const command = profileCommand(ctx)
    if (command === null && typeof service?.installBundle !== 'function') throw new Error('The DSH plugin manager is not available in this profile')
    if (target.asset !== undefined && target.archive === undefined) {
      // A click before the download finished (or after it failed) fetches it first
      // and installs it once it is verified.
      const chosen = target
      if (status.phase === 'failed') Object.assign(status, { phase: 'idle', error: null })
      void prepare({ force: true }).then(() => {
        if (target === chosen && chosen.archive !== undefined && status.phase === 'ready') begin(chosen, auto, service, command)
      })
      return view()
    }
    begin(target, auto, service, command)
    return view()
  }

  // DSH's CLI installs into the profile and leaves this process on the running version.
  async function installWithCli(chosen, command) {
    const args = [...command.args, 'add', '--save-exact', chosen.spec, ...(chosen.registry ? [`--registry=${chosen.registry}`] : [])]
    const { code, output } = await runCommand(spawnProcess, { ...command, args }, INSTALL_TIMEOUT_MS)
    if (code !== 0) {
      const tail = output.trim().slice(-400)
      throw new Error(`dsh plugin add ${code === null ? 'did not finish' : `exited ${code}`}${tail ? `: ${tail}` : ''}`)
    }
    // The profile now names the verified archive; anything else is not what was checked.
    if (chosen.archive !== undefined) {
      const saved = profileDependencies(ctx)?.[PKG.name]
      if (typeof saved !== 'string' || basename(saved) !== basename(chosen.archive)) {
        throw new Error(`dsh plugin add left ${PKG.name} at ${saved ?? 'no version'}, not ${basename(chosen.archive)}`)
      }
    }
  }

  function begin(chosen, auto, service, command) {
    Object.assign(status, { phase: 'installing', error: null })
    waiting = null
    idleSince = 0
    // Removing or replacing this bundle disposes our context before the promise
    // answers, so the continuation uses plain fs for the note and a guarded logger.
    const note = (template, ...args) => { try { rt.warn(template, ...args) } catch { /* our context is disposed */ } }
    const mark = (error) => {
      if (markerPath === null) return
      try {
        writeFileSync(markerPath, JSON.stringify({
          from: PKG.version, to: chosen.version, spec: chosen.spec, startedAt: new Date().toISOString(), ...(auto ? { auto: true } : {}),
          ...(error === undefined ? {} : { error: String(error).slice(0, 600) }),
        }))
      } catch { /* a note that cannot be written just is not there */ }
    }
    // A refused install leaves this version running, with nothing for a later start to report.
    const unmark = () => { if (markerPath !== null) try { unlinkSync(markerPath) } catch { /* already gone */ } }
    // Written before the install can reload this plugin in place: the new version's
    // first start reads it.
    mark()
    // The note stays: the start that runs the new version reports it.
    const installed = version => Object.assign(status, { phase: 'installed', installed: cleanVersion(version) ?? chosen.version })
    const failed = (error) => {
      if (!error?.reported) unmark()
      if (auto) autoSkip = chosen.version
      note('godbot: update to %s failed: %s', chosen.version, error?.message ?? error)
      Object.assign(status, { phase: 'failed', error: String(error?.message ?? error).slice(0, 600) })
    }
    if (command !== null) {
      void installWithCli(chosen, command).then(() => {
        installed(chosen.version)
        note('godbot: NativeCrew %s is installed; it runs from the next DSH start', chosen.version)
      }, failed)
      return
    }
    const options = chosen.registry ? { registry: chosen.registry } : {}
    // Taken now: the install can stop this host, and with it the context that finds them.
    const packages = ctx.get?.('pluginPackages')
    const reloads = ctx.get?.('hmr')
    void Promise.resolve()
      .then(() => service.installBundle(chosen.spec, options))
      .then(async (result) => {
        if (result?.error?.code !== 'already-installed') return result
        // With HMR the plugin manager refuses to install a package the profile already
        // depends on: remove the bundle (which unloads this host) and install it again.
        if (typeof service.removeBundle !== 'function') return { error: { code: 'not-removable' } }
        // Asked before removal drops this host: the spec that puts the old version
        // back. A registry spec is a range that can resolve to the failed release
        // again, so pin the version that is actually running.
        const oldSpec = await Promise.resolve(installSpecOf(ctx)).catch(() => undefined)
        const previous = typeof oldSpec === 'string' && sourceOf(oldSpec).kind === 'registry' ? `${PKG.name}@${PKG.version}` : oldSpec
        // The bundle is gone now; a failed install leaves no NativeCrew unless the old one goes back.
        const restore = async (failed) => {
          if (typeof previous !== 'string' || previous === '') return failed
          const back = await Promise.resolve(service.installBundle(previous, sourceOf(previous).kind === 'registry' && chosen.registry ? { registry: chosen.registry } : {})).catch(error => ({ error: { code: error?.message ?? 'restore failed' } }))
          if (back?.error) {
            note('godbot: could not reinstall %s after the failed update: %s', previous, back.error.diagnostic ?? back.error.code)
            return failed
          }
          return `${failed}; ${previous} was reinstalled`
        }
        // A removal deselects the bundle before it unloads and removes the package, so
        // one that fails afterwards leaves the profile changed (`changed`) without NativeCrew.
        // Selecting the bundle again undoes that; if the package is gone too, the old
        // version is installed again. A removal that throws ran nothing (lock timeout).
        const recover = async (failed) => {
          const on = await Promise.resolve(service.setBundleEnabled?.(PKG.name, true)).catch(() => null)
          if (on && !on.error && ['applied', 'restart-required'].includes(on.application)) return `${failed}; ${PKG.name} was enabled again`
          return restore(failed)
        }
        const removed = await Promise.resolve(service.removeBundle(PKG.name)).catch((error) => { unmark(); throw error })
        if (removed?.error) {
          if (removed.changed) mark(await recover(removed.error.diagnostic ?? removed.error.code))
          else unmark()
          return { error: removed.error, reported: true }
        }
        try {
          const again = await service.installBundle(chosen.spec, options)
          // Installed but not started in place: the next start runs it, so the old
          // version is not put back over it.
          if (landed(again, chosen.version)) return again
          // A failure also arrives as an application state with no error; the
          // result check below rejects every one of those, so restore sees the
          // same failures it does.
          if (again?.error || !['applied', 'restart-required'].includes(again?.application)) {
            mark(await restore(again?.error?.diagnostic ?? again?.error?.code ?? `install ${again?.application ?? 'failed'}`))
            return { ...again, reported: true }
          }
          return again
        } catch (error) {
          mark(await restore(error?.message ?? String(error)))
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { reported: true })
        }
      })
      .then(async (result) => {
        if (landed(result, chosen.version)) {
          // DSH reloaded the plugin in place and the new version did not start: the
          // old one is already stopped. Start the new one again; failing that, the next
          // DSH start runs it. Either way the note stays for the start that runs it.
          const why = result.error?.diagnostic ?? result.error?.code
          const retry = await startInPlace(service, packages, reloads)
          if (retry === null) note('godbot: NativeCrew %s did not start in place (%s); it started after DSH published its module resolution again', chosen.version, why)
          else note('godbot: NativeCrew %s is installed but did not start in this DSH; restart DSH to use it: %s; starting it again: %s', chosen.version, why, retry)
          installed(chosen.version)
          return
        }
        if (result?.error || !['applied', 'restart-required'].includes(result?.application)) {
          // A direct install that failed before the package landed restored the
          // profile: the running version stays, and nothing is left for a later start
          // to report. A removal that went wrong already wrote what happened into the note.
          if (!result?.reported) unmark()
          throw Object.assign(new Error(result?.error?.diagnostic ?? result?.error?.code ?? `install ${result?.application ?? 'failed'}`), { reported: true })
        }
        installed(result.version)
      })
      .catch(failed)
  }

  function blockedText(problem) {
    if (problem.reason === 'dsh') return `NativeCrew ${target?.version ?? ''} needs DSH ${problem.dsh}`
    if (problem.reason === 'peers') return `NativeCrew ${target?.version ?? ''} needs ${problem.peers.join(', ')}; run scripts/install-local.mjs again`
    return `The release archive holds ${problem.found}`
  }

  /** Change the update mode; `off` stops the clock and any automatic download. */
  function setSettings(patch = {}) {
    if (!UPDATE_MODES.includes(patch.mode)) throw new Error('Choose auto, notify or off')
    if (settingsPath === null) throw new Error('This host keeps no update settings')
    writeUpdateSettings(settingsPath, { mode: patch.mode })
    settings = { mode: patch.mode }
    waiting = null
    idleSince = 0
    if (settings.mode === 'off') {
      if (status.phase === 'downloading') {
        preparingAbort?.abort(new Error('Automatic updates were turned off'))
        progress = null
        Object.assign(status, { phase: 'idle', error: null })
      }
    } else if (target !== null) void prepare().catch(() => {})
    return view()
  }

  // One minute of the clock: ask when due, fetch again after a failed download,
  // and in auto mode install the ready version once NativeCrew has been idle a while.
  // A host that only reads the team never installs by itself: the writing host does.
  async function tick() {
    if (!enabled || settings.mode === 'off') { waiting = null; return }
    const at = now()
    if (at - autoAskedAt >= AUTO_CHECK_MS) {
      autoAskedAt = at
      await check({ fresh: true })
    } else if (status.phase === 'failed' && downloadFailed && at - failedAt >= RETRY_MS) {
      Object.assign(status, { phase: 'idle', error: null })
      await prepare()
    }
    if (settings.mode !== 'auto' || target === null || autoSkip === target.version || rt.readOnly?.()) { waiting = null; return }
    const ready = target.asset === undefined ? view().available && status.phase === 'idle' : status.phase === 'ready'
    if (!ready) { waiting = null; return }
    const reasons = busyReasons()
    if (reasons.length > 0) {
      waiting = reasons
      idleSince = 0
      return
    }
    waiting = [{ kind: 'idle' }]
    if (idleSince === 0) { idleSince = at; return }
    if (at - idleSince < IDLE_MS) return
    rt.warn('godbot: installing NativeCrew %s now that the workspace is idle', target.version)
    try { start({ auto: true }) } catch (error) {
      autoSkip = target.version
      rt.warn('godbot: automatic update to %s did not start: %s', target.version, error?.message ?? error)
    }
  }

  if (enabled) {
    ctx.effect(() => {
      let stopped = false
      let timer
      const loop = async () => {
        if (stopped) return
        try { await tick() } catch (error) { rt.warn('godbot: update clock failed: %s', error?.message ?? error) }
        if (stopped) return
        timer = setTimeout(loop, TICK_MS)
        // A pending check never keeps the process alive.
        timer.unref?.()
      }
      timer = setTimeout(loop, STARTUP_DELAY_MS)
      timer.unref?.()
      return () => {
        stopped = true
        clearTimeout(timer)
        preparingAbort?.abort(new Error('NativeCrew stopped'))
      }
    }, 'godbot: update clock')
  }

  Object.assign(rt, {
    updateCheck: check, updateStart: () => start(), updateView: view, updateSettings: setSettings,
    updateTick: tick, updatePrepare: prepare, updateBusy: busyReasons, repoStars,
  })
}

// NativeCrew releases on GitHub. Each tag vX.Y.Z carries the packed plugin as the
// asset dsh-godbot-X.Y.Z.tgz (.github/workflows/release.yml). GitHub records
// every uploaded asset's SHA-256 as its `digest`; a release without one may
// carry dsh-godbot-X.Y.Z.tgz.sha256 beside it. An archive is installed only
// once its bytes match that hash and its own package.json names this package
// at that version, for the DSH and the linked peers this profile runs.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { gunzipSync } from 'node:zlib'

const VERSION = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)(?:\+[\w.]+)?$/
const SHA256 = /^[0-9a-f]{64}$/
// A whole release download, however slow, ends after this long.
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000
// The unpacked archive is read whole; a real one is a few megabytes.
const MAX_UNPACKED = 64 * 1024 * 1024

const cleanVersion = value => VERSION.exec(String(value ?? '').trim())?.[1] ?? null

export const GITHUB_API = 'https://api.github.com'

/**
 * The GitHub API the release list is read from. GODBOT_UPDATE_API points it at
 * another server with the same answers, for testing an update against a local
 * one; the archive is still checked against the SHA-256 that answer states.
 */
export function releasesApi(env = process.env) {
  const value = String(env.GODBOT_UPDATE_API ?? '').trim()
  return /^https?:\/\/[^\s]+$/i.test(value) ? value : GITHUB_API
}

/** Where packed archives live: the folder scripts/install-local.mjs writes to as well. */
export const defaultArchiveDir = () => join(homedir(), '.local/share/dsh-godbot/packages')

/** The release asset that holds the packed plugin, as `npm pack` names it. */
export const assetName = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`

/** Whether version `a` is newer than `b` (semver order, prereleases before their release). */
export function newer(a, b) {
  const parse = (value) => {
    const [core, pre] = (cleanVersion(value) ?? '0.0.0').split(/-(.*)/s)
    return { nums: core.split('.').map(Number), pre: pre ?? null }
  }
  const x = parse(a)
  const y = parse(b)
  for (let index = 0; index < 3; index++) if (x.nums[index] !== y.nums[index]) return x.nums[index] > y.nums[index]
  if (x.pre === y.pre) return false
  if (x.pre === null) return true
  if (y.pre === null) return false
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0
}

/** The hash a sidecar `.sha256` file states: its first word, as sha256sum prints it. */
export function sidecarDigest(text) {
  const word = String(text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  return SHA256.test(word) ? word : null
}

/**
 * The newest published release that carries this package's archive: drafts are
 * skipped, prereleases count only when `prerelease` is on. Answers null when the
 * repository has none.
 */
export async function newestRelease({ repo, name, prerelease, net, api = GITHUB_API }) {
  const releases = await net.json(`${api.replace(/\/+$/, '')}/repos/${repo}/releases?per_page=30`)
  if (!Array.isArray(releases)) throw new Error('GitHub answered without a list of releases')
  let best = null
  for (const release of releases) {
    if (release === null || typeof release !== 'object' || release.draft) continue
    const version = cleanVersion(release.tag_name)
    if (!version || ((release.prerelease || version.includes('-')) && !prerelease)) continue
    if (best !== null && !newer(version, best.version)) continue
    const assets = Array.isArray(release.assets) ? release.assets : []
    const file = assets.find(asset => asset?.name === assetName(name, version))
    if (typeof file?.browser_download_url !== 'string') continue
    best = { version, release, assets, file }
  }
  if (best === null) return null
  const { version, release, assets, file } = best
  let sha256 = /^sha256:([0-9a-f]{64})$/i.exec(String(file.digest ?? ''))?.[1]?.toLowerCase() ?? null
  if (sha256 === null) {
    const sidecar = assets.find(asset => asset?.name === `${file.name}.sha256`)
    if (typeof sidecar?.browser_download_url === 'string') sha256 = sidecarDigest(await net.text(sidecar.browser_download_url))
  }
  // An archive nothing vouches for is never offered.
  if (sha256 === null) throw new Error(`Release ${release.tag_name} states no SHA-256 for ${file.name}`)
  return {
    version,
    tag: release.tag_name,
    notesUrl: typeof release.html_url === 'string' ? release.html_url : null,
    asset: { name: file.name, url: file.browser_download_url, size: Number.isSafeInteger(file.size) ? file.size : null, sha256 },
  }
}

export async function fileSha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Download a release archive into `dir` as name-version-<hash12>.tgz, the way
 * install-local names its own, and check its size and SHA-256 before it takes
 * that name. A file already there with the same hash is used as it is.
 */
export async function downloadArchive({ dir, name, version, asset, net, signal, onProgress }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, assetName(name, `${version}-${asset.sha256.slice(0, 12)}`))
  if (existsSync(target) && await fileSha256(target) === asset.sha256) return target
  const part = `${target}.${randomUUID()}.part`
  try {
    await net.download(asset.url, part, { signal, total: asset.size, onProgress })
    const size = statSync(part).size
    if (asset.size !== null && size !== asset.size) throw new Error(`The download has ${size} bytes, not the ${asset.size} the release lists`)
    const actual = await fileSha256(part)
    if (actual !== asset.sha256) throw new Error(`The download's SHA-256 ${actual} does not match the release's ${asset.sha256}`)
    renameSync(part, target)
    return target
  } finally {
    rmSync(part, { force: true })
  }
}

/**
 * Remove the partial downloads an interrupted run left behind. One younger than
 * `olderThanMs` may still be written by another profile's NativeCrew sharing the folder.
 */
export function dropPartials(dir, { olderThanMs = 60 * 60_000, now = Date.now() } = {}) {
  let names
  try { names = readdirSync(dir) } catch { return }
  for (const name of names) {
    if (!name.endsWith('.part')) continue
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs >= olderThanMs) rmSync(path, { force: true })
    } catch { /* already gone */ }
  }
}

/** The package.json inside an `npm pack` archive (package/package.json), read without unpacking to disk. */
export function archiveManifest(path) {
  const tar = gunzipSync(readFileSync(path), { maxOutputLength: MAX_UNPACKED })
  let longName = null
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '')
    const size = Number.parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('The archive has a damaged entry header')
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const prefix = field(345, 155)
    const named = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const body = tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    // GNU and PAX long names describe the entry that follows.
    if (type === 'L') { longName = body.toString('utf8').replace(/\0[\s\S]*$/, ''); continue }
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1]
      if (path) longName = path
      continue
    }
    if (type === '0' && named === 'package/package.json') return JSON.parse(body.toString('utf8'))
  }
  throw new Error('The archive holds no package/package.json')
}

/**
 * Whether an archive's manifest can replace the running plugin in this profile:
 * the same package at the version the release names, built for the running DSH,
 * with every peer it declares already linked in the profile (a peer pnpm would
 * fetch on its own is a second copy of DSH's scope registry).
 */
export function compatibility(manifest, { name, version, dsh, linked }) {
  if (manifest?.name !== name || cleanVersion(manifest?.version) !== version)
    return { reason: 'mismatch', found: `${manifest?.name ?? '?'}@${manifest?.version ?? '?'}` }
  const needs = cleanVersion(manifest.engines?.dsh)
  if (dsh && needs && needs !== dsh) return { reason: 'dsh', dsh: needs, current: dsh }
  if (Array.isArray(linked)) {
    const missing = Object.keys(manifest.peerDependencies ?? {}).filter(peer => !linked.includes(peer))
    if (missing.length) return { reason: 'peers', peers: missing }
  }
  return null
}

/** Network access for updates: JSON, text, and a streamed file download. Tests pass their own. */
export function createNet({ userAgent, timeoutMs = 8000, fetch: fetchImpl = globalThis.fetch } = {}) {
  const headers = { 'user-agent': userAgent }
  async function get(url, accept, signal) {
    const response = await fetchImpl(url, { headers: { ...headers, accept }, redirect: 'follow', signal })
    if (!response.ok) throw new Error(`${url} answered ${response.status}`)
    return response
  }
  return {
    async json(url) {
      return (await get(url, 'application/vnd.github+json, application/json', AbortSignal.timeout(timeoutMs))).json()
    },
    async text(url) {
      return (await get(url, 'text/plain, */*', AbortSignal.timeout(timeoutMs))).text()
    },
    async download(url, path, { signal, total = null, onProgress } = {}) {
      const bounded = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(signal ? [signal] : [])])
      const response = await get(url, 'application/octet-stream', bounded)
      if (response.body === null) throw new Error(`${url} answered without a body`)
      const length = Number(response.headers.get('content-length'))
      const expected = Number.isSafeInteger(length) && length > 0 ? length : total
      let done = 0
      const count = new Transform({
        transform(chunk, _encoding, callback) {
          done += chunk.length
          onProgress?.(done, expected)
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), count, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: bounded })
    },
  }
}

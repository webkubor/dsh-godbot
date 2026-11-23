import { execFileSync } from 'node:child_process'
import { createHash, verify, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const source = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({ options: { 'trust-key': { type: 'string' }, rollback: { type: 'boolean' } } })
const manifestBytes = readFileSync(join(source, 'manifest.json'))
const info = JSON.parse(manifestBytes)
if (
  !['host', 'desktop'].includes(info.component) ||
  !/^\d+\.\d+\.\d+$/.test(info.version) ||
  info.platform !== process.platform ||
  info.arch !== process.arch
)
  throw new Error('This package is for a different platform')
const base = join(homedir(), '.local/share/godbot-computer')
const trusted = join(base, 'publisher.pem')
let key
if (existsSync(trusted)) {
  key = readFileSync(trusted)
  if (values['trust-key'] && !readFileSync(values['trust-key']).equals(key))
    throw new Error('The configured publisher key is different')
} else if (values['trust-key']) key = readFileSync(values['trust-key'])
else throw new Error('Supply --trust-key with the independently verified publisher public key')
if (!verify('sha256', manifestBytes, key, readFileSync(join(source, 'manifest.sig'))))
  throw new Error('Invalid package signature')
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex')
function verifiedFile(path) {
  if (!lstatSync(path).isFile()) throw new Error('Unsafe package entry')
  return readFileSync(path)
}
function verifyContents(root, manifest = info) {
  for (const [rel, expected] of Object.entries(manifest.files)) {
    if (
      !rel ||
      rel.startsWith('/') ||
      rel.split('/').some((segment) => !segment || segment === '..' || segment === '.')
    )
      throw new Error('Invalid package path')
    if (digest(verifiedFile(join(root, rel))) !== expected) throw new Error('Corrupt package entry: ' + rel)
  }
  if (manifest.component === 'desktop' && process.platform === 'darwin') {
    execFileSync(
      '/usr/bin/codesign',
      [
        '--verify',
        '--strict',
        '-R=identifier "io.github.renjiegod.godbot.computerhost"',
        join(root, 'native/NativeCrew Computer Host.app'),
      ],
      { stdio: 'pipe' },
    )
  }
}
verifyContents(source)
const releases = join(base, 'releases')
mkdirSync(releases, { recursive: true, mode: 0o700 })
const releaseName =
  info.component +
  '-' +
  info.version +
  '-' +
  info.platform +
  '-' +
  info.arch +
  '-' +
  digest(manifestBytes).slice(0, 12)
const release = join(releases, releaseName)
const active = join(base, info.component === 'host' ? 'current' : 'desktop-current')
const previous = active + '-previous'
const owners = join(base, '.install-owners')
mkdirSync(owners, { recursive: true, mode: 0o700 })
const myToken = process.pid + '.' + randomUUID()
const lock = join(owners, myToken)
mkdirSync(lock, { mode: 0o700 })
function checkExclusive() {
  for (const name of readdirSync(owners)) {
    if (name === myToken) continue
    const match = /^(\d+)\.[a-f0-9-]{36}$/.exec(name)
    if (!match) throw new Error('Unexpected installation lock')
    try {
      process.kill(Number(match[1]), 0)
    } catch (err) {
      if (err.code !== 'ESRCH') throw err
      rmSync(join(owners, name), { recursive: true, force: true })
      continue
    }
    throw new Error('Another package installation is running')
  }
}
function installedManifest(target) {
  const path = resolve(base, target)
  if (dirname(path) !== releases) throw new Error('Unexpected installed release')
  const bytes = verifiedFile(join(path, 'manifest.json'))
  if (!verify('sha256', bytes, key, verifiedFile(join(path, 'manifest.sig'))))
    throw new Error('Invalid installed release signature')
  const manifest = JSON.parse(bytes)
  if (
    manifest.component !== info.component ||
    manifest.platform !== info.platform ||
    manifest.arch !== info.arch
  )
    throw new Error('Incorrect installed release type')
  return { path, manifest }
}
function older(candidate, current) {
  const a = candidate.split('.').map(Number),
    b = current.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] < b[index]
  return false
}
function addMacApplicationShortcut() {
  const apps = join(homedir(), 'Applications')
  const link = join(apps, 'NativeCrew Computer Host.app')
  const target = join(base, 'desktop-current/native/NativeCrew Computer Host.app')
  mkdirSync(apps, { recursive: true, mode: 0o700 })
  try {
    symlinkSync(target, link)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    const existing = lstatSync(link)
    if (!existing.isSymbolicLink() || resolve(apps, readlinkSync(link)) !== target) {
      console.log('The NativeCrew helper is available at ' + target)
      return
    }
  }
  console.log('NativeCrew Computer Host application: ' + link)
}
function point(link, target) {
  const temp = link + '.' + randomUUID()
  symlinkSync(target, temp)
  renameSync(temp, link)
}
try {
  checkExclusive()
  if (!existsSync(trusted)) writeFileSync(trusted, key, { mode: 0o600, flag: 'wx' })
  const old = existsSync(active) ? readlinkSync(active) : null
  if (values.rollback) {
    if (!old || !existsSync(previous)) throw new Error('No previous installation for this component')
    const prior = readlinkSync(previous)
    const { path, manifest } = installedManifest(prior)
    verifyContents(path, manifest)
    point(active, prior)
    point(previous, old)
    console.log('Restored ' + prior)
  } else {
    if (old && older(info.version, installedManifest(old).manifest.version))
      throw new Error('Use --rollback to restore an older release')
    if (!existsSync(release)) {
      const staging = mkdtempSync(join(releases, '.stage-'))
      try {
        for (const rel of [...Object.keys(info.files), 'manifest.json', 'manifest.sig']) {
          const dest = join(staging, rel),
            src = join(source, rel)
          mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
          copyFileSync(src, dest)
          chmodSync(dest, lstatSync(src).mode & 0o755)
        }
        verifyContents(staging)
        renameSync(staging, release)
      } finally {
        rmSync(staging, { force: true, recursive: true })
      }
    } else verifyContents(release)
    const target = 'releases/' + releaseName
    if (info.component === 'host') {
      const bin = join(homedir(), '.local/bin')
      mkdirSync(bin, { recursive: true })
      const wrapper = join(bin, 'godbot-computer')
      const launch = readFileSync(join(release, 'bin/godbot-computer'))
      if (
        existsSync(wrapper) &&
        (!lstatSync(wrapper).isFile() ||
          !readFileSync(wrapper, 'utf8').includes('# NativeCrew Computer Host launcher'))
      ) {
        throw new Error('A different program exists at ' + wrapper)
      }
      const temp = wrapper + '.' + randomUUID()
      writeFileSync(temp, launch, { mode: 0o755, flag: 'wx' })
      renameSync(temp, wrapper)
    }
    if (info.component === 'desktop' && process.platform === 'darwin') addMacApplicationShortcut()
    if (old && old !== target) point(previous, old)
    point(active, target)
    console.log('Installed ' + release)
  }
} finally {
  rmSync(lock, { recursive: true, force: true })
}

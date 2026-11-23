import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repository = fileURLToPath(new URL('../../', import.meta.url))
export const sha256 = data => createHash('sha256').update(data).digest('hex')

// A /plugins/?? response can contain many packages. Hash each complete NativeCrew registration exactly as delivered.
const packageNames = ['@dsh-plugins/nativecrew', 'dsh-godbot']

export function clientRegistrations(source, names = packageNames) {
  const end = '\nreturn Object.defineProperty({ ...module.exports }, Symbol.toStringTag, { value: "Module" });\n} });'
  const hashes = []
  for (const name of names) {
    const start = 'window.__ModuleLoader__.load({ id: "' + name + '", factory(require) {'
    let offset = 0
    for (let i; (i = source.indexOf(start, offset)) >= 0;) {
      const j = source.indexOf(end, i + start.length)
      if (j < 0) throw new Error('Incomplete browser registration for ' + name)
      offset = j + end.length
      hashes.push(sha256(source.slice(i, offset)))
    }
  }
  return hashes
}

export async function inspectArchive(file) {
  const path = resolve(file)
  const member = name => execFileSync('tar', ['-xzOf', path, 'package/' + name], { encoding: 'utf8', maxBuffer: 32_000_000 })
  const pkg = JSON.parse(member('package.json'))
  if (!packageNames.includes(pkg.name)) throw new Error('Expected a NativeCrew or legacy Godbot archive')
  const buildId = member('src/host/build-id.js').match(/buildId\s*=\s*["']([a-f0-9]+)["']/u)?.[1]
  if (!buildId) throw new Error('No Host build ID in ' + path)
  const registrations = clientRegistrations(member('client.js'), [pkg.name])
  if (registrations.length !== 1) throw new Error('Expected one browser registration in ' + path)
  return { path, pkg, version: pkg.version, buildId, clientSha256: registrations[0], sha256: sha256(await readFile(path)) }
}

async function pack(staging, destination) {
  const [entry] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', destination], { cwd: staging, encoding: 'utf8' }))
  const from = join(destination, entry.filename)
  const content = await inspectArchive(from)
  const path = join(destination, content.sha256 + '.tgz')
  await rename(from, path)
  return { ...content, path }
}

export async function buildArchive(destination, revision) {
  const staging = await mkdtemp(join(destination, 'build-'))
  if (revision) {
    const files = execFileSync('git', ['archive', '--format=tar', revision], { cwd: repository, maxBuffer: 50_000_000 })
    execFileSync('tar', ['-xf', '-', '-C', staging], { input: files })
    // Exercise the exact client bundle and Host build ID committed for the supported release.
    return pack(staging, destination)
  }
  // Include current worktree edits and new application files without writing generated files into it.
  const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'))
  const paths = new Set(['src', 'scripts', 'package.json', 'package-lock.json', ...(pkg.files ?? []), ...Object.values(pkg.bin ?? {})])
  for (const name of paths) {
    await cp(join(repository, name), join(staging, name), { recursive: true, force: true })
  }
  await symlink(join(repository, 'node_modules'), join(staging, 'node_modules'), 'dir')
  execFileSync(process.execPath, ['scripts/build-client.mjs'], { cwd: staging, timeout: 60_000 })
  return pack(staging, destination)
}

export async function brokenArchive(candidate, scratch) {
  const staging = await mkdtemp(join(scratch, 'invalid-host-'))
  execFileSync('tar', ['-xzf', candidate.path, '--strip-components', '1', '-C', staging])
  const marker = 'E12_INJECTED_HOST_FAILURE'
  await writeFile(join(staging, 'src/host/plugin.js'), 'throw new Error(' + JSON.stringify(marker) + ')\n')
  const pkg = await pack(staging, scratch)
  return { pkg, marker }
}

// The candidate's own files under another version: a release an installed
// candidate can update to, built for the same DSH and peers. With `trap`, its Host
// refuses to load while the file the GODBOT_E2E_RELOAD_TRAP variable names exists,
// the way a release fails to import into a DSH that resolved its dependencies at
// their old paths: a case can tell whether the update loaded into the process
// that installed it.
export async function bumpedArchive(candidate, scratch, version, { trap = false } = {}) {
  const staging = await mkdtemp(join(scratch, 'bumped-'))
  execFileSync('tar', ['-xzf', candidate.path, '--strip-components', '1', '-C', staging])
  const manifest = join(staging, 'package.json')
  await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, 'utf8')), version }, null, 2) + '\n')
  const buildId = sha256([candidate.buildId, version].join(':')).slice(0, 16)
  await writeFile(join(staging, 'src/host/build-id.js'), 'export const buildId = ' + JSON.stringify(buildId) + '\n')
  if (trap) {
    const entry = join(staging, 'src/host/plugin.js')
    await writeFile(entry, "import { existsSync as reloadTrapSet } from 'node:fs'\n"
      + "if (process.env.GODBOT_E2E_RELOAD_TRAP && reloadTrapSet(process.env.GODBOT_E2E_RELOAD_TRAP)) throw new Error('GODBOT_E2E_RELOAD_TRAP: the update was loaded into the DSH that installed it')\n"
      + await readFile(entry, 'utf8'))
  }
  return pack(staging, scratch)
}

export async function saveEvidence(dir, filename, data) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, filename), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

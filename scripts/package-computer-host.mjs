// Build independently signed, standalone machine-host and graphical add-on archives.
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, sign } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = parseArgs({
  options: {
    out: { type: 'string' },
    target: { type: 'string' },
    'signing-key': { type: 'string' },
    'mac-app': { type: 'string' },
  },
}).values
if (!args.out || !args['signing-key'])
  throw new Error('Specify --out DIRECTORY and --signing-key PUBLISHER_PRIVATE_PEM')
const targets = {
  'darwin-arm64': 'a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3',
  'linux-arm64': 'f44740cd218de8127f1c44c41510a3a740fa5c9c8d1cdce1c3bedada79f3cde7',
  'linux-x64': 'dbf5b8665dec15e59e6359a517fefb47b23fdb9152d8def975b9bca3dfc6d355',
}
const target = args.target || process.platform + '-' + process.arch
if (!Object.hasOwn(targets, target)) throw Error('Supported targets: ' + Object.keys(targets).join(', '))
const [platform, arch] = target.split('-')
const env = {
  ...process.env,
  CGO_ENABLED: '0',
  GOOS: platform,
  GOARCH: arch === 'x64' ? 'amd64' : arch,
  COPYFILE_DISABLE: '1',
}
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const key = readFileSync(args['signing-key'])
const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' })
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
const version = '0.1.2',
  nodeVersion = '24.14.0'
const stage = mkdtempSync(join(tmpdir(), 'godbot-machine-package-'))
const run = (cmd, argv, cwd = root) =>
  execFileSync(cmd, argv, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
const cp = (src, dest) => {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}
const put = (dest, text, mode = 0o644) => {
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, text, { mode })
}
function copyLicenses(cwd, dest) {
  const goRoot = run('go', ['env', 'GOROOT']).trim()
  const source = [join(goRoot, 'LICENSE'), join(dirname(goRoot), 'LICENSE')].find(existsSync)
  if (!source) throw Error('Go standard library license was not found in this distribution')
  cp(source, join(dest, 'Go-LICENSE'))
  for (const line of run('go', ['list', '-m', '-f', '{{if not .Main}}{{.Path}}|{{.Dir}}{{end}}', 'all'], cwd)
    .split('\n')
    .filter(Boolean)) {
    const [name, dir] = line.split('|')
    if (!dir) continue
    for (const entry of readdirSync(dir).filter((n) => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(n))) {
      const dst = join(dest, ...name.split('/'), entry)
      mkdirSync(dirname(dst), { recursive: true })
      cpSync(join(dir, entry), dst, { recursive: true })
    }
  }
}
function entries(base, relative = '') {
  return readdirSync(join(base, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const path = join(relative, e.name)
      if (e.isDirectory()) return entries(base, path)
      if (!e.isFile()) throw Error('Unexpected file in archive: ' + path)
      return [path]
    })
}
const launch = [
  '#!/bin/sh',
  '# NativeCrew Computer Host launcher',
  'set -eu',
  'machine_root="$HOME/.local/share/godbot-computer"',
  'if [ -d "$machine_root/desktop-current/native" ] && [ -z "${GODBOT_DESKTOP_RUNTIME:-}" ]; then',
  '  export GODBOT_DESKTOP_RUNTIME="$machine_root/desktop-current/native"',
  'fi',
  'export GODBOT_MACHINE_LAUNCHER="$HOME/.local/bin/godbot-computer"',
  'exec "$machine_root/current/runtime/bin/node" "$machine_root/current/computer-host/cli.mjs" "$@"',
  '',
].join('\n')
function pack(component, prepare) {
  const name = 'godbot-computer-' + component + '-' + version + '-' + target
  const dir = join(stage, name)
  mkdirSync(dir)
  cp(join(root, 'computer-host/install.mjs'), join(dir, 'install.mjs'))
  cp(join(root, 'computer-host/README.md'), join(dir, 'README.md'))
  cp(join(root, 'LICENSE'), join(dir, 'LICENSE'))
  const node =
    component === 'host'
      ? '"$source/runtime/bin/node"'
      : '"$HOME/.local/share/godbot-computer/current/runtime/bin/node"'
  put(
    join(dir, 'install.sh'),
    '#!/bin/sh\nset -eu\nsource=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec ' +
      node +
      ' "$source/install.mjs" "$@"\n',
    0o755,
  )
  prepare(dir)
  const files = Object.fromEntries(entries(dir).map((file) => [file, hash(readFileSync(join(dir, file)))]))
  const manifest =
    JSON.stringify(
      { version, component, platform, arch, ...(component === 'host' && { nodeVersion }), files },
      null,
      2,
    ) + '\n'
  put(join(dir, 'manifest.json'), manifest)
  writeFileSync(join(dir, 'manifest.sig'), sign('sha256', Buffer.from(manifest), key))
  const tar = join(stage, name + '.tar.gz')
  run('tar', [
    ...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []),
    '-czf',
    tar,
    '-C',
    stage,
    name,
  ])
  const data = readFileSync(tar)
  writeFileSync(join(out, name + '.tar.gz.sig'), sign('sha256', data, key))
  put(join(out, name + '.tar.gz.sha256'), hash(data) + '  ' + basename(tar) + '\n')
  renameSync(tar, join(out, basename(tar)))
  console.log(join(out, basename(tar)))
}
try {
  pack('host', (dir) => {
    const cache = join(homedir(), '.cache/godbot-computer-host', 'node-v' + nodeVersion)
    mkdirSync(cache, { recursive: true })
    const archive = join(cache, target + '.tar.gz')
    const prefix = 'node-v' + nodeVersion + '-' + target
    if (!existsSync(archive)) {
      const part = join(stage, 'node-download.tar.gz')
      run('curl', [
        '-fsSL',
        '--retry',
        '2',
        'https://nodejs.org/dist/v' + nodeVersion + '/' + prefix + '.tar.gz',
        '-o',
        part,
      ])
      if (hash(readFileSync(part)) !== targets[target]) throw Error('Node runtime checksum mismatch')
      renameSync(part, archive)
    }
    if (hash(readFileSync(archive)) !== targets[target]) throw Error('Cached Node runtime checksum mismatch')
    mkdirSync(join(dir, 'runtime'))
    run('tar', [
      '-xzf',
      archive,
      '--strip-components=1',
      '-C',
      join(dir, 'runtime'),
      prefix + '/bin/node',
      prefix + '/LICENSE',
    ])
    put(join(dir, 'package.json'), JSON.stringify({ name: 'godbot-computer-host', type: 'module', version }))
    put(join(dir, 'bin/godbot-computer'), launch, 0o755)
    for (const entry of [
      'cli.mjs',
      'runtime.js',
      'local.js',
      'sessions.js',
      'portal-memory.js',
      'terminal.js',
      'consent.js',
      'service-install.js',
      'manage.js',
      'manage.html',
      'native/desktop.js',
    ]) {
      cp(join(root, 'computer-host', entry), join(dir, 'computer-host', entry))
    }
    for (const entry of [
      'src/host/team-runtime/mobile-link.js',
      'src/host/computer-input-lock.js',
      'THIRD_PARTY_NOTICES',
    ])
      cp(join(root, entry), join(dir, entry))
    cpSync(join(root, 'licenses'), join(dir, 'licenses'), { recursive: true })
    for (const entry of ['package.json', 'dist/qrcode.mjs'])
      cp(join(root, 'node_modules/qrcode-generator', entry), join(dir, 'node_modules/qrcode-generator', entry))
    mkdirSync(join(dir, 'computer-host/bin'), { recursive: true })
    const cwd = join(root, 'computer-host/pty-worker')
    run(
      'go',
      [
        'build',
        '-mod=readonly',
        '-trimpath',
        '-ldflags=-s -w',
        '-o',
        join(dir, 'computer-host/bin/godbot-pty'),
        '.',
      ],
      cwd,
    )
    copyLicenses(cwd, join(dir, 'licenses/pty'))
  })
  pack('desktop', (dir) => {
    const native = join(dir, 'native')
    mkdirSync(native)
    const cwd = join(root, 'computer-host/native/rtc')
    run(
      'go',
      ['build', '-mod=readonly', '-trimpath', '-ldflags=-s -w', '-o', join(native, 'godbot-desktop-rtc'), '.'],
      cwd,
    )
    copyLicenses(cwd, join(dir, 'licenses/rtc'))
    if (platform === 'darwin') {
      if (process.platform !== 'darwin') throw Error('Build the signed macOS add-on on a Mac')
      const app =
        args['mac-app'] ||
        join(homedir(), 'Library/Application Support/NativeCrew Computer Host/native/NativeCrew Computer Host.app')
      run('codesign', ['--verify', '--strict', '-R=identifier "io.github.renjiegod.godbot.computerhost"', app])
      const capture = join(app, 'Contents/MacOS/godbot-screen')
      run('lipo', ['-verify_arch', 'arm64', capture])
      const compiled = JSON.parse(run(capture, ['bridge-info']))
      const publisher = createPublicKey(key).export({ format: 'jwk' })
      if (publisher.kty !== 'EC' || publisher.crv !== 'P-256') throw new Error('The Mac host requires a P-256 package key')
      const encoded = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(publisher.x, 'base64url'),
        Buffer.from(publisher.y, 'base64url'),
      ])
      if (compiled.protocol !== 1 || compiled.publisherKeySha256 !== hash(encoded)) {
        throw new Error('Rebuild the Mac capture app with the public key for this host signing key')
      }
      cpSync(app, join(native, 'NativeCrew Computer Host.app'), { recursive: true })
      run('codesign', [
        '--verify',
        '--strict',
        '-R=identifier "io.github.renjiegod.godbot.computerhost"',
        join(native, 'NativeCrew Computer Host.app'),
      ])
    } else {
      cp(join(root, 'computer-host/native/linux/desktop.py'), join(native, 'godbot-screen'))
      chmodSync(join(native, 'godbot-screen'), 0o755)
    }
  })
  put(join(out, 'publisher.pem'), pub)
} finally {
  rmSync(stage, { recursive: true, force: true })
}

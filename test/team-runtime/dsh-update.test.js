import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { install } from '../../src/host/team-runtime/core/dsh-update.js'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
// The verified host release this package names; the offer is measured against it.
const VERIFIED = PKG.engines.dsh
// A registry that answers nothing, so a check never leaves the machine.
const DEAD_REGISTRY = 'http://127.0.0.1:1/'

// install(rt) with the DSH version the host reports, and a recorded npm spawn.
function harness(dsh) {
  const spawns = []
  const warnings = []
  const services = {
    loader: { async import() { return { getDshRuntimeVersion: () => dsh } }, unwrapExports: value => value },
    profileContext: {},
    pluginManager: { async listBundles() { return [{ name: PKG.name, source: PKG.version }] } },
  }
  const rt = {
    ctx: { get: name => services[name], effect() {} },
    config: { updateRegistry: DEAD_REGISTRY },
    warn: (...args) => warnings.push(args),
    dshSpawn: (command, args) => {
      spawns.push([command, args])
      return { stdout: null, stderr: null, once() {}, kill() {} }
    },
  }
  install(rt)
  return { rt, spawns, warnings }
}

test('a DSH newer than the verified one is never downgraded to make this plugin loadable', async () => {
  // The host moved ahead of what this Godbot was verified against.
  const { rt, spawns } = harness('9.9.9')
  const view = await rt.dshUpdateCheck({ fresh: true })
  assert.equal(view.current, '9.9.9')
  assert.equal(view.verified, VERIFIED)
  assert.equal(view.available, false, 'an older verified release is a downgrade, not an update')
  assert.throws(() => rt.dshUpdateStart(), /No DSH update is available|only upgrades/)
  assert.deepEqual(spawns, [], 'nothing may install a DSH older than the running one')
})

test('a DSH older than the verified one is still offered and installed', async () => {
  const { rt, spawns } = harness('0.0.1')
  const view = await rt.dshUpdateCheck({ fresh: true })
  assert.equal(view.current, '0.0.1')
  assert.equal(view.verified, VERIFIED)
  assert.equal(view.available, true)
  rt.dshUpdateStart()
  assert.deepEqual(spawns, [[process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '-g', `@deepseek-ai/dsh@${VERIFIED}`]]])
})

test('a host at the verified release has nothing to offer', async () => {
  const { rt, spawns } = harness(VERIFIED)
  const view = await rt.dshUpdateCheck({ fresh: true })
  assert.equal(view.available, false)
  assert.throws(() => rt.dshUpdateStart(), /No DSH update is available/)
  assert.deepEqual(spawns, [])
})

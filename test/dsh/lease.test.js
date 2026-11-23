import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Store } from '../../src/host/store.js'

const storeUrl = new URL('../../src/host/store.js', import.meta.url).href
const serviceUrl = new URL('../fixtures/member-service.js', import.meta.url).href

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'godbot-lease-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a second Host cannot enter recovery while the owner is running', t => {
  const dir = directory(t)
  const owner = new Store(dir)
  try {
    owner.put('members', { id: 'member', status: 'running', activeTurnId: 'turn' })
    owner.put('turns', { id: 'turn', status: 'running' })
    assert.throws(() => new Store(dir), { code: 'GODBOT_STATE_IN_USE' })
    const other = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { NativeCrewService } from ${JSON.stringify(serviceUrl)}
      try {
        const service = new NativeCrewService({ stateDir: process.argv[1] })
        await service.ready()
        await service.close()
        process.exitCode = 1
      } catch (error) {
        if (error.code !== 'GODBOT_STATE_IN_USE') throw error
      }
    `, dir], { encoding: 'utf8', timeout: 5000 })
    assert.equal(other.status, 0, other.stderr)
    assert.equal(owner.get('members', 'member').status, 'running')
    assert.equal(owner.get('turns', 'turn').status, 'running')
    assert.deepEqual(owner.all('events'), [])
  } finally {
    owner.close()
    owner.close()
  }
  const successor = new Store(dir)
  try { assert.equal(successor.get('turns', 'turn').status, 'running') } finally { successor.close() }
})

test('a live Store retains ownership across GC and process death releases it', { timeout: 10_000 }, async t => {
  const dir = directory(t)
  const owner = spawn(process.execPath, ['--expose-gc', '--input-type=module', '--eval', `
    import { Store } from ${JSON.stringify(storeUrl)}
    const store = new Store(process.argv[1])
    store.put('teams', { id: 'persisted' })
    // The live NativeCrewService holds its Store. An empty IPC listener would
    // keep only Node alive, letting GC finalize both SQLite connections.
    process.on('message', () => process.send(store.get('teams', 'persisted')))
    setImmediate(() => { global.gc(); process.send('ready') })
  `, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exit = once(owner, 'exit')
  try {
    await Promise.race([
      once(owner, 'message').then(([message]) => assert.equal(message, 'ready')),
      exit.then(() => { throw new Error('Owner exited before taking the lease') }),
    ])
    assert.throws(() => new Store(dir), { code: 'GODBOT_STATE_IN_USE' })
    const response = once(owner, 'message')
    owner.send('read')
    const [row] = await Promise.race([
      response,
      exit.then(() => { throw new Error('Owner exited before reading from its Store') }),
    ])
    assert.equal(row.id, 'persisted')
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
    await exit
  }
  const successor = new Store(dir)
  try { assert.equal(successor.get('teams', 'persisted').id, 'persisted') } finally { successor.close() }
})

test('failure opening the records database releases the Host lease', t => {
  const dir = directory(t)
  const badPath = join(dir, 'godbot.sqlite3')
  mkdirSync(badPath)
  assert.throws(() => new Store(dir))
  rmSync(badPath, { recursive: true })
  const recovered = new Store(dir)
  recovered.close()
})

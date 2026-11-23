import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { startComputerHost } from '../../computer-host/runtime.js'
import { localRequest } from '../../computer-host/local.js'
import { OutputWindow } from '../../computer-host/terminal.js'
import { MachineSessions } from '../../computer-host/sessions.js'
import { claimComputerInput } from '../../src/host/computer-input-lock.js'
import { startRelay } from '../e2e/phone-relay.mjs'
import {
  deviceIdFor,
  generateKeyPair,
  machinePairingUri,
  parseMachinePairingUri,
  parsePairingUri,
  randomToken,
  RelayTransport,
  SecureTransport,
  RpcClient,
} from '../../src/host/team-runtime/mobile-link.js'

async function isolatedInput(t) {
  const root = await mkdtemp(join(tmpdir(), 'godbot-input-private-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return (kind) => claimComputerInput(kind, root)
}

const b64 = (s) => Buffer.from(s).toString('base64')
function identity() {
  const keys = generateKeyPair()
  return { ...keys, deviceId: deviceIdFor(keys.publicKey), accessToken: randomToken() }
}
async function connect(offer, peer, code = offer.code) {
  const transport = new RelayTransport(offer.server, {
    deviceId: peer.deviceId,
    identityKey: peer.publicKey,
    accessToken: peer.accessToken,
    targetDeviceId: offer.hostDeviceId,
  })
  const client = new RpcClient(
    new SecureTransport(
      transport,
      peer,
      { deviceId: offer.hostDeviceId, identityKey: offer.hostKey },
      { hello: { name: 'Local test controller', ...(code ? { pairingCode: code } : {}) } },
    ),
    7000,
  )
  try {
    await client.connect()
    return client
  } catch (err) {
    await client.close()
    throw err
  }
}
async function eventually(probe) {
  const until = Date.now() + 5000
  let last
  do {
    try {
      return await probe()
    } catch (err) {
      last = err
    }
    await sleep(50)
  } while (Date.now() < until)
  throw last
}

test('machine offers stay isolated from team offers and enforce secure relay URLs', () => {
  const i = identity()
  const offer = {
    server: 'wss://example.test/v1/link',
    hostKey: i.publicKey,
    hostDeviceId: i.deviceId,
    name: 'Studio',
    code: 'sample',
  }
  assert.deepEqual(parseMachinePairingUri(machinePairingUri(offer)), offer)
  assert.throws(() => parsePairingUri(machinePairingUri(offer)))
  assert.throws(() => parseMachinePairingUri(machinePairingUri(offer).replace('computer-pair', 'pair')))
  assert.throws(() =>
    parseMachinePairingUri(machinePairingUri({ ...offer, server: 'ws://elsewhere.test/v1/link' })),
  )
})

test('a bounded transcript returns byte-aligned cursors and identifies missing output', () => {
  const window = new OutputWindow()
  const bytes = Buffer.alloc(300000)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 253
  window.append(bytes.subarray(0, 51))
  window.append(bytes.subarray(51))
  let cursor = 0
  const out = []
  while (cursor < bytes.length) {
    const data = window.read(cursor)
    assert.equal(Boolean(data.truncated), cursor === 0)
    out.push(Buffer.from(data.data, 'base64'))
    cursor = data.cursor
  }
  assert.deepEqual(Buffer.concat(out), bytes.subarray(-256 * 1024))
})

test('a desktop lease blocks competing Bot actions through the complete input lifetime', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'godbot-input-test-'))
  t.after(() => rm(home, { recursive: true }))
  const one = claimComputerInput('bot', home),
    two = claimComputerInput('bot', home)
  assert.throws(() => claimComputerInput('human', home), { code: 'BUSY' })
  one()
  assert.throws(() => claimComputerInput('human', home), { code: 'BUSY' })
  two()
  const human = claimComputerInput('human', home)
  assert.throws(() => claimComputerInput('bot', home), { code: 'BUSY' })
  human()
  claimComputerInput('bot', home)()
})

test('desktop RPC scopes signaling and closes a media peer on tunnel loss', async (t) => {
  const seen = []
  let nativeRevoke
  const desktop = {
    async probe() {
      return { available: true, control: true }
    },
    async displays() {
      return [{ id: 'A', name: 'Desk', width: 640, height: 480, revision: 1 }]
    },
    async start(opts) {
      nativeRevoke = opts.onControlRevoked
      return {
        async signal(m) {
          seen.push(m.type)
          opts.onSignal({ type: 'answer', sdp: 'test answer' })
        },
        async setControl(enabled) {
          seen.push(enabled)
        },
        async close() {
          seen.push('close')
        },
      }
    },
  }
  const host = new MachineSessions({
    claimInput: await isolatedInput(t),
    desktop,
    name: 'Lab host',
    audit() {},
    grants: () => ['desktop.view'],
  })
  t.after(() => host.stop())
  const peer = { deviceId: 'controller', tunnelId: 'one', signal: new AbortController().signal }
  const rpc = (method, params) => host.call(method, params, peer)
  const session = await rpc('session.open', { mode: 'desktop', requestId: 'unique' })
  const p = { sessionId: session.sessionId }
  assert.equal((await rpc('session.open', { mode: 'desktop', requestId: 'unique' })).sessionId, p.sessionId)
  await assert.rejects(host.call('session.status', p, { ...peer, tunnelId: 'other' }), {
    code: 'SESSION_NOT_FOUND',
  })
  await assert.rejects(rpc('terminal.open', p), { code: 'SCOPE_DENIED' })
  await rpc('desktop.signal', { ...p, generation: 1, displayId: 'A', signal: { type: 'offer', sdp: 'test' } })
  assert.deepEqual((await rpc('desktop.poll', { ...p, generation: 1, cursor: 0 })).signals, [
    { type: 'answer', sdp: 'test answer' },
  ])
  assert.equal((await rpc('desktop.requestControl', p)).controlPending, true)
  await host.decide(p.sessionId, true)
  await eventually(async () => assert.equal((await rpc('session.status', p)).control, true))
  nativeRevoke('Input permission removed')
  await eventually(async () => {
    assert.equal((await rpc('session.status', p)).control, false)
    assert.ok(seen.includes(false))
  })
  host.drop(peer.deviceId, peer.tunnelId)
  assert.deepEqual(seen, ['offer', true, false, 'close'])
})

test(
  'paired controllers use the real relay and PTY with strict scopes, approval, revoke and restart',
  {
    skip: !process.env.GODBOT_RELAY_BIN,
    timeout: 30000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'godbot-machine-test-'))
    const relay = await startRelay(directory, () => {})
    let host
    const clients = new Set()
    t.after(async () => {
      for (const c of clients) await c.close()
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true })
    })
    const opts = {
      claimInput: await isolatedInput(t),
      home: directory,
      relay: relay.url,
      headless: true,
      noPrompts: true,
      name: 'E2E Linux server',
    }
    host = await startComputerHost(opts)
    await host.link.waitOnline()
    const admin = (method, ...args) => localRequest(directory, method, args)
    const offer = async () => parseMachinePairingUri((await admin('pair')).uri)
    const a = identity(),
      b = identity(),
      offerA = await offer()
    const ca = await connect(offerA, a)
    clients.add(ca)
    await assert.rejects(connect(offerA, b))
    const cb = await connect(await offer(), b)
    clients.add(cb)
    const leaseToken = randomToken()
    await admin('manage-start', leaseToken)
    await assert.rejects(ca.rpc('session.open', { mode: 'desktop', requestId: 'private-manager' }), {
      code: 'LOCAL_MANAGEMENT_ACTIVE',
    })
    await admin('manage-end', leaseToken)
    await admin('pair')
    await assert.rejects(ca.rpc('session.open', { mode: 'desktop', requestId: 'private-offer' }), {
      code: 'LOCAL_MANAGEMENT_ACTIVE',
    })
    await admin('cancel-pair')
    const savedA = (await admin('controllers')).find((peer) => peer.deviceId === a.deviceId)
    assert.ok(savedA.lastSeen >= savedA.pairedAt)
    assert.equal((await ca.rpc('computer.hello', {})).desktop, false)
    await assert.rejects(ca.rpc('session.open', { mode: 'desktop', requestId: 'desk' }), {
      code: 'DESKTOP_UNAVAILABLE',
    })
    const s = await ca.rpc('session.open', { mode: 'terminal', requestId: 'pty' })
    const p = { sessionId: s.sessionId }
    assert.equal(s.state, 'pending')
    await assert.rejects(cb.rpc('session.status', p), { code: 'SESSION_NOT_FOUND' })
    await assert.rejects(ca.rpc('terminal.open', { ...p, cols: 80, rows: 24 }))
    await admin('approve', p.sessionId)
    await ca.rpc('terminal.open', { ...p, cols: 80, rows: 24 })
    await ca.rpc('terminal.resize', { ...p, cols: 101, rows: 33 })
    const wr = { ...p, seq: 1, data: b64("printf 'pty-marker-%s\\n' running; stty size\n") }
    assert.deepEqual(await ca.rpc('terminal.write', wr), { ack: 1 })
    assert.deepEqual(await ca.rpc('terminal.write', wr), { ack: 1 })
    await assert.rejects(ca.rpc('terminal.write', { ...wr, seq: 3 }), { code: 'INPUT_GAP' })
    let output = '',
      cursor = 0
    await eventually(async () => {
      await ca.rpc('session.renew', p)
      const r = await ca.rpc('terminal.read', { ...p, cursor, waitMs: 400 })
      cursor = r.cursor
      output += Buffer.from(r.data, 'base64').toString()
      assert.match(output, /pty-marker-running/)
      assert.match(output, /33 101/)
    })
    const marker = join(directory, 'test-job.pid')
    await ca.rpc('terminal.write', {
      ...p,
      seq: 2,
      data: b64('sh -c \'echo $$ > "' + marker + '"; exec sleep 60\'\n'),
    })
    const job = await eventually(async () => {
      const pid = Number(await readFile(marker, 'utf8'))
      assert.ok(pid > 1)
      return pid
    })
    await admin('revoke', a.deviceId)
    await eventually(async () => assert.throws(() => process.kill(job, 0), { code: 'ESRCH' }))
    await assert.rejects(ca.rpc('session.status', p))
    await assert.rejects(connect(offerA, a, null))
    await admin('grant', b.deviceId, 'terminal')
    const oldHost = host.deviceId
    await cb.close()
    await host.close()
    host = await startComputerHost(opts)
    await host.link.waitOnline()
    assert.equal(host.deviceId, oldHost)
    const restored = await connect(offerA, b, null)
    clients.add(restored)
    const next = await restored.rpc('session.open', { mode: 'terminal', requestId: 'after-restart' })
    assert.equal(next.state, 'approved')
    await restored.rpc('session.close', { sessionId: next.sessionId })
    assert.equal((await stat(join(directory, 'identity.json'))).mode & 0o777, 0o600)
  },
)

test(
  'configured STUN reaches the approved viewer and native desktop as a URL list',
  { skip: !process.env.GODBOT_RELAY_BIN, timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'godbot-stun-config-'))
    const relay = await startRelay(directory, () => {})
    let client, host, nativeServers
    t.after(async () => {
      await client?.close()
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
    })
    const stun = 'stun:localhost:3478'
    await writeFile(join(directory, 'network.json'), JSON.stringify({ stun }), { mode: 0o600 })
    const desktop = {
      probe: async () => ({ available: true }),
      displays: async () => [{ id: 'test-display', revision: 1 }],
      start: async ({ iceServers }) => {
        nativeServers = iceServers
        return { signal: async () => {}, close: async () => {} }
      },
    }
    host = await startComputerHost({ home: directory, relay: relay.url, desktop, noPrompts: true })
    const admin = (method, ...args) => localRequest(directory, method, args)
    const peer = identity()
    client = await connect(parseMachinePairingUri((await admin('pair')).uri), peer)
    await admin('grant', peer.deviceId, 'desktop.view')

    const session = await client.rpc('session.open', { mode: 'desktop', requestId: 'stun-desktop' })
    assert.equal(session.state, 'approved')
    assert.deepEqual(session.iceServers, [{ urls: [stun] }])
    await client.rpc('desktop.signal', {
      sessionId: session.sessionId,
      generation: 1,
      displayId: 'test-display',
      signal: { type: 'offer', sdp: 'test' },
    })
    assert.deepEqual(nativeServers, [{ urls: [stun] }])
  },
)

test(
  'Wayland opt-in is local, scope-gated and revoked with the paired controller',
  { skip: !process.env.GODBOT_RELAY_BIN, timeout: 10000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'godbot-portal-policy-'))
    const relay = await startRelay(directory, () => {})
    const context = { seat: 'seat0', backend: 'wayland', revision: 1 }
    let client, host, input
    t.after(async () => {
      await client?.close()
      await host?.close()
      await relay.close()
      await rm(directory, { recursive: true, force: true })
    })
    const desktop = {
      probe: async () => ({ available: true, control: true }),
      portalSupport: async () => ['desktop.view', 'desktop.control'],
      displays: async () => [{ id: 'portal', revision: 1 }],
      start: async ({ portalPolicy }) => {
        const view = portalPolicy.take('desktop.view', context)
        assert.deepEqual(view.request, { remember: true })
        view.replace({ token: 'test-view-capability', streamId: 'selected-monitor' })
        return {
          signal: async () => {},
          close: async () => {},
          async setControl(enabled) {
            if (enabled) input = portalPolicy.take('desktop.control', context)
          },
        }
      },
    }
    const opts = {
      home: directory,
      relay: relay.url,
      desktop,
      noPrompts: true,
      claimInput: await isolatedInput(t),
    }
    host = await startComputerHost(opts)
    await host.link.waitOnline()
    const admin = (method, ...args) => localRequest(directory, method, args)
    const peer = identity()
    client = await connect(parseMachinePairingUri((await admin('pair')).uri), peer)
    const id = peer.deviceId
    await assert.rejects(admin('remember-portal', id, 'desktop.view'), /corresponding NativeCrew desktop grant/)
    await admin('grant', id, 'desktop.control')
    await admin('remember-portal', id, 'desktop.view')
    await admin('remember-portal', id, 'desktop.control')
    assert.deepEqual((await admin('controllers'))[0].portalScopes, ['desktop.view', 'desktop.control'])
    assert.deepEqual((await client.rpc('computer.hello', {})).portalScopes, undefined)
    const s = await client.rpc('session.open', { mode: 'desktop', requestId: 'test portal' })
    const p = { sessionId: s.sessionId }
    assert.equal(s.state, 'approved')
    await assert.rejects(client.rpc('forget-portal', p), { code: 'SCOPE_DENIED' })
    await client.rpc('desktop.signal', { ...p, displayId: 'portal', generation: 1, signal: { type: 'offer', sdp: 'test' } })
    await client.rpc('desktop.requestControl', p)
    await eventually(async () => assert.equal((await client.rpc('session.status', p)).control, true))
    assert.deepEqual(input.request, { remember: true })
    const identityPath = join(directory, 'identity.json')
    const policy = async () => JSON.parse(await readFile(identityPath, 'utf8')).portalMemory?.[id]
    assert.equal((await policy())['desktop.view'].saved.token, 'test-view-capability')
    assert.equal(JSON.stringify(await admin('controllers')).includes('test-view-capability'), false)
    assert.equal(JSON.stringify(await client.rpc('session.status', p)).includes('test-view-capability'), false)
    await admin('ungrant', id, 'desktop.control')
    input.replace({ token: 'late-test-control-capability', streamId: 'selected-monitor' })
    assert.equal((await policy())['desktop.control'], undefined)
    assert.equal((await client.rpc('session.status', p)).state, 'approved')
    assert.equal((await client.rpc('session.status', p)).control, false)
    await client.close()
    client = undefined
    await host.close()
    host = await startComputerHost(opts)
    await host.link.waitOnline()
    assert.deepEqual((await admin('controllers'))[0].portalScopes, ['desktop.view'])
    await host.close()
    // Prior hosts atomically replace the identity file and preserve unknown
    // keys. Even a byte-identical legacy rewrite must discard portal consent.
    const legacyPath = identityPath + '.legacy'
    await writeFile(legacyPath, await readFile(identityPath), { mode: 0o600, flag: 'wx' })
    await rename(legacyPath, identityPath)
    host = await startComputerHost(opts)
    await host.link.waitOnline()
    const controller = (await admin('controllers'))[0]
    assert.equal(controller.deviceId, id)
    assert.deepEqual(controller.grants, ['desktop.view'])
    assert.deepEqual(controller.portalScopes, [])
    await admin('revoke', id)
    assert.equal(await policy(), undefined)
  },
)

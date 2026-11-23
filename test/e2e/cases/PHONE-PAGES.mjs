// PHONE-PAGES: every page of the NativeCrew phone app, over the end-to-end encrypted link through a
// godbot-server relay: one read and one write per page, each write checked on the computer.
import assert from 'node:assert/strict'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { saveEvidence } from '../artifacts.mjs'
import { until } from '../host.mjs'
import { checkPages } from '../phone-pages.mjs'
import { startRelay } from '../phone-relay.mjs'
import { RelayTransport, RpcClient, SecureTransport, deviceIdFor, generateKeyPair, parsePairingUri, randomToken } from '../../../src/host/team-runtime/mobile-link.js'

async function channel(host, endpoint, payload = null) {
  const res = await host.page.context().request.post(host.url + '/api/godbot/team', {
    data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 30_000,
  })
  assert.ok(res.ok(), 'team channel ' + endpoint + ' returned HTTP ' + res.status())
  const result = await res.json()
  if (!result.ok) throw Object.assign(new Error(endpoint + ': ' + result.error?.message), { code: result.error?.code })
  return result.value
}

export default async function check({ makeHost, candidate, reportDir, scratch, note }) {
  const relay = await startRelay(scratch, note)
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set', {})).status === 'online', 'NativeCrew online at the relay', 30_000)
    const offer = parsePairingUri((await channel(host, 'phone-pair')).pairing.uri)
    const keys = generateKeyPair()
    const phone = { deviceId: deviceIdFor(keys.publicKey), ...keys, accessToken: randomToken() }
    const open = async code => {
      const transport = new RelayTransport(offer.server, { deviceId: phone.deviceId, identityKey: phone.publicKey, accessToken: phone.accessToken, targetDeviceId: offer.hostDeviceId })
      const secure = new SecureTransport(transport, phone, { deviceId: offer.hostDeviceId, identityKey: offer.hostKey }, { hello: { name: 'Pages phone', ...(code ? { pairingCode: code } : {}) } })
      const client = new RpcClient(secure)
      await client.connect()
      return client
    }
    await (await open(offer.code)).close()
    const client = await open()
    const bot = async (endpoint, payload = {}) => {
      const result = await client.rpc('bot', { endpoint, payload })
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
      return result.value
    }
    const folder = join(host.root, 'phone-folder')
    await mkdir(folder, { recursive: true })
    const results = await checkPages({ bot, channel: (endpoint, payload) => channel(host, endpoint, payload), folder: await realpath(folder), note })
    await client.close()
    await saveEvidence(reportDir, 'pages.json', results)
    const failed = results.filter(row => !row.ok)
    assert.deepEqual(failed, [], 'pages that failed: ' + JSON.stringify(failed, null, 2))
  } finally {
    await relay.close()
  }
}

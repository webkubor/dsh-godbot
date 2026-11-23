// A long-running real NativeCrew for phone app tests: an isolated DSH Web with the packaged plugin,
// a godbot-server relay (with fake FCM), phone access on, and a small control API so a UI test
// can check on the computer what the phone did. Stop it with Ctrl-C.
//
//   GODBOT_RELAY_BIN=<godbot-relay> node test/e2e/phone-host.mjs [--artifact <tgz>] [--control-port <port>]
//
// Prints `RELAY <ws url>`, `CONTROL <http url>` and `PAIRING <godbot://pair?…>`. Control API (JSON):
//   POST /pair                      a fresh pairing link        → {uri}
//   POST /channel {endpoint, payload} the team channel, as the window calls it → its value
//   POST /reply {text}              what the fixture model answers from now on
//   GET  /info                      {relay, pairing}
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildArchive, inspectArchive } from './artifacts.mjs'
import { createHost, openBrowser, until } from './host.mjs'
import { startRelay } from './phone-relay.mjs'

const { values } = parseArgs({ options: { artifact: { type: 'string' }, 'control-port': { type: 'string' } } })
const scratch = await mkdtemp(join(tmpdir(), 'godbot-phone-host-'))
const reportDir = join(scratch, 'report')
await mkdir(reportDir, { recursive: true })
const note = (event, detail) => console.error(`[note] ${event} ${JSON.stringify(detail ?? {})}`)

const candidate = values.artifact ? await inspectArchive(values.artifact) : await buildArchive(scratch)
const { browser } = await openBrowser()
const relay = await startRelay(scratch, note)
const host = await createHost({ scratch, browser, reportDir, note })
await host.install(candidate)
await host.start()

async function channel(endpoint, payload = null) {
  const res = await host.page.context().request.post(host.url + '/api/godbot/team', {
    data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 30_000,
  })
  const result = await res.json()
  if (!result.ok) throw Object.assign(new Error(result.error?.message ?? 'request failed'), { code: result.error?.code })
  return result.value
}

await channel('phone-set', { server: relay.url, on: true })
await until(async () => (await channel('phone-set', {})).status === 'online', 'NativeCrew online at the relay', 30_000)
let pairing = (await channel('phone-pair')).pairing.uri
let reply = 'Fixture acknowledged'
host.model.reply = () => reply

const control = createServer((req, res) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', chunk => { body += chunk })
  req.on('end', async () => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      const input = body ? JSON.parse(body) : {}
      if (req.method === 'GET' && req.url === '/info') return send(200, { relay: relay.url, pairing })
      if (req.method === 'POST' && req.url === '/pair') {
        pairing = (await channel('phone-pair')).pairing.uri
        return send(200, { uri: pairing })
      }
      if (req.method === 'POST' && req.url === '/channel') return send(200, { ok: true, value: await channel(input.endpoint, input.payload ?? null) })
      if (req.method === 'POST' && req.url === '/reply') {
        reply = String(input.text ?? reply)
        return send(200, { ok: true })
      }
      send(404, { ok: false, error: 'unknown route' })
    } catch (error) {
      send(200, { ok: false, error: error.message, code: error.code })
    }
  })
})
await new Promise(resolve => control.listen(Number(values['control-port'] ?? 0), '127.0.0.1', resolve))
console.log(`RELAY ${relay.url}`)
console.log(`CONTROL http://127.0.0.1:${control.address().port}`)
console.log(`PAIRING ${pairing}`)

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  control.close()
  await host.close().catch(() => {})
  await relay.close().catch(() => {})
  await browser.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

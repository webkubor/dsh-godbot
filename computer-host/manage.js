// Local, short-lived settings window. The remote protocol never routes these operations.
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { localRequest } from './local.js'

const token = () => randomBytes(32).toString('base64url')
function matches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const actions = new Set([
  'status',
  'controllers',
  'sessions',
  'pair',
  'cancel-pair',
  'grant',
  'ungrant',
  'remember-portal',
  'forget-portal',
  'revoke',
  'stop',
  'approve',
  'deny',
])
export async function createManagementWindow(directory) {
  const lease = token(),
    windowKey = token(),
    nonce = token()
  let initial = token(),
    last = Date.now(),
    closed = false,
    authenticated = false
  let origin
  const page = (await readFile(new URL('./manage.html', import.meta.url), 'utf8')).replaceAll(
    '__NONCE__',
    nonce,
  )
  await localRequest(directory, 'manage-start', [lease])
  const http = createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'nonce-" +
        nonce +
        "'; script-src 'nonce-" +
        nonce +
        "'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    if (closed || req.headers.host !== new URL(origin).host) {
      send(403, {})
      return
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    if (
      req.method !== 'POST' ||
      req.url !== '/action' ||
      req.headers.origin !== origin ||
      req.headers['content-type'] !== 'application/json'
    ) {
      send(403, {})
      return
    }
    try {
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (Buffer.byteLength(raw) > 2048) {
          send(413, {})
          return
        }
      }
      const { action, args = [], key } = JSON.parse(raw)
      if (action === 'enter') {
        if (!initial || !matches(initial, key)) {
          send(403, {})
          return
        }
        initial = null
        authenticated = true
        last = Date.now()
        await localRequest(directory, 'manage-start', [lease])
        send(200, { windowKey })
        return
      }
      if (!authenticated || !matches(req.headers['x-godbot-window'], windowKey)) {
        send(403, {})
        return
      }
      if (
        !Array.isArray(args) ||
        args.length > 2 ||
        args.some((a) => typeof a !== 'string' || a.length > 128)
      ) {
        send(400, {})
        return
      }
      last = Date.now()
      if (action === 'exit') {
        send(200, { ok: true })
        void close()
        return
      }
      if (action === 'heartbeat') {
        await localRequest(directory, 'manage-start', [lease])
        send(200, { ok: true })
        return
      }
      if (!actions.has(action)) {
        send(400, {})
        return
      }
      // The browser blanks this trusted window before releasing protection to approve a session.
      if (action === 'approve') {
        authenticated = false
        try {
          await localRequest(directory, 'manage-end', [lease])
          send(200, await localRequest(directory, action, args))
        } finally {
          void close()
        }
        return
      }
      await localRequest(directory, 'manage-start', [lease])
      const result = await localRequest(directory, action, args)
      if (action === 'pair') {
        const { default: qrcode } = await import('qrcode-generator')
        const qr = qrcode(0, 'M')
        qr.addData(result.uri)
        qr.make()
        send(200, { ...result, qr: qr.createDataURL(5, 8) })
      } else send(200, result)
    } catch (e) {
      send(400, { error: e.message })
    }
  })
  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', resolve)
  })
  origin = 'http://127.0.0.1:' + http.address().port
  const timer = setInterval(() => {
    if (Date.now() - last > (authenticated ? 5200 : 20000)) void close()
  }, 500)
  // Retain protection while the local browser is opening.
  const opening = setInterval(() => {
    if (!authenticated && !closed) void localRequest(directory, 'manage-start', [lease]).catch(() => close())
  }, 1500)
  async function close() {
    if (closed) return
    closed = true
    clearInterval(timer)
    clearInterval(opening)
    http.close()
    http.closeAllConnections()
    await localRequest(directory, 'manage-end', [lease]).catch(() => {})
  }
  return { url: origin + '/#' + initial, close }
}

export async function openManagementWindow(directory) {
  const win = await createManagementWindow(directory)
  const launcher = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open'
  const child = spawn(launcher, [win.url], { stdio: 'ignore' })
  child.once('error', () => {
    console.error('Could not open local computer settings')
    void win.close()
  })
  child.once('exit', (code) => {
    if (code) void win.close()
  })
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => void win.close())
  console.log('Opened local NativeCrew Computer Host settings. Remote sharing is paused while settings are active.')
}

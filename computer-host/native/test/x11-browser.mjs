// Run with x11-run.sh on an isolated test seat. Chrome receives the actual
// helper's VP8 track and sends pointer/key/text events over DTLS/SCTP.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createDesktopAdapter, nativeRuntimePath } from '../desktop.js'
const WebSocket = createRequire(import.meta.url)('ws')
const work = process.env.GODBOT_DESKTOP_TEST_DIR
const wayland = Boolean(process.env.GODBOT_DESKTOP_TEST_WAYLAND)
const rtcProfile = join(work, 'chrome')
const chrome = spawn(
  'chromium',
  [
    '--no-sandbox',
    '--headless',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    '--user-data-dir=' + rtcProfile,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
let ws, session
async function until(fn, limit = 15000) {
  const end = Date.now() + limit
  let last
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    if (Date.now() > end) throw last || new Error('Condition timed out')
    await delay(100)
  }
}
try {
  if (!wayland) {
    const tools = join(work, 'tools')
    await mkdir(tools, { recursive: true })
    const shim = join(tools, 'xdotool')
    await writeFile(
      shim,
      '#!/bin/sh\nif [ "$1" = type ] && [ -e "$GODBOT_DESKTOP_TEST_DIR/input-disabled" ]; then exit 1; fi\nexec /usr/bin/xdotool "$@"\n',
    )
    await chmod(shim, 0o755)
    process.env.PATH = tools + ':' + process.env.PATH
  }
  const adapter = createDesktopAdapter()
  const probe = await adapter.probe()
  assert.equal(probe.available, true, JSON.stringify(probe))
  assert.equal(probe.control, true, JSON.stringify(probe))
  const display = (await adapter.displays())[0]
  if (wayland) assert.equal(display.id, 'portal')
  else assert.ok(display.width > 0 && display.height > 0)
  const staleStart = execFileSync(
    join(nativeRuntimePath(), 'godbot-screen'),
    ['stream', display.id, '640', '480', 'Geometry validation', String((display.revision + 1) >>> 0)],
    { encoding: 'utf8' },
  )
  assert.match(JSON.parse(staleStart).reason, /geometry changed before sharing/i)
  let nativeEnded = '',
    inputRevoked = ''
  const local = []
  session = await adapter.start({
    sessionId: 'e2e',
    controllerName: 'Local validation',
    displayId: display.id,
    iceServers: [],
    onSignal: (s) => local.push(s),
    onEnded: (s) => {
      nativeEnded = s
    },
    onControlRevoked: (s) => {
      inputRevoked = s
    },
  })
  const port = await until(
    async () => (await readFile(join(rtcProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0],
  )
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  let id = 0
  const calls = new Map()
  ws.on('message', (data) => {
    const packet = JSON.parse(data)
    const next = calls.get(packet.id)
    if (next) {
      calls.delete(packet.id)
      if (packet.error) next.reject(Error(packet.error.message))
      else next.resolve(packet.result)
    }
  })
  function evalPage(expression) {
    return new Promise((resolve, reject) => {
      const n = ++id
      calls.set(n, {
        resolve: (result) => {
          if (result.exceptionDetails)
            reject(Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text))
          else resolve(result.result.value)
        },
        reject,
      })
      ws.send(
        JSON.stringify({
          id: n,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      )
    })
  }
  const offer = await evalPage(`(async()=>{
    window.pc=new RTCPeerConnection();window.channel=pc.createDataChannel('godbot-input-v1');
    window.video=document.createElement('video');video.autoplay=true;video.muted=true;document.body.append(video);
    pc.ontrack=e=>{video.srcObject=new MediaStream([e.track]);video.play()};
    pc.addTransceiver('video',{direction:'recvonly'});
    const done=new Promise(r=>pc.addEventListener('icecandidate',e=>{if(!e.candidate)r()}));
    await pc.setLocalDescription(await pc.createOffer());await done;return pc.localDescription.toJSON()
  })()`)
  await session.signal(offer)
  const answer = await until(() => local.find((s) => s.type === 'answer'))
  await evalPage('pc.setRemoteDescription(' + JSON.stringify(answer) + ')')
  const seen = new Set()
  await until(async () => {
    for (const s of local) {
      if (s.type === 'candidate' && !seen.has(s)) {
        seen.add(s)
        await evalPage('pc.addIceCandidate(' + JSON.stringify(s.candidate) + ')')
      }
    }
    return evalPage("channel.readyState==='open' && video.videoWidth>0 && video.readyState>=2")
  }).catch(async (error) => {
    console.error(
      'Media state',
      await evalPage(
        "(async()=>({ice:pc.iceConnectionState,channel:channel.readyState,video:[video.readyState,video.videoWidth],rtp:[...(await pc.getStats()).values()].filter(r=>r.type==='inbound-rtp').map(r=>({packets:r.packetsReceived,frames:r.framesDecoded}))}))()",
      ),
      nativeEnded,
    )
    throw error
  })
  const media = await evalPage(
    `(async()=>{const reports=[...(await pc.getStats()).values()];const stream=reports.find(s=>s.type==='inbound-rtp'&&s.kind==='video');return {width:video.videoWidth,height:video.videoHeight,frames:stream.framesDecoded,codec:reports.find(r=>r.id===stream.codecId).mimeType}})()`,
  )
  assert.ok(media.frames > 0)
  assert.equal(media.codec.toLowerCase(), 'video/vp8')
  console.log('Decoded native ' + (wayland ? 'Wayland' : 'X11') + ' video', media)
  const [px, py] = (await readFile(join(work, 'point'), 'utf8')).split(' ').map(Number)
  const x = wayland ? 0.5 : px / display.width,
    y = wayland ? 0.65 : py / display.height
  const emit = (e) =>
    evalPage(
      'channel.send(' +
        JSON.stringify(
          JSON.stringify({ ...e, displayId: display.id, revision: e.revision ?? display.revision }),
        ) +
        ')',
    )
  const receipt = async () => readFile(join(work, 'receipt'), 'utf8').catch(() => '')
  await emit({ type: 'text', text: 'forbidden' })
  await delay(300)
  assert.equal(await receipt(), '')
  await session.setControl(true)
  await emit({ type: 'button', button: 0, down: true, x, y })
  await emit({ type: 'button', button: 0, down: false, x, y })
  if (!wayland)
    await until(
      () =>
        execFileSync('xdotool', ['getactivewindow', 'getwindowname'], { encoding: 'utf8' }).trim() ===
        'NativeCrew E2E target',
    )
  await emit({ type: 'text', text: 'verified', revision: display.revision - 1 })
  await delay(200)
  assert.equal(await receipt(), '')
  await emit({ type: 'text', text: 'NativeCrew中' })
  await emit({ type: 'key', code: 'KeyX', down: true })
  await emit({ type: 'key', code: 'KeyX', down: false })
  await until(async () => (await receipt()) === 'NativeCrew中x')
  await session.setControl(false)
  await emit({ type: 'text', text: 'blocked' })
  await delay(250)
  assert.equal(await receipt(), 'NativeCrew中x')
  console.log('Real GTK receipt confirmed; view-only, stale revision and released control rejected')
  if (!wayland) {
    await session.setControl(true)
    await writeFile(join(work, 'input-disabled'), '1')
    await emit({ type: 'text', text: 'unavailable' })
    await until(() => inputRevoked)
    await emit({ type: 'key', code: 'KeyY', down: true })
    await emit({ type: 'key', code: 'KeyY', down: false })
    const frameCount = () =>
      evalPage(
        "(async()=>[...(await pc.getStats()).values()].find(s=>s.type==='inbound-rtp'&&s.kind==='video').framesDecoded)()",
      )
    const before = await frameCount()
    await until(async () => (await frameCount()) > before)
    assert.equal(await receipt(), 'NativeCrew中x')
    assert.equal(nativeEnded, '')
    console.log('Input process failure revoked control, released input and preserved decoded video')
  }
  execFileSync('mate-screensaver-command', ['--activate'])
  await until(() => nativeEnded)
  console.log('Target stop reason:', nativeEnded)
  assert.match(nativeEnded, /locked|changed/i)
} finally {
  session?.close()
  ws?.close()
  chrome.kill()
}

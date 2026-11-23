// Exercise an installed dsh web against the disposable NativeCrew Linux GTK display.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openBrowser, until } from './host.mjs'
import { clientRegistrations } from './artifacts.mjs'

const dir = process.env.GODBOT_MACHINE_VALIDATION_DIR
if (!dir) throw new Error('Set GODBOT_MACHINE_VALIDATION_DIR to the private validation environment')
const kind = process.argv[2] || 'direct'
const minutes = Number(process.argv[3] || 0)
const secondSeat = process.env.GODBOT_TEST_DESKTOP_FIXTURE === 'android'
const stage = secondSeat ? 'godbot-android-frame-x11' : 'godbot-remote-x11'
const fixtureName = secondSeat ? 'Android first-frame validation' : 'Linux desktop validation'
const fixtureDir = secondSeat ? 'android-frame-x11' : 'x11'
const run = (args) =>
  execFileSync('docker', ['exec', '--user', 'godbotqa', stage, ...args], { encoding: 'utf8' }).trim()
const targetCLI = secondSeat
  ? '/home/godbotqa/final-archives/godbot-computer-host-0.1.0-linux-arm64/bin/godbot-computer'
  : '/home/godbotqa/.local/bin/godbot-computer'
const manage = (cmd, ...args) => JSON.parse(run([targetCLI, cmd, ...args]))
const evidence = {
  route: kind,
  soakMinutes: minutes,
  samples: [],
  rttMs: [],
  fps: [],
  bitrate: [],
  frameDrops: [],
  startedAt: new Date().toISOString(),
}
const isolatedProfile = process.env.GODBOT_TEST_DESKTOP_STORAGE
const coldTrial = Number(process.env.GODBOT_TEST_COLD_TRIAL || 0)
const variant =
  coldTrial > 0 && Number.isSafeInteger(coldTrial)
    ? 'cold-' + coldTrial
    : isolatedProfile
      ? 'signed-soak'
      : process.env.GODBOT_TEST_FINAL_DESKTOP
        ? 'installed'
        : ''
const proofName = 'web-desktop-' + kind + (variant ? '-' + variant : '')
const filename = join(dir, proofName + '.json')
const save = () => writeFile(filename, JSON.stringify(evidence, null, 2), { mode: 0o600 })
const { browser } = await openBrowser()
let receipt, panel, page
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(isolatedProfile && { storageState: isolatedProfile }),
  })
  page = await ctx.newPage()
  page.setDefaultTimeout(18000)
  await page.addInitScript((injectInitialFailure) => {
    window.testInputCount = 0
    window.testPeerEvents = []
    const send = RTCDataChannel.prototype.send
    RTCDataChannel.prototype.send = function (data) {
      if (this.label === 'godbot-input-v1') window.testInputCount++
      return send.call(this, data)
    }
    const RTC = window.RTCPeerConnection
    window.RTCPeerConnection = class extends RTC {
      get connectionState() {
        return this.testInitialState || super.connectionState
      }
      async setRemoteDescription(description) {
        await super.setRemoteDescription(description)
        if (!injectInitialFailure || window.testInitialFailureInjected || description.type !== 'answer') return
        window.testInitialFailureInjected = true
        for (const state of ['failed', 'connecting']) {
          this.testInitialState = state
          this.dispatchEvent(new Event('connectionstatechange'))
        }
        this.testInitialState = undefined
      }
      constructor(...args) {
        super(...args)
        window.machineTestPeer = this
        const config = this.getConfiguration()
        const note = (event, values) => {
          if (window.testPeerEvents.length < 160)
            window.testPeerEvents.push({ t: Math.round(performance.now()), event, ...values })
        }
        note('created', { policy: config.iceTransportPolicy, servers: config.iceServers?.length || 0 })
        for (const [event, key] of [
          ['iceconnectionstatechange', 'iceConnectionState'],
          ['connectionstatechange', 'connectionState'],
          ['signalingstatechange', 'signalingState'],
        ]) {
          this.addEventListener(event, () => note(event, { state: this[key] }))
        }
        this.addEventListener('icecandidateerror', (e) => note('candidate-error', { code: e.errorCode }))
        this.addEventListener('icecandidate', (e) =>
          note('candidate', { type: e.candidate?.type, protocol: e.candidate?.protocol }),
        )
        this.addEventListener('track', () => note('track', {}))
      }
    }
  }, process.env.GODBOT_TEST_TRANSIENT_ICE === '1')
  const source = JSON.parse(await readFile(join(dir, 'web-candidate/candidate.json'), 'utf8'))
  const registrations = []
  page.on('response', (res) => {
    if (res.ok() && res.url().includes('/plugins/'))
      void res
        .text()
        .then((s) => registrations.push(...clientRegistrations(s)))
        .catch(() => {})
  })
  const login = isolatedProfile
    ? process.env.GODBOT_TEST_DESKTOP_ORIGIN
    : (await readFile(join(dir, 'local-web-entry.private'), 'utf8')).trim()
  await page.goto(login, { waitUntil: 'domcontentloaded' })
  const notice = page.getByRole('dialog', { name: /预览版说明|Preview Notice/u })
  await page.addLocatorHandler(notice, () => notice.getByRole('button', { name: /继续|Continue/u }).click())
  await page.goto(new URL(login).origin + '/#/godbot')
  await page.getByRole('button', { name: /^(?:Remote computers|远程电脑)$/u, exact: true }).click()
  panel = page.getByRole('dialog', { name: /^(?:Remote computers|远程电脑)$/u, exact: true })
  const machine = panel.getByRole('button', { name: new RegExp(fixtureName) })
  if (await machine.count()) {
    await machine.click()
  } else {
    await panel
      .getByRole('button', { name: /^(?:Pair computer|配对电脑)$/u, exact: true })
      .last()
      .click()
    const offerPath = execFileSync(join(dir, fixtureDir, 'issue-offer'), [], { encoding: 'utf8' }).trim()
    try {
      await panel.getByLabel(/^(?:Pairing offer|配对链接)$/u).fill((await readFile(offerPath, 'utf8')).trim())
    } finally {
      await unlink(offerPath)
    }
    await panel.getByRole('button', { name: /^(?:Review offer|检查配对信息)$/u }).click()
    await panel.getByText(/^(?:Trust this computer\?|信任这台电脑？)$/u).waitFor()
    await panel
      .getByRole('button', { name: /^(?:Pair computer|配对电脑)$/u, exact: true })
      .last()
      .click()
  }
  await panel.getByRole('button', { name: /^(?:View desktop|查看桌面)$/u, exact: true }).waitFor()
  if (kind === 'turn') {
    await panel.getByText(/^(?:Computer details|电脑详情)$/u, { exact: true }).click()
    await panel.getByRole('checkbox', { name: /Require TURN for desktop video|桌面视频仅使用 TURN 中继/u }).check()
  }
  await panel.getByRole('button', { name: /^(?:View desktop|查看桌面)$/u, exact: true }).click()
  async function approve(mode) {
    const request = await until(
      () => manage('sessions').find((s) => (mode === 'control' ? s.controlPending : s.state === 'pending')),
      'pending ' + mode,
      15000,
    )
    manage('approve', request.sessionId || request.id)
  }
  await approve('view')
  const video = panel.locator('video')
  await video.waitFor()
  await page.waitForFunction(
    () => document.querySelector('.gb-machine-video-window video')?.videoWidth > 0,
    undefined,
    { timeout: 45000 },
  )
  assert.ok(registrations.includes(source.clientSha256), 'actual installed client digest mismatch')
  evidence.clientSha256 = source.clientSha256
  const stats = () =>
    page.evaluate(async () => {
      const stats = await window.machineTestPeer.getStats()
      const v = [...stats.values()].find((x) => x.type === 'inbound-rtp' && x.kind === 'video')
      const transport = [...stats.values()].find((x) => x.type === 'transport' && x.selectedCandidatePairId)
      const p =
        stats.get(transport?.selectedCandidatePairId) ||
        [...stats.values()].find((x) => x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded')
      const l = stats.get(p?.localCandidateId),
        r = stats.get(p?.remoteCandidateId)
      return {
        width: v?.frameWidth,
        height: v?.frameHeight,
        fps: v?.framesPerSecond,
        frames: v?.framesDecoded,
        drops: v?.framesDropped,
        bytes: v?.bytesReceived,
        time: v?.timestamp,
        codec: stats.get(v?.codecId)?.mimeType,
        rttMs: p?.currentRoundTripTime * 1000,
        local: l?.candidateType,
        remote: r?.candidateType,
        relayProtocol: l?.relayProtocol,
      }
    })
  evidence.first = await until(async () => {
    const s = await stats()
    return s.local && s.remote && s.frames >= 6 && s.fps > 0 ? s : null
  }, 'negotiated candidate pair, frame rate and decoded video')
  if (kind === 'turn') assert.equal(evidence.first.local, 'relay')
  else assert.ok(![evidence.first.local, evidence.first.remote].includes('relay'))
  const [tx, ty] = run(['cat', '/home/godbotqa/desktop/point']).split(' ').map(Number)
  const [lx, ly] = run(['cat', '/home/godbotqa/desktop/latency-point']).split(' ').map(Number)
  async function coord(x, y) {
    return video.evaluate(
      (v, [x, y]) => {
        const r = v.getBoundingClientRect(),
          s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight)
        return [
          r.left + (r.width - v.videoWidth * s) / 2 + x * s,
          r.top + (r.height - v.videoHeight * s) / 2 + y * s,
        ]
      },
      [x, y],
    )
  }
  const initialReceipt = run(['sh', '-c', 'cat "$HOME/desktop/receipt" 2>/dev/null || true'])
  await page.mouse.click(...(await coord(tx, ty)))
  await page.keyboard.type('ignored')
  await new Promise((r) => setTimeout(r, 180))
  assert.equal(run(['sh', '-c', 'cat "$HOME/desktop/receipt" 2>/dev/null || true']), initialReceipt)
  await panel.getByRole('button', { name: /^(?:Request control|请求控制)$/u, exact: true }).click()
  await approve('control')
  await panel.getByText(/^(?:You have control|你正在控制)$/u, { exact: true }).waitFor()
  const suffix = 'odbotweb' + randomUUID().replaceAll('-', '').slice(0, 10)
  const marker = 'G' + suffix
  await page.mouse.click(...(await coord(tx, ty)))
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Shift+g')
  await page.keyboard.type(suffix)
  await until(() => run(['cat', '/home/godbotqa/desktop/receipt']) === marker, 'target-side GTK input receipt')
  await page.keyboard.press('Escape')
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON')
  const sentBefore = await page.evaluate(() => window.testInputCount)
  await page.mouse.move(...(await coord(lx, ly)))
  await page.mouse.wheel(0, 70)
  await page.waitForTimeout(100)
  assert.equal(
    await page.evaluate(() => window.testInputCount),
    sentBefore,
    'Escape must keep hover and wheel local',
  )
  evidence.escapeReleasedInput = true
  const desktopPanel = panel.locator('.gb-machine-desktop')
  const enterFullscreen = desktopPanel.getByRole('button', { name: /^(?:Fullscreen|全屏)$/u, exact: true })
  await enterFullscreen.click()
  await until(
    () => desktopPanel.evaluate((node) => document.fullscreenElement === node),
    'desktop enters fullscreen',
  )
  await desktopPanel.getByRole('button', { name: /^(?:Disconnect|断开)$/u, exact: true }).click({ trial: true })
  await desktopPanel
    .getByRole('button', { name: /^(?:Release control|交还控制权)$/u, exact: true })
    .click({ trial: true })
  await video.focus()
  await page.keyboard.press('Control+Alt+Space')
  assert.ok(
    await desktopPanel
      .getByRole('button', { name: /^(?:Session details|会话详情)$/u, exact: true })
      .evaluate((node) => document.activeElement === node),
    'fullscreen input escape focuses local toolbar',
  )
  await desktopPanel.getByRole('button', { name: /^(?:Exit fullscreen|退出全屏)$/u, exact: true }).click()
  await until(() => page.evaluate(() => !document.fullscreenElement), 'desktop leaves fullscreen')
  assert.ok(await video.evaluate((node) => node.videoWidth > 0), 'leaving fullscreen keeps the session')
  evidence.fullscreenEscape = true
  receipt = marker
  evidence.gtkInputConfirmed = true
  if (process.env.GODBOT_TEST_TRANSIENT_ICE === '1') {
    assert.ok(await page.evaluate(() => window.testInitialFailureInjected))
    evidence.simulatedInitialFailureRecovered = true
  }
  await panel.getByRole('button', { name: /^(?:Session details|会话详情)$/u, exact: true }).click()
  await panel.screenshot({ path: join(dir, proofName + '.png') })
  await page.evaluate(
    ([x, y]) => {
      const video = document.querySelector('.gb-machine-video-window video'),
        canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const c = canvas.getContext('2d', { willReadFrequently: true })
      window.testPixel = () => {
        c.drawImage(video, x, y, 1, 1, 0, 0, 1, 1)
        const p = c.getImageData(0, 0, 1, 1).data
        return p[2] > p[1] ? 'blue' : 'green'
      }
    },
    [lx, ly],
  )
  async function sample() {
    const [x, y] = await coord(lx, ly)
    const [color, start] = await page.evaluate(() => [window.testPixel(), performance.now()])
    await page.mouse.click(x, y)
    const end = await page.evaluate(
      (color) =>
        new Promise((resolve, reject) => {
          const v = document.querySelector('.gb-machine-video-window video'),
            timeout = setTimeout(() => reject(new Error('No visible target color change')), 3500)
          const read = () => {
            if (window.testPixel() !== color) {
              clearTimeout(timeout)
              resolve(performance.now())
            } else v.requestVideoFrameCallback(read)
          }
          v.requestVideoFrameCallback(read)
        }),
      color,
    )
    evidence.samples.push(Math.round(end - start))
  }
  for (let i = 0; i < 20; i++) {
    await sample()
    await new Promise((r) => setTimeout(r, 500))
  }
  await save()
  const deadline = Date.now() + minutes * 60000
  let previous = await stats()
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, Math.min(10000, deadline - Date.now())))
    const now = await stats()
    assert.ok(now.frames > previous.frames, 'desktop frames stalled')
    assert.equal(now.local, evidence.first.local, 'selected path changed')
    evidence.fps.push(now.fps)
    evidence.rttMs.push(now.rttMs)
    evidence.frameDrops.push(now.drops)
    evidence.bitrate.push(((now.bytes - previous.bytes) * 8000) / (now.time - previous.time))
    previous = now
    if (evidence.fps.length % 6 === 0) {
      await sample()
      await save()
    }
  }
  if (process.env.GODBOT_TEST_REVOKE_DESKTOP === '1') {
    const active = manage('sessions').find((s) => s.mode === 'desktop' && s.state === 'approved')
    assert.ok(active?.deviceId, 'current staging controller')
    await page.mouse.move(...(await coord(lx, ly)))
    await page.mouse.down()
    const revoked = performance.now()
    try {
      manage('revoke', active.deviceId)
      await video.waitFor({ state: 'detached', timeout: 6500 })
    } finally {
      await page.mouse.up()
    }
    evidence.revokeToBlankMs = Math.round(performance.now() - revoked)
    assert.equal(manage('sessions').length, 0)
    await panel.getByText(/^(?:Computer details|电脑详情)$/u, { exact: true }).click()
    await panel.getByRole('button', { name: /^(?:Forget computer|忘记电脑)$/u }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /^(?:Continue|继续)$/u })
      .click()
    await machine.waitFor({ state: 'detached' })
    evidence.fixtureRemoved = true
  } else {
    await panel.getByRole('button', { name: /^(?:Release control|交还控制权)$/u, exact: true }).click()
    await panel.getByText(/^(?:View only|仅查看)$/u, { exact: true }).waitFor()
    await enterFullscreen.click()
    await desktopPanel.getByRole('button', { name: /^(?:Disconnect|断开)$/u, exact: true }).click()
    await until(() => manage('sessions').length === 0, 'target resources closed')
  }
  evidence.p95Ms = evidence.samples.slice().sort((a, b) => a - b)[Math.ceil(evidence.samples.length * 0.95) - 1]
  evidence.last = previous
  evidence.finishedAt = new Date().toISOString()
  evidence.ok = true
  console.log(
    JSON.stringify({
      ok: true,
      kind,
      minutes,
      p95Ms: evidence.p95Ms,
      receipt: !!receipt,
      ice: evidence.first.local,
      codec: evidence.first.codec,
    }),
  )
} catch (error) {
  evidence.ok = false
  evidence.failure = String(error.message).replace(/godbot:\S+|token=\S+/g, '[redacted]')
  const statusText = await panel
    ?.locator('.gb-machine-status')
    .allTextContents()
    .catch(() => [])
  if (statusText?.length)
    evidence.viewerStatus = statusText.join(' ').replace(/godbot:\S+|token=\S+/g, '[redacted]')
  console.error(evidence.failure, evidence.viewerStatus || '')
  process.exitCode = 1
} finally {
  evidence.peerEvents = await page?.evaluate(() => window.testPeerEvents).catch(() => [])
  await save()
  await browser.close()
}

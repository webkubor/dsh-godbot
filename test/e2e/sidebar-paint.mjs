import assert from 'node:assert/strict'
import { until } from './host.mjs'

// These belong to the native DSH sidebar. The team sidebar can leave that DOM
// mounted behind its own column, so mere presence or a nonzero box is insufficient.
const nativeControls = '[class*="_sidebarCol"] :is(button[class*="_newSession"], button[class*="_panelRow"], [class*="_brandName"] svg, [class*="_railMark"] svg)'

function observeSidebar(selector) {
  if (window !== top) return
  const stats = { routes: {}, firstLeak: null }
  let frame
  const samples = new MessageChannel()
  const fetch = window.fetch
  // Hold only the browser-facing response. Host RPCs and the fixture stay live.
  let gate = location.hash === '#/godbot' ? Promise.withResolvers() : null
  let held = false
  window.fetch = function (input, ...args) {
    const url = new URL(input instanceof Request ? input.url : input, location.href)
    const response = fetch.call(this, input, ...args)
    if (!gate || url.pathname !== '/api/godbot/snapshot' || location.hash !== '#/godbot') return response
    const wait = gate.promise
    return response.then(async result => {
      held = true
      if (await wait === 'unavailable') throw new Error('E0 workspace snapshot unavailable')
      return result
    })
  }

  function onScreen(node) {
    if (!node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    const rect = node.getBoundingClientRect()
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
    if (right - left < 2 || bottom - top < 2) return false
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
    return hit && node.contains(hit)
  }
  samples.port1.onmessage = () => {
    const hash = location.hash
    const row = stats.routes[hash] ??= { frames: 0, native: 0, workspace: 0 }
    row.frames++
    const native = Array.from(document.querySelectorAll(selector)).find(onScreen)
    if (native) {
      row.native++
      if (hash.startsWith('#/godbot') && !stats.firstLeak)
        stats.firstLeak = { hash, timeMs: Math.round(performance.now()), control: native.getAttribute('aria-label') || native.tagName }
    }
    const active = document.querySelector('[aria-label="NativeCrew 工作区"] .gb-workspace-action[aria-label="返回 dsh"]')
    if (active && onScreen(active)) row.workspace++
    frame = requestAnimationFrame(() => samples.port2.postMessage(null))
  }
  // Read after the frame's animation callbacks and layout, including other
  // callbacks that replace the sidebar within the same rendering opportunity.
  frame = requestAnimationFrame(() => samples.port2.postMessage(null))
  window.__godbotSidebarPaint = {
    stats,
    get held() { return held },
    arm() { held = false; gate = Promise.withResolvers() },
    release(outcome) { gate?.resolve(outcome); gate = null },
    stop() {
      gate?.resolve()
      window.fetch = fetch
      cancelAnimationFrame(frame)
      samples.port1.close()
      samples.port2.close()
    },
  }
}

async function holdInitialSnapshot(page, enter, note, label, outcome) {
  try {
    await enter()
    await page.waitForFunction(() => window.__godbotSidebarPaint.held, undefined, { timeout: 10_000 })
    const row = () => page.evaluate(() => window.__godbotSidebarPaint.stats.routes['#/godbot'] ?? { frames: 0, native: 0 })
    const start = await row()
    await until(async () => (await row()).frames >= start.frames + 8, 'paint observations while waiting for ' + label)
    const result = await row()
    note('sidebar-snapshot-held', { phase: label, framesObserved: result.frames - start.frames, nativeFrames: result.native - start.native })
  } finally {
    await page.evaluate(value => window.__godbotSidebarPaint?.release(value), outcome)
  }
}

async function checkObservations(page, note, phase) {
  const observation = await page.evaluate(() => window.__godbotSidebarPaint.stats)
  note('sidebar-painted-frames', { phase, ...observation })
  assert.equal(observation.firstLeak, null, 'DSH sidebar was visible on a NativeCrew route: ' + JSON.stringify(observation.firstLeak))
}

async function openPreviousDocument(host) {
  const { page } = host
  await page.goto('about:blank')
  // A cached DSH document predates the index transformer. Keep the real shell,
  // plugin URLs, response headers, and client bundle, omitting just its bootstrap.
  const url = host.url + '/'
  const response = await page.request.get(url)
  assert.ok(response.ok())
  let removed = 0
  const body = (await response.text()).replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/giu, tag => {
    if (!tag.includes('data-godbot-boot')) return tag
    removed++
    return ''
  })
  assert.ok(removed > 0, 'the cached document fixture must omit NativeCrew bootstrap')
  await page.route(url, route => route.fulfill({ response, body }), { times: 1 })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
}

// A complete document load catches flashes before plugin initialization.
export async function verifySidebarPaint(host, note) {
  const { page } = host
  const script = await page.addInitScript(observeSidebar, nativeControls)
  try {
    await page.evaluate(observeSidebar, nativeControls)
    const native = page.locator('[class*="_sidebarCol"] button[class*="_newSession"]').first()
    await native.click({ trial: true }) // Handles the real DSH first-run notice.
    const nativeFrames = () => page.evaluate(() => window.__godbotSidebarPaint.stats.routes['']?.native ?? 0)
    await until(async () => (await nativeFrames()) >= 3, 'native sidebar positive control')
    const controlFrames = await nativeFrames()

    await page.goto('about:blank')
    await holdInitialSnapshot(page, () => page.goto(host.url + '/#/godbot', { waitUntil: 'domcontentloaded' }), note, 'cold deep link')
    const navigation = page.getByRole('navigation', { name: 'NativeCrew 工作区' })
    const back = navigation.getByRole('button', { name: '返回 dsh' })
    await back.click({ trial: true })
    await until(() => page.evaluate(() => window.__godbotSidebarPaint.stats.routes['#/godbot']?.workspace >= 3), 'team sidebar painted')
    await back.click()
    await until(async () => (await nativeFrames()) >= 3, 'native sidebar restored after leaving NativeCrew')
    note('sidebar-native-control', { frames: controlFrames })
    await checkObservations(page, note, 'workspace handoffs')

    await page.goto(host.url + '/#/godbot/teams')
    const settings = page.locator('.bt-settings')
    await settings.getByRole('heading', { name: /^(任务板|Task board)$/u }).waitFor()
    assert.equal(new URL(page.url()).hash, '#/godbot')
    await holdInitialSnapshot(page, () => page.reload({ waitUntil: 'domcontentloaded' }), note, 'workspace reload')
    await back.click({ trial: true })
    await until(() => page.evaluate(() => window.__godbotSidebarPaint.stats.routes['#/godbot']?.workspace >= 3), 'workspace sidebar after reload')
    await checkObservations(page, note, 'legacy task board link and reload')

    await openPreviousDocument(host)
    await native.click({ trial: true })
    await until(async () => (await nativeFrames()) >= 3, 'native sidebar visible on the previous HTML')
    await page.evaluate(() => window.__godbotSidebarPaint.arm())
    const entry = page.locator('[class*="_sidebarCol"]').getByRole('button', { name: 'NativeCrew', exact: true })
    await holdInitialSnapshot(page, () => entry.click(), note, 'cached shell to unavailable team', 'unavailable')
    const failure = page.locator('[data-godbot-runtime="unavailable"]')
    await failure.getByRole('alert').getByText(/E0 workspace snapshot unavailable/).waitFor()
    const beforeExit = await nativeFrames()
    await failure.getByRole('button', { name: '返回 dsh' }).click()
    await until(async () => (await nativeFrames()) >= beforeExit + 3, 'native sidebar restored after snapshot failure')
    await checkObservations(page, note, 'cached shell and failed startup')
  } finally {
    await script.dispose()
    await page.evaluate(() => window.__godbotSidebarPaint?.stop())
  }
}

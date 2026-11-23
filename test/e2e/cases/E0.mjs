import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { until } from '../host.mjs'
import { openBotChat, openFullTeam, openTaskBoard } from '../native-ui.mjs'
import { verifySidebarPaint } from '../sidebar-paint.mjs'
import { openProviderSettingsFromTeam } from '../provider-settings.mjs'

export default async function E0({ makeHost, candidate, note }) {
  const a = await makeHost()
  a.model.models = ['deepseek-flash', 'deepseek-v4-pro']
  await a.install(candidate)
  await a.start()
  await verifySidebarPaint(a, note)
  // The paint scenario finishes on deliberately stale pre-upgrade HTML with a
  // rejected startup snapshot. Begin the chat journey in the candidate document.
  await a.page.goto('about:blank')
  const godbot = await openFullTeam(a)
  await a.capture('team-workspace')
  const marker = 'E0-' + randomUUID()
  const bot = await a.bot('create-bot', { name: 'E0 Worker', model: 'deepseek-official/deepseek-flash' })
  await until(async () => (await a.bot('chat', { botId: bot.id })).items.some(item => item.kind === 'bot'), 'initial Bot greeting')
  await openBotChat(a, bot)
  const response = 'receipt-' + randomUUID()
  a.model.reply = body => JSON.stringify(body.messages).includes(marker) ? response : 'Acknowledged.'
  const composer = a.page.locator('[data-composer-card] [role=textbox]')
  await composer.fill(marker)
  await composer.press('Enter')
  const flow = a.page.locator('[data-chat-flow]')
  try {
    await flow.getByText(response, { exact: true }).first().waitFor()
  } catch (error) {
    const chat = await a.bot('chat', { botId: bot.id })
    note('bot-chat-diagnostic', { bot: bot.id, session: chat.sessionId,
      modelCalls: a.model.calls.length, requested: a.model.calls.filter(call => JSON.stringify(call.body.messages).includes(marker)).length,
      items: chat.items.slice(-8).map(({ kind, turn, text }) => ({ kind, turn, text: text?.slice(-120) })),
      visible: (await flow.innerText()).slice(-260),
      cells: await flow.locator('[data-chat-flow-kind]').evaluateAll(items => items.map(el => ({
        kind: el.dataset.chatFlowKind, text: el.textContent.slice(0, 90), hidden: !el.checkVisibility(),
        slots: [...el.querySelectorAll('[data-slot]')].slice(0, 4).map(slot => [slot.dataset.slot, slot.className, slot.childElementCount])
      })).slice(-10)),
      warnings: (await a.page.consoleMessages()).filter(msg => msg.type() === 'error').map(msg => msg.text().slice(0, 220)).slice(-10) })
    throw error
  }
  assert.ok(a.model.calls.some(call => JSON.stringify(call.body.messages).includes(marker)))
  const before = await a.bot('chat', { botId: bot.id })
  const turn = before.items.find(item => item.kind === 'bot' && item.text === response)
  assert.ok(turn)
  await a.capture('bot-chat')
  await a.restart()
  const after = await a.snapshot()
  assert.ok(after.bots.some(row => row.id === bot.id && row.sessionId === before.sessionId))
  const restored = await a.bot('chat', { botId: bot.id })
  assert.equal(restored.sessionId, before.sessionId)
  assert.ok(restored.items.some(row => row.kind === 'bot' && row.turn === turn.turn && row.text === response))
  assert.equal(await openFullTeam(a), godbot)
  await openBotChat(a, bot)
  await flow.getByText(response, { exact: true }).first().waitFor()
  await openBotChat(a, (await a.bot('state')).bots.find(row => row.id === godbot))
  await verifyBotModelHeader(a, godbot, note)
  await openProviderSettingsFromTeam(a)
  const settings = a.page.locator('.bt-settings-nav:visible')
  await settings.getByRole('button', { name: /^(关于|About).*NativeCrew$/iu }).click()
  await a.page.locator('.bt-about-name').getByText('NativeCrew', { exact: true }).waitFor()
  await a.page.locator('.bt-about-version').getByText(candidate.version, { exact: false }).waitFor()
  const oldProjectLinks = a.page.locator('a[href*="Fei2411/DS-Bot" i]:visible')
  assert.equal(await oldProjectLinks.count(), 0)
  await a.capture('about-godbot')
  await a.stop()

  const b = await makeHost()
  await b.install(candidate)
  await b.start()
  assert.notEqual(await openFullTeam(b), godbot)
  await openTaskBoard(b)
  const other = await b.snapshot()
  assert.equal(other.tasks.length, 0)
  assert.ok(!other.bots.some(item => item.id === bot.id))
  assert.ok(!JSON.stringify(other).includes(marker))
  note('isolated-install-and-restart', { botId: bot.id, sessionId: before.sessionId, turn: turn.turn,
    fixtureModelCalls: a.model.calls.length, secondBotCount: other.bots.length })
}

async function verifyBotModelHeader(host, godbot, note) {
  const { page } = host
  const ref = 'deepseek-official/deepseek-flash'
  const peerRef = 'deepseek-official/deepseek-v4-pro'
  const { models } = await host.bot('state')
  const model = models.find(entry => entry.ref === ref)
  const peerModel = models.find(entry => entry.ref === peerRef)
  assert.ok(model && peerModel, 'both fixture models are available')
  const { efforts, defaultEffort } = await host.bot('efforts', { ref })
  assert.ok(efforts.length > 1, 'fixture model offers multiple reasoning levels')
  const defaultLabel = efforts.find(effort => effort.id === defaultEffort)?.name ?? /^(Default|默认)$/u
  const useEnd = efforts.at(-1).id !== defaultEffort
  const explicit = useEnd ? efforts.at(-1) : efforts[0]
  assert.notEqual(explicit.id, defaultEffort, 'fixture has an alternative reasoning level')

  const badge = page.locator('.bt-head [data-gb-bot-model]')
  const name = badge.locator('.gb-bot-model-name')
  const level = badge.locator('.gb-bot-model-effort')
  const showsModel = label => name.getByText(label, { exact: true }).waitFor()
  const showsLevel = label => level.getByText(label, { exact: true }).waitFor()
  await host.bot('update-bot', { id: godbot, model: ref, effort: null })
  await showsModel(model.name)
  await showsLevel(defaultLabel)
  const godbotLabel = page.locator('.bt-head .bt-pill-name')
  await godbotLabel.getByText('NativeCrew', { exact: true }).waitFor()
  assert.ok(await godbotLabel.evaluate(label => label.scrollWidth <= label.clientWidth),
    'the NativeCrew name fits its desktop chat header')

  await page.locator('.bt-side-collapse').click()
  await page.locator('.bt-leftcol').waitFor({ state: 'detached' })
  const expandSidebar = page.locator('.bt-title-toggle')
  await expandSidebar.waitFor()
  const collapsedStyle = await badge.evaluate(button => ({
    toolbar: getComputedStyle(button.closest('.gb-chat-bar')).display,
    border: getComputedStyle(button).borderTopWidth,
  }))
  assert.deepEqual(collapsedStyle, { toolbar: 'flex', border: '0px' },
    'the chat toolbar keeps its layout and button styles without the sidebar')
  await host.capture('bot-model-header-sidebar-collapsed')

  await badge.click()
  const drawer = page.locator('.bt-drawer-model').filter({ has: page.getByRole('slider') })
  await drawer.locator('.bt-model-trigger').waitFor()
  await drawer.getByRole('slider').press(useEnd ? 'End' : 'Home')
  await showsLevel(explicit.name)
  await drawer.locator('.bt-effort-reset').click()
  await showsLevel(defaultLabel)
  await page.locator('.bt-head .bt-pill').click()
  await drawer.waitFor({ state: 'hidden' })
  await expandSidebar.click()

  const peer = await host.bot('create-bot', { name: 'Header fixture Bot', model: peerRef, effort: explicit.id })
  const room = await host.bot('create-room', { name: 'Header fixture group', members: [godbot, peer.id] })
  await page.locator(`[data-bot-id="${peer.id}"]`).click()
  await page.locator('.bt-head .bt-pill-name').getByText(peer.name, { exact: true }).waitFor()
  await showsModel(peerModel.name)
  await showsLevel(explicit.name)
  await host.capture('bot-model-header')
  await page.locator(`[data-room-id="${room.id}"]`).click()
  await page.locator('.bt-head .bt-pill-name').getByText(room.name, { exact: true }).waitFor()
  await badge.waitFor({ state: 'hidden' })
  await page.locator(`[data-bot-id="${godbot}"]`).click()
  await showsModel(model.name)
  await showsLevel(defaultLabel)

  const desktop = page.viewportSize()
  const narrow = { width: 430, height: 840 }
  await page.setViewportSize(narrow)
  await showsModel(model.name)
  await showsLevel(defaultLabel)
  const bounds = await badge.boundingBox()
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= narrow.width, 'model control fits in the narrow chat header')
  await until(async () => {
    const [contentWidth, availableWidth] = await name.evaluate(label => [label.scrollWidth, label.clientWidth])
    assert.ok(contentWidth <= availableWidth, `model name width ${contentWidth}px exceeds its ${availableWidth}px slot`)
    return true
  }, 'full fixture model name at narrow width', 3000)
  await host.capture('bot-model-header-narrow')
  await page.setViewportSize(desktop)
  note('bot-model-header', { models: [model.name, peerModel.name], explicitEffort: explicit.id, defaultEffort, roomHasBadge: false, narrowWidth: narrow.width })
}

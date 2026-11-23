import assert from 'node:assert/strict'
import { until } from './host.mjs'

export async function openFullTeam(host) {
  await host.page.goto(host.url + '/#/godbot')
  await host.page.locator('.bt-head .bt-pill').waitFor()
  const settings = host.page.locator('button.bt-settings-close:visible')
  if (await settings.count()) await settings.click()
  assert.equal((await host.snapshot()).workspaceRuntime.mode, 'embedded')
  const state = await host.bot('state')
  assert.ok(state.mainBotId && state.bots.some(bot => bot.id === state.mainBotId), 'full team loaded its NativeCrew')
  return state.mainBotId
}

export async function openSettingsPage(host, name) {
  const { page } = host
  const nav = page.locator('.bt-settings-layer:not([data-leaving]) .bt-settings-nav')
  if (await nav.isVisible()) {
    await nav.getByRole('button', { name }).click()
    return
  }
  await page.locator('.bt-head .bt-pill').click({ trial: true })
  const launchers = page.locator('button.bt-account, button.bt-settings-trigger')
  const { index, menu } = await until(async () => launchers.evaluateAll(buttons => {
    for (const [index, button] of buttons.entries()) {
      const box = button.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      if (hit && button.contains(hit)) return { index, menu: button.getAttribute('aria-haspopup') === 'menu' }
    }
    return null
  }), 'active workbench settings launcher')
  await launchers.nth(index).click()
  if (menu) await page.getByRole('menuitem', { name: /^(设置|Settings)$/u }).click()
  await nav.getByRole('button', { name }).click()
}

export async function openTaskBoard(host) {
  await openSettingsPage(host, /^(任务板|Task board)$/u)
  const board = host.page.locator('.gb-task-settings')
  await board.getByText('分配任务', { exact: true }).waitFor()
  return board
}

export async function openBotChat(host, bot) {
  const { page } = host
  await page.locator(`[data-bot-id="${bot.id}"]`).click()
  await page.locator('.bt-head .bt-pill-name').getByText(bot.name, { exact: true }).waitFor()
}

export async function verifyModalTheme(dialog, themeSelector = 'body') {
  const appearance = await dialog.evaluate((node, selector) => {
    const theme = document.querySelector(selector)
    const sample = document.createElement('span')
    sample.style.cssText = 'display:none;background-color:var(--bt-card);color:var(--bt-ink)'
    theme.append(sample)
    const expected = getComputedStyle(sample)
    const actual = getComputedStyle(node)
    const result = {
      styledModal: node.matches('.gb-modal:modal'),
      foreground: actual.color,
      surface: actual.backgroundColor,
      expectedForeground: expected.color,
      expectedSurface: expected.backgroundColor,
      shadow: actual.boxShadow,
      scheme: actual.colorScheme,
    }
    sample.remove()
    return result
  }, themeSelector)
  assert.ok(appearance.styledModal, 'NativeCrew dialog uses the shared native modal')
  assert.equal(appearance.foreground, appearance.expectedForeground, 'dialog text follows the workspace theme')
  assert.equal(appearance.surface, appearance.expectedSurface, 'dialog background follows the workspace theme')
  assert.notEqual(appearance.shadow, 'none', 'dialog has elevated chrome')
  return { foreground: appearance.foreground, surface: appearance.surface, scheme: appearance.scheme }
}

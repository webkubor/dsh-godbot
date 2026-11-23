import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { darkTokens, lightTokens, themeStyle, workspaceTheme } from '../../src/client/theme.js'
const actionsStyle = readFileSync(new URL('../../src/client/workspace-actions.css', import.meta.url), 'utf8')

const controlsStyle = readFileSync(new URL('../../src/client/workspace-controls.css', import.meta.url), 'utf8')
const runtimeStyle = readFileSync(new URL('../../src/client/workspace-runtime.css', import.meta.url), 'utf8')
const entrySource = readFileSync(new URL('../../src/client/index.js', import.meta.url), 'utf8')

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(pair => parseInt(pair, 16) / 255)
  const [r, g, b] = channels.map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('both workspace palettes preserve readable control labels and conversation text', () => {
  for (const [mode, tokens] of [[workspaceTheme.light, lightTokens], [workspaceTheme.dark, darkTokens]]) {
    assert.equal(tokens.accent, mode.accent)
    assert.equal(tokens.main, mode.bg)
    assert.equal(tokens.sidebar, mode.sidebar)
    for (const [foreground, background] of [
      ['ink', 'main'], ['ink-2', 'sidebar'], ['ink-3', 'main'],
      ['accent-ink', 'accent'], ['user-ink', 'user'],
    ]) {
      const levels = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => b - a)
      assert.ok((levels[0] + 0.05) / (levels[1] + 0.05) >= 4.5, foreground + ' on ' + background)
    }
  }
})

test('the workspace sheets read the shared palette instead of a fixed dark scheme', () => {
  assert.match(themeStyle, /body\[data-ds-dark-theme\] :is\(\.gb-root,\.gb-theme\)\{/)
  // Installed once for the plugin, so surfaces DSH mounts outside .gb-root share it.
  assert.match(entrySource, /installStyles\(themeStyle \+/)
  for (const sheet of [controlsStyle, actionsStyle, runtimeStyle]) {
    assert.doesNotMatch(sheet, /--bt-ink:/)
    assert.doesNotMatch(sheet, /color-scheme:\s*dark/)
    const used = new Set([...sheet.matchAll(/var\(--bt-([a-z0-9-]+)/g)].map((m) => m[1]))
    for (const name of used) assert.ok(name in lightTokens, `--bt-${name} is declared for 原生 Agent`)
  }
})

test('base control rules have zero specificity so component rules win in every state', () => {
  const base = controlsStyle
    .slice(0, controlsStyle.indexOf(':is(.gb-task-settings, .gb-modal) input::placeholder'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = base.split('}').map((rule) => rule.split('{')[0].trim()).filter(Boolean)
  assert.ok(selectors.length >= 8)
  for (const selector of selectors) {
    assert.ok(selector.startsWith(':where('), selector)
    // The opening :where( must close at the very end, wrapping every state pseudo-class.
    let depth = 0
    for (let i = ':where'.length; i < selector.length; i++) {
      if (selector[i] === '(') depth++
      if (selector[i] === ')') depth--
      if (depth === 0) assert.equal(i, selector.length - 1, selector)
    }
    assert.match(selector, /:not\(\.gb-terminal-panel \*\)/, selector)
  }
})

test('every NativeCrew alert carries a styled class, including those shown in the Bot workspace', () => {
  const dir = new URL('../../src/client/', import.meta.url)
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const source = readFileSync(new URL(name, dir), 'utf8')
    for (const [props] of source.matchAll(/\{[^{}]*role: ?'alert'[^{}]*\}/g))
      assert.match(props, /className: ?'[^']+'/, name + ': ' + props)
  }
  assert.match(controlsStyle, /^\.gb-error \{/m)
})

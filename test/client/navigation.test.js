import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as afterNavigation } from 'node:timers/promises'
import {
  managementHash,
  connectNavigation,
  panelId,
  sessionSelection,
  workspaceHash,
} from '../../src/client/navigation.js'

test('automatic Bot recovery does not supersede a later selection or its empty main view', async () => {
  let main = 'godbot'
  const opened = []
  const selection = sessionSelection({ current: () => main, waitMs: 5000 })
  try {
    const refresh = Promise.withResolvers()
    const stale = selection.recover(() => opened.push('godbot'), () => refresh.promise)
    selection.open('worker', (id) => opened.push(id))
    main = undefined
    selection.observe(main)
    await selection.recover(() => opened.push('godbot'))
    refresh.resolve()
    await stale
    assert.deepEqual(opened, ['worker'])

    main = 'worker'
    selection.observe(main)
    await selection.recover(() => opened.push('worker-next'))
    main = undefined
    selection.observe(main)
    await selection.recover(() => opened.push('godbot'))
    assert.deepEqual(opened, ['worker', 'worker-next'])

    main = 'other'
    selection.observe(main)
    main = undefined
    await selection.recover(() => opened.push('godbot'))
    assert.deepEqual(opened, ['worker', 'worker-next', 'godbot'])
  } finally {
    selection.dispose()
  }
})

test('an unresolved selection releases the guard and recovers only an empty main view', () => {
  let main = 'godbot'
  let expire, recoveries = 0
  const selection = sessionSelection({
    current: () => main,
    onEmpty: () => recoveries++,
    waitMs: 5000,
    schedule(fn) { expire = fn; return fn },
    cancel() {},
  })
  selection.open('worker', () => {})
  const staleExpiry = expire
  selection.open('third', () => {})
  staleExpiry()
  assert.equal(recoveries, 0)
  main = undefined
  expire()
  assert.equal(recoveries, 1)
  selection.dispose()
  expire()
  assert.equal(recoveries, 1)
})

test('reopening a part reserves its destination while its old conversation is archived', async () => {
  let main = 'second'
  const opened = []
  const selection = sessionSelection({ current: () => main, waitMs: 5000 })
  try {
    const ready = Promise.withResolvers()
    const opening = selection.open('first', id => opened.push(id), () => ready.promise)
    main = undefined
    selection.observe(main)
    await selection.recover(() => opened.push('godbot'))
    ready.resolve(true)
    assert.equal(await opening, true)
    assert.deepEqual(opened, ['first'])

    main = 'first'
    selection.observe(main)
    const another = Promise.withResolvers()
    const earlier = selection.open('second', id => opened.push(id), () => another.promise)
    selection.open('other-bot', id => opened.push(id))
    another.resolve(true)
    await earlier
    assert.deepEqual(opened, ['first', 'other-bot'])
  } finally {
    selection.dispose()
  }
})

function browserAt(url, state = null, prior = []) {
  const events = new Map()
  const pages = [
    ...prior.map((address) => ({ url: new URL(address), state: null })),
    { url: new URL(url), state },
  ]
  let index = pages.length - 1
  function emit(name) {
    for (const listener of events.get(name) ?? []) listener()
  }
  function traverse(offset) {
    setImmediate(() => {
      const target = index + offset
      if (target < 0 || target >= pages.length) return
      const oldHash = pages[index].url.hash
      index = target
      emit('popstate')
      if (oldHash !== pages[index].url.hash) emit('hashchange')
    })
  }
  return {
    get location() {
      return pages[index].url
    },
    get listeners() {
      return [...events.values()].reduce((sum, set) => sum + set.size, 0)
    },
    addEventListener(name, fn) {
      if (!events.has(name)) events.set(name, new Set())
      events.get(name).add(fn)
    },
    removeEventListener(name, fn) {
      events.get(name)?.delete(fn)
    },
    history: {
      get length() {
        return pages.length
      },
      get state() {
        return pages[index].state
      },
      back: () => traverse(-1),
      forward: () => traverse(1),
      pushState(value, _title, path) {
        const next = { url: new URL(path, pages[index].url), state: structuredClone(value) }
        pages.splice(index + 1, pages.length, next)
        index++
      },
      replaceState(value, _title, path) {
        pages[index] = { url: new URL(path, pages[index].url), state: structuredClone(value) }
      },
    },
    followHash(hash) {
      const next = new URL(pages[index].url)
      next.hash = hash
      this.history.pushState(null, '', next)
      emit('hashchange')
    },
  }
}

const previousUrl = 'https://dsh.test/work/?workspace=repo#/session/abc'
function shell(browser, initial = null) {
  let panel = initial,
    session = 'ordinary'
  const changes = [],
    listeners = new Set(),
    installed = new Set([panelId, 'calendar', 'files'])
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: Object.fromEntries(
          ['ordinary', 'godbot', 'worker'].map((id) => [
            id,
            { id, retainedBy: { mainView: Number(id === session) } },
          ]),
        ),
      }),
    },
  }
  const layout = {
    panelInfo: {
      getSnapshot: () => ({ activePanelId: panel }),
      subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    selectPanel(id) {
      if (panel === id) return
      panel = id
      for (const fn of listeners) fn()
    },
  }
  const openSession = (id) => {
    session = id
    layout.selectPanel(null)
  }
  const ctx = {
    sessions,
    layout,
    uiWorkspace: { openSession },
    slots: { entries: () => [...installed].map((key) => ({ options: { key } })) },
  }
  const nav = connectNavigation(ctx, browser, (target) => {
    changes.push(['enter', 'bot', target])
    openSession('godbot')
    return () => changes.push(['leave', 'bot'])
  })
  return {
    nav,
    changes,
    installed,
    select: layout.selectPanel,
    openSession,
    get panel() {
      return panel
    },
    get session() {
      return session
    },
    get subscriptions() {
      return listeners.size
    },
  }
}

test('the sidebar opens the real Bot conversation in one history entry and restores DSH', async () => {
  const browser = browserAt(previousUrl, { seed: 1 }),
    app = shell(browser, 'files')
  app.select(panelId)
  assert.equal(browser.location.hash, workspaceHash)
  assert.equal(app.panel, null)
  assert.equal(app.session, 'godbot')
  app.openSession('worker')
  app.select(panelId)
  assert.equal(app.session, 'worker')
  assert.equal(browser.history.length, 2)
  app.nav.back()
  await afterNavigation()
  assert.equal(app.session, 'ordinary')
  assert.equal(app.panel, 'files')
  assert.equal(browser.location.href, previousUrl)
  assert.deepEqual(browser.history.state, { seed: 1 })
  assert.deepEqual(app.changes, [
    ['enter', 'bot', undefined],
    ['leave', 'bot'],
  ])
  app.nav.dispose()
})
test('browser history traversal restores Bot and DSH views without adding history or remounting twice', async () => {
  const browser = browserAt(previousUrl),
    app = shell(browser)
  app.select(panelId)
  browser.history.back()
  await afterNavigation()
  assert.equal(app.panel, null)
  assert.equal(app.session, 'ordinary')
  browser.history.forward()
  await afterNavigation()
  assert.equal(app.panel, null)
  assert.equal(browser.location.hash, workspaceHash)
  assert.equal(browser.history.length, 2)
  assert.equal(app.changes.length, 3)
  app.nav.dispose()
})
test('a deep link keeps the user in the current tab on Return, even with unrelated browser history', () => {
  for (const hash of [workspaceHash, managementHash]) {
    const browser = browserAt('https://dsh.test/work/' + hash, { seed: 9 }, ['https://elsewhere.test/'])
    const app = shell(browser)
    assert.equal(app.panel, null)
    assert.equal(browser.location.hash, workspaceHash)
    assert.deepEqual(app.changes, [['enter', 'bot', hash === managementHash ? { settings: 'tasks' } : undefined]])
    app.nav.back()
    assert.equal(browser.location.href, 'https://dsh.test/work/')
    assert.deepEqual(browser.history.state, { seed: 9 })
    assert.equal(app.session, 'ordinary')
    app.nav.dispose()
  }
})
test('the old standalone Agent bookmark opens the Bot workspace with ordinary history semantics', () => {
  const url = 'https://dsh.test/work/#/godbot/agents'
  for (const saved of [null, { dshNativeCrewWorkspace: { session: 'ordinary', panel: 'files', hash: '#/session/abc', pushed: false } }]) {
    const browser = browserAt(url, saved)
    const app = shell(browser)
    assert.equal(browser.location.hash, workspaceHash)
    assert.equal(browser.history.length, 1)
    assert.equal(app.panel, null)
    assert.deepEqual(app.changes, [['enter', 'bot', undefined]])
    app.nav.back()
    assert.equal(app.session, 'ordinary')
    assert.equal(app.panel, saved ? 'files' : null)
    assert.equal(browser.location.hash, saved ? '#/session/abc' : '')
    app.nav.dispose()
  }
})
test('refreshing the Bot workspace restores its original DSH return session and panel', async () => {
  const browser = browserAt(previousUrl),
    old = shell(browser, 'calendar')
  old.select(panelId)
  old.nav.dispose()
  const fresh = shell(browser)
  assert.equal(fresh.panel, null)
  fresh.nav.back()
  await afterNavigation()
  assert.equal(fresh.panel, 'calendar')
  assert.equal(fresh.session, 'ordinary')
  fresh.nav.dispose()
})
test('selecting a different real DSH panel releases the Bot and keeps the new panel', () => {
  const browser = browserAt(previousUrl),
    app = shell(browser, 'files')
  app.select(panelId)
  app.select('calendar')
  assert.equal(app.panel, 'calendar')
  assert.equal(app.session, 'ordinary')
  assert.equal(browser.location.href, previousUrl)
  assert.deepEqual(
    app.changes.map((row) => row.slice(0, 2)),
    [
      ['enter', 'bot'],
      ['leave', 'bot'],
    ],
  )
  app.nav.dispose()
})
test('an unavailable return panel falls back to the original DSH session and plugin disposal is idempotent', async () => {
  const browser = browserAt(previousUrl)
  const app = shell(browser, 'files')
  app.select(panelId)
  app.installed.delete('files')
  app.nav.back()
  await afterNavigation()
  assert.equal(app.panel, null)
  assert.equal(app.session, 'ordinary')
  app.select(panelId)
  app.nav.dispose()
  app.nav.dispose()
  assert.equal(browser.listeners, 0)
  assert.equal(app.subscriptions, 0)
  assert.equal(app.changes.filter((row) => row[0] === 'leave').length, 2)
})

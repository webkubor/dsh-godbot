import { workspaceHash, managementHash, legacyAgentsHash, providerSettingsHash, workspaceHashes } from '../team/workspace-routes.js'

export { workspaceHash, managementHash }
export const panelId = 'dsh-godbot'
const historyKey = 'dshNativeCrewWorkspace'

const isWorkspaceHash = hash => workspaceHashes.includes(hash)

export function mainSession(ctx) {
  return Object.values(ctx.sessions.list.getSnapshot().byId ?? {}).find((s) => s?.retainedBy?.mainView > 0)
    ?.id
}

/** The retained main Session can be absent while DSH opens a selected chat. */
export function sessionSelection({ current, onEmpty, waitMs, schedule = setTimeout, cancel = clearTimeout }) {
  let pending, timer
  let revision = 0, disposed = false

  function endOpening() {
    cancel(timer)
    timer = undefined
    pending = undefined
  }

  function canRecover(id) {
    return !disposed && (!pending || id === pending.target)
  }

  return {
    open(target, open, prepare) {
      if (disposed) return
      const requested = ++revision
      const isCurrent = () => !disposed && revision === requested
      const from = current()
      const continuing = pending?.target === target
      endOpening()
      // Reserve the destination before a host operation that may clear the main view.
      if (from !== target || continuing || prepare !== undefined) pending = { from, target }
      const fail = (error) => {
        if (isCurrent()) {
          endOpening()
          if (prepare !== undefined && current() == null) onEmpty()
        }
        throw error
      }
      const select = () => {
        if (!isCurrent()) return
        if (pending) {
          timer = schedule(() => {
            if (!isCurrent() || !pending) return
            endOpening()
            if (current() == null) onEmpty()
          }, waitMs)
        }
        try { open(target) } catch (error) { fail(error) }
      }
      if (prepare === undefined) return select()
      return prepare().then((value) => { select(); return value }, fail)
    },
    observe(id) {
      if (pending && id != null && id !== pending.from && id !== pending.target) {
        revision += 1
        endOpening()
      }
    },
    async recover(open, refresh) {
      const from = current()
      if (!canRecover(from)) return
      const requested = revision
      if (refresh) await refresh()
      if (canRecover(from) && revision === requested && current() === from) open()
    },
    dispose() {
      disposed = true
      endOpening()
    },
  }
}

/** The Bot workspace uses DSH's normal main Session and keeps the return location in history. */
export function connectNavigation(ctx, browser, mountBot) {
  const { layout, slots } = ctx
  const selected = () => layout.panelInfo.getSnapshot().activePanelId
  const url = (hash) => browser.location.pathname + browser.location.search + hash
  let previousPanel = selected() === panelId ? null : selected()
  let previous, unmount
  let active = false,
    transition = false,
    disposed = false

  function place(pushed) {
    return {
      panel: previousPanel,
      session: mainSession(ctx),
      hash: isWorkspaceHash(browser.location.hash) ? '' : browser.location.hash,
      pushed,
    }
  }
  function saveRoute(push) {
    const state = { ...browser.history.state, [historyKey]: previous }
    browser.history[push ? 'pushState' : 'replaceState'](
      state,
      '',
      url(workspaceHash),
    )
  }
  function removeRoute() {
    const state = { ...browser.history.state }
    delete state[historyKey]
    browser.history.replaceState(state, '', url(previous?.hash || ''))
  }
  function show(next, target) {
    if (disposed || (active === next && !target)) return
    transition = true
    try {
      browser.document?.documentElement.toggleAttribute('data-godbot-workspace', next)
      unmount?.()
      unmount = undefined
      active = next
      if (active) {
        layout.selectPanel(null)
        unmount = mountBot(target)
      }
    } finally {
      transition = false
    }
  }
  function enter() {
    const push = !isWorkspaceHash(browser.location.hash)
    previous = browser.history.state?.[historyKey] ?? place(push)
    saveRoute(push)
    show(true)
  }
  function leave(panel, restoreSession) {
    if (!active) return
    show(false)
    transition = true
    try {
      if (
        restoreSession &&
        previous?.session &&
        mainSession(ctx) !== previous.session &&
        ctx.sessions.list.getSnapshot().byId?.[previous.session]
      )
        ctx.uiWorkspace.openSession(previous.session)
      const valid =
        panel && panel !== panelId && slots.entries('main').some((entry) => entry.options.key === panel)
      layout.selectPanel(valid ? panel : null)
      previousPanel = valid ? panel : null
    } finally {
      transition = false
    }
  }
  function onPanel() {
    if (transition || disposed) return
    const panel = selected()
    if (panel === panelId) {
      if (active) layout.selectPanel(null)
      else enter()
    } else if (active && panel) {
      if (isWorkspaceHash(browser.location.hash)) removeRoute()
      leave(panel, true)
    } else if (!active) previousPanel = panel
  }
  function onLocation() {
    if (disposed) return
    const { hash } = browser.location
    if (isWorkspaceHash(hash)) {
      if (!active) previous = browser.history.state?.[historyKey] ?? place(false)
      const settings = hash === managementHash ? 'tasks' : hash === providerSettingsHash ? 'local-agents' : null
      if (settings || hash === legacyAgentsHash || !browser.history.state?.[historyKey]) saveRoute(false)
      show(true, settings ? { settings } : undefined)
    } else if (active) leave(previous?.panel, true)
  }
  const unsubscribe = layout.panelInfo.subscribe(onPanel)
  browser.addEventListener('popstate', onLocation)
  browser.addEventListener('hashchange', onLocation)
  onLocation()
  onPanel()
  browser.dispatchEvent?.(new Event('godbot-router-ready'))
  return {
    back() {
      if (!active) return
      if (previous?.pushed && browser.history.length > 1) browser.history.back()
      else {
        removeRoute()
        leave(previous?.panel, true)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      browser.removeEventListener('popstate', onLocation)
      browser.removeEventListener('hashchange', onLocation)
      browser.document?.documentElement.removeAttribute('data-godbot-workspace')
      unmount?.()
      unmount = undefined
      active = false
    },
  }
}

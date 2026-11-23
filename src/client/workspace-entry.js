import { createElement as h, useId, useSyncExternalStore } from 'react'
import { webIconUrl } from '../host/web-icon.js'

// DSH mounts this outside every NativeCrew workspace: .gb-theme brings the NativeCrew
// palette and the card reuses the NativeCrew dialog (see workspace-runtime.css).
function RuntimeStatus({ source, retry, navigation }) {
  const state = useSyncExternalStore(source.subscribe, source.read, source.read)
  const titleId = useId()
  if (!state) return null
  const waiting = state.mode === 'starting'
  return h(
    'div',
    { className: 'gb-theme gb-runtime', 'data-godbot-runtime': state.mode },
    h(
      'dialog',
      { open: true, className: 'gb-modal', 'aria-labelledby': titleId, 'aria-busy': waiting || undefined },
      h(
        'header',
        { className: 'gb-modal-head' },
        h('img', { className: 'gb-runtime-mark', src: webIconUrl, alt: '' }),
        h('h2', { id: titleId }, 'NativeCrew 团队'),
      ),
      h(
        'div',
        { className: 'gb-modal-body' },
        waiting
          ? h(
              'p',
              { className: 'gb-runtime-lead', role: 'status' },
              h('span', { className: 'gb-runtime-spin', 'aria-hidden': true }),
              '正在连接团队工作台…',
            )
          : h('p', { className: 'gb-runtime-lead' }, '团队工作台暂时无法打开'),
        waiting
          ? state.message && h('small', null, state.message)
          : h('p', { className: 'gb-modal-note', role: 'alert' }, state.message || '没有收到 NativeCrew Host 的运行状态。'),
        h(
          'div',
          { className: 'gb-modal-actions' },
          h('button', { type: 'button', onClick: navigation.back }, '返回 dsh'),
          !waiting && h('button', { type: 'button', className: 'gb-modal-primary', onClick: retry }, '重新连接'),
        ),
      ),
    ),
  )
}

/** Wait for the host runtime before mounting a team workspace in this tab. */
export function openWorkspace(ctx, client, navigation, mount) {
  let state = { mode: 'starting' },
    active = true,
    timer,
    unmount,
    generation = 0
  const listeners = new Set()
  const source = {
    read: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  function publish(update) {
    state = update
    for (const fn of listeners) fn()
  }
  const off = ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'godbot-runtime', order: 100 }, () =>
      h(RuntimeStatus, { source, navigation, retry: check }),
    ),
  )
  async function check() {
    clearTimeout(timer)
    unmount?.()
    unmount = undefined
    const token = ++generation
    publish({ mode: 'starting' })
    try {
      const result = await client.snapshot()
      if (!active || token !== generation) return
      const runtime = result.workspaceRuntime ?? {
        mode: 'unavailable',
        message: '当前 NativeCrew Host 尚未提供团队运行状态。',
      }
      if (runtime.mode === 'embedded') {
        unmount = mount((error) => {
          if (active) publish(error ? { mode: 'unavailable', message: error.message } : null)
        })
      } else {
        publish(runtime)
        if (runtime.mode === 'starting') timer = setTimeout(check, 1300)
      }
    } catch (error) {
      if (active && token === generation)
        publish({ mode: 'unavailable', message: error.message || String(error) })
    }
  }
  void check()
  return () => {
    active = false
    clearTimeout(timer)
    unmount?.()
    off()
    listeners.clear()
  }
}

import { createElement as h } from 'react'
import controlsCss from './workspace-controls.css'
import modalCss from './modal.css'
import inboxCss from './workspace-inbox.css'
import runtimeCss from './workspace-runtime.css'
import { themeStyle } from './theme.js'
import { createClient } from './model.js'
import { mountTeamSurface } from './team-surface.js'
import { connectNavigation, panelId } from './navigation.js'
import { webIconUrl } from '../host/web-icon.js'
import { installSidebarLoadingStyle } from '../host/web-index.js'
import { installStyles } from './team-ui/styles.js'

export const inject = ['slots', 'layout', 'connection', 'sessions', 'uiWorkspace']

function icon({ size = 18 }) {
  return h('img', {
    src: webIconUrl,
    alt: '',
    width: size,
    height: size,
    style: { display: 'block', borderRadius: '24%' },
  })
}

export function apply(ctx) {
  ctx.effect(() => installSidebarLoadingStyle(document), 'NativeCrew sidebar loading style')
  ctx.effect(() => {
    const style = installStyles(themeStyle + controlsCss + modalCss + inboxCss + runtimeCss, 'workspace-controls')
    return () => style.remove()
  }, 'NativeCrew controls and dialogs')
  const client = createClient(ctx.connection)
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: panelId, label: 'NativeCrew', order: 11 }, icon),
  )
  ctx.slots.inject('main', () => {
    // DSH selects this key when the NativeCrew sidebar entry is clicked.
    const unregister = ctx.slots.register({ name: 'main', key: panelId }, () => null)
    let router
    router = connectNavigation(ctx, window, target => mountTeamSurface(ctx, client, {
      back: () => router?.back(),
    }, target))
    return () => {
      router.dispose()
      unregister()
    }
  })
}

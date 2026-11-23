import { createElement as h } from 'react'
import { Icon } from './chat-ui.js'
import { RemoteComputersButton } from './remote-computers.js'
import { WorkspaceInbox } from './workspace-inbox.js'
import { t } from './team-ui/i18n.js'
import actionsStyle from './workspace-actions.css'

export function WorkspaceActions({ wide, client, onSchedules, onBack }) {
  const schedules = t('Scheduled messages')
  return h('nav', {
    className: 'gb-workspace-actions',
    'aria-label': 'NativeCrew 工作区',
    'data-rail': !wide || undefined,
  },
    h('style', null, actionsStyle),
    h('button', {
      type: 'button',
      className: 'gb-workspace-action gb-schedule-shortcut',
      title: schedules,
      'aria-label': schedules,
      'aria-haspopup': 'dialog',
      onClick: onSchedules,
    }, h(Icon, { name: 'clock', size: 17 })),
    h(RemoteComputersButton, { client }),
    h(WorkspaceInbox, { client }),
    h('button', {
      type: 'button', className: 'gb-workspace-action', title: '返回 dsh', 'aria-label': '返回 dsh', onClick: onBack,
    }, h(Icon, { name: 'back', size: 17 })))
}

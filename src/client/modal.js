import { createElement as h, useId, useLayoutEffect, useRef } from 'react'
import { iconButton } from './chat-ui.js'

export function NativeCrewModal({ title, close, closeLabel = '关闭', wide, headerAside, dismissOnBackdrop, children }) {
  const dialog = useRef(null)
  const titleId = useId()

  useLayoutEffect(() => {
    const element = dialog.current
    element.showModal()
    return () => element.close()
  }, [])

  return h('dialog', {
    ref: dialog,
    className: 'gb-modal',
    'data-wide': wide || undefined,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': titleId,
    onCancel: event => { event.preventDefault(); close() },
    // Keep Escape in the native dialog, including when it sits inside the DSH sidebar drawer.
    onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation() },
    onClick: dismissOnBackdrop ? event => { if (event.target === event.currentTarget) close() } : undefined,
  },
    h('header', { className: 'gb-modal-head' },
      h('h2', { id: titleId }, title),
      headerAside,
      iconButton(closeLabel, 'close', close, { className: 'gb-modal-close' })),
    h('div', { className: 'gb-modal-body' }, children))
}

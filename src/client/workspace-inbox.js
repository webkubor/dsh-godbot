import { Fragment, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { Interaction } from './controls.js'
import { Icon } from './chat-ui.js'
import { NativeCrewModal } from './modal.js'
import { TeamTemplates } from './team-templates.js'

const title = '工作台收件箱'

function Inbox({ client, close }) {
  const mounted = useRef(false)
  const version = useRef(0)
  const [state, setState] = useState(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = useCallback(async () => {
    const id = ++version.current
    try {
      const data = await client.dispatch({ action: 'team-workspace.inbox' })
      if (mounted.current && version.current === id) {
        setState(data)
        setLoadError('')
      }
    } catch (e) { if (mounted.current && version.current === id) setLoadError(e.message) }
  }, [client])
  useEffect(() => {
    mounted.current = true
    let stopped = false
    let timer
    async function poll() {
      await reload()
      if (!stopped) timer = setTimeout(poll, 2200)
    }
    void poll()
    return () => { stopped = true; mounted.current = false; clearTimeout(timer) }
  }, [reload])
  async function submit(req) {
    if (busy) return
    setBusy(true); setError('')
    try { await client.dispatch(req) } catch (e) { if (mounted.current) setError(e.message) }
    await reload()
    if (mounted.current) setBusy(false)
  }
  return h(NativeCrewModal, { title, close },
    (error || loadError) && h('p', { className: 'gb-modal-note', role: 'alert' }, error || loadError),
    !state && !loadError && h('p', { className: 'gb-modal-note', role: 'status' }, '正在读取…'),
    state?.rows.length === 0 && h('p', { className: 'gb-modal-note' },
      h(Icon, { name: 'task', size: 17 }), '当前没有待处理的审批或提问。'),
    state?.rows.map(item => h(Interaction, {
      key: item.source + '/' + item.id, item, name: [item.team, item.label].filter(Boolean).join(' · '), pending: busy,
      run: input => submit({ action: 'team-workspace.answer', source: item.source, sessionId: item.sessionId, id: item.id, decision: input.decision, answer: input.answer }),
    })),
    state && h(TeamTemplates, { client, rooms: state.rooms }),
    state?.rooms.length > 0 && h('details', { className: 'gb-inbox-section' },
      h('summary', null, '群聊自动分派'),
      h('div', { className: 'gb-inbox-section-body' },
        h('p', { className: 'gb-muted' }, '使用团队的 DSH 模型为普通消息选择一名成员。点名优先，判断不明确时交给管理员。'),
        state.rooms.map(room => h('label', { key: room.id, className: 'gb-inbox-routing' },
          h('input', { type: 'checkbox', checked: room.enabled, disabled: busy, onChange: e => submit({ action: 'team-workspace.routing', roomId: room.id, enabled: e.target.checked }) }), room.name)))))
}

export function WorkspaceInbox({ client }) {
  const [open, setOpen] = useState(false)
  return h(Fragment, null,
    h('button', { type: 'button', className: 'gb-workspace-action', title, 'aria-label': title, 'aria-haspopup': 'dialog', onClick: () => setOpen(true) }, h(Icon, { name: 'inbox', size: 17 })),
    open && h(Inbox, { client, close: () => setOpen(false) }))
}

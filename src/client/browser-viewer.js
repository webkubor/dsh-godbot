import { Fragment, createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './chat-ui.js'
import { NativeCrewModal } from './modal.js'
import { BrowserTeachingPanel } from './browser-teaching.js'
import style from './browser-viewer.css'

const surfaceNames = { local: '服务器浏览器', container: '独立容器', cloud: '云端容器' }
const button = (label, onClick, disabled = false, primary = false) =>
  h('button', { type: 'button', className: primary ? 'gb-modal-primary' : undefined, onClick, disabled }, label)
const remoteKeys = new Set(['Enter', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape'])

function BrowserPanel({ client, bot, sessionId, close }) {
  const lease = useRef()
  const alive = useRef(false)
  const [available, setAvailable] = useState([])
  const [target, setTarget] = useState('local')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [frame, setFrame] = useState()
  const [surface, setSurface] = useState('browser')
  const [input, setInput] = useState('')
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const call = useCallback((action, values) => client.dispatch({ action: 'browser.' + action, botId: bot.id, sessionId, ...values }), [client, bot.id, sessionId])
  useEffect(() => {
    alive.current = true
    call('status').then(value => {
      if (!alive.current) return
      setAvailable(value.targets)
      setTarget(value.target)
      setOpen(value.open)
    }, e => { if (alive.current) setError(e.message) })
    return () => {
      alive.current = false
      if (lease.current) void call('release', { lease: lease.current }).catch(() => {})
      lease.current = undefined
    }
  }, [call])
  useEffect(() => {
    if (!open) return
    let stop = false, timer
    async function poll() {
      try {
        const sentLease = lease.current
        const value = await call('frame', { lease: sentLease, surface })
        if (!stop) {
          setFrame(value)
          if (lease.current === sentLease && value.control !== 'mine' && value.control !== 'pending') lease.current = undefined
        }
      } catch (e) {
        if (!stop && !e.message.includes('页面正在切换')) {
          setError(e.message)
          setFrame(undefined)
          setOpen(false)
          lease.current = undefined
          return
        }
      }
      if (!stop) timer = setTimeout(poll, 550)
    }
    void poll()
    return () => { stop = true; clearTimeout(timer) }
  }, [open, call, surface])
  const perform = async work => {
    setBusy(true); setError('')
    try { await work() } catch (e) { if (alive.current) setError(e.message) }
    finally { if (alive.current) setBusy(false) }
  }
  const controllable = frame?.control === 'mine' && lease.current && !busy
  const send = (data, afterSend) => perform(async () => {
    await call('input', { lease: lease.current, frameId: frame.frameId, surface: frame.surface, ...data })
    afterSend?.()
  })
  const openEnvironment = () => perform(async () => {
    await call('open', { target })
    if (alive.current) setOpen(true)
  })
  const closeEnvironment = () => perform(async () => {
    await call('close', { lease: lease.current })
    lease.current = undefined
    setOpen(false)
    setFrame(undefined)
  })
  const takeControl = () => perform(async () => {
    const value = await call('take')
    lease.current = value.lease
  })
  const releaseControl = () => perform(async () => {
    await call('release', { lease: lease.current })
    lease.current = undefined
  })
  const state = {
    mine: '你正在控制',
    other: '另一个页面正在控制',
    pending: '等待当前 Bot 操作结束',
    handoff: 'Bot 请求你接手',
    agent: frame?.expired ? '接管已过期，Bot 可继续' : 'Bot 可操作',
  }
  const frameTitle = frame?.title || frame?.url
  return h(NativeCrewModal,
    {
      title: bot.name + ' 的网页浏览器', close, closeLabel: '关闭面板', wide: true,
      headerAside: frame && h('span', { className: 'gb-browser-status', role: 'status' }, state[frame.control]),
    },
    h('style', null, style),
    error && h('p', { className: 'gb-modal-note', role: 'alert' }, error),
    !open && h('div', { className: 'gb-modal-actions' },
      h('select', {
        'aria-label': '浏览器执行环境', value: target, disabled: busy || !available.length,
        onChange: e => setTarget(e.target.value),
      }, available.map(value => h('option', { key: value, value }, surfaceNames[value]))),
      button('打开执行环境', openEnvironment, busy || !available.length, true)),
    open && h('div', { className: 'gb-browser-viewer' },
      h('div', { className: 'gb-modal-actions' },
        h('span', { className: 'gb-browser-title', title: frameTitle }, frameTitle || '正在读取画面'),
        ['container', 'cloud'].includes(target) && h('select', {
          'aria-label': '远程视图', value: surface,
          onChange(e) {
            setFrame(undefined)
            setSurface(e.target.value)
          },
        }, h('option', { value: 'browser' }, '网页'), h('option', { value: 'desktop' }, '完整桌面')),
        lease.current
          ? button('交还给 Bot', releaseControl, busy)
          : button('接管网页', takeControl, busy || !frame || frame.control === 'other', true),
        button('关闭执行环境', closeEnvironment, busy || frame?.control === 'other')),
      frame && h('img', {
        src: 'data:image/jpeg;base64,' + frame.data, alt: frame.surface === 'desktop' ? '实时桌面画面' : '实时浏览器画面',
        draggable: false, className: 'gb-browser-frame', 'data-controllable': controllable ? '' : undefined,
        tabIndex: controllable ? 0 : -1,
        onClick(e) {
          if (!controllable) return
          const rect = e.currentTarget.getBoundingClientRect()
          e.currentTarget.focus()
          void send({ kind: 'click', x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height })
        },
        onKeyDown(e) {
          if (!controllable || e.ctrlKey || e.metaKey || e.altKey || !remoteKeys.has(e.key)) return
          e.preventDefault()
          void send({ kind: 'key', key: e.key })
        },
        onWheel(e) {
          if (controllable) void send({ kind: 'scroll', delta: Math.max(-1200, Math.min(1200, e.deltaY)) })
        },
      }),
      frame?.control === 'mine' && h('div', { className: 'gb-browser-inputs' },
        frame.surface === 'browser' && h('input', {
          type: 'url', 'aria-label': '网页地址', placeholder: 'https://', value: address, onChange: e => setAddress(e.target.value),
        }),
        frame.surface === 'browser' && button('打开地址', () => send({ kind: 'navigate', url: address }), !controllable || !address),
        h('input', {
          type: 'password', autoComplete: 'off', 'aria-label': '输入到当前网页的内容', value: input, onChange: e => setInput(e.target.value),
        }),
        button('输入到网页', () => send({ kind: 'text', text: input }, () => setInput('')), !controllable || !input))),
    h(BrowserTeachingPanel, { call, lease: lease.current, canRecord: Boolean(controllable && frame.surface === 'browser'), recording: frame?.recording }))
}

export function WebBrowserButton({ client, bot, sessionId }) {
  const [shown, setShown] = useState(false)
  return h(Fragment, null,
    h('button', { type: 'button', className: 'bt-icon-btn bt-head-search', 'aria-label': '打开网页浏览器', title: '打开网页浏览器', onClick: () => setShown(true) }, h(Icon, { name: 'monitor', size: 17 })),
    shown && h(BrowserPanel, { client, bot, sessionId, close: () => setShown(false) }))
}

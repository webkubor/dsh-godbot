import { Fragment, createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NativeCrewModal } from './modal.js'
import { Icon } from './chat-ui.js'
import { MachineConfirmation } from './machine-confirm.js'
import { MachineTerminal } from './machine-terminal.js'
import { MachineDesktop } from './machine-desktop.js'
import { m } from './machine-copy.js'
import style from './remote-computers.css'

const button = (label, fn, options = {}) => h('button', { type: 'button', onClick: fn, ...options }, label)
const message = (e) => e?.message || String(e)
const unpaired = (reason) => /NOT_PAIRED|DEVICE_REVOKED|not paired/i.test(reason)
function endMessage(reason) {
  if (unpaired(reason) || reason === 'revoked') return m('Access ended by the computer')
  if (reason === 'denied') return m('Request declined on the computer')
  if (reason === 'local_management') return m('Sharing paused for a private prompt')
  if (/^(expired|disconnected|host_stopped)$|transport closed|desktop connection ended/i.test(reason))
    return m('Connection lost')
  return m(reason)
}
const uuid = () => globalThis.crypto.randomUUID()
const initial = {
  machines: [],
  target: null,
  hello: null,
  session: null,
  status: '',
  recovery: null,
  busy: false,
  pairing: false,
  confirm: null,
}

function MachineDrawer({ children, close }) {
  const drawer = useRef(null)
  useLayoutEffect(() => {
    const node = drawer.current
    node.showModal()
    return () => node.close()
  }, [])
  return h(
    'dialog',
    {
      ref: drawer,
      className: 'gb-machine-drawer',
      'aria-label': m('Computers'),
      onCancel: (event) => {
        event.preventDefault()
        event.stopPropagation()
        close()
      },
    },
    children,
    button(m('Close'), close),
  )
}

function Computers({ client, close }) {
  const [view, setView] = useState(initial),
    [offer, setOffer] = useState(''),
    [review, setReview] = useState(null)
  const [viewId] = useState(uuid)
  const [relayOnly, setRelayOnly] = useState(false)
  const [drawer, setDrawer] = useState(false)
  const heading = useRef(null)
  const live = useRef(true),
    current = useRef(view),
    run = useRef(0)
  const update = useCallback((patch) => {
    if (!live.current) return
    current.current = { ...current.current, ...patch }
    setView(current.current)
  }, [])
  const local = useCallback(
    (action, params = {}) => client.machine({ viewId, action, ...params }),
    [client, viewId],
  )
  const refresh = useCallback(async () => {
    const machines = await local('list')
    update({ machines })
  }, [local, update])
  useEffect(() => {
    live.current = true
    void refresh().catch((e) => update({ status: message(e) }))
    return () => {
      live.current = false
      run.current++
      void local('leave').catch(() => {})
    }
  }, [refresh, local, update])
  const drop = useCallback(
    async (status = m('Session ended'), recovery = null) => {
      ++run.current
      const { target, session } = current.current
      update({ session: null, status, recovery, confirm: null, busy: false })
      if (session && session.state !== 'exited' && target)
        await local('rpc', {
          id: target.id,
          method: 'session.close',
          params: { sessionId: session.sessionId },
        }).catch(() => {})
    },
    [local, update],
  )
  useEffect(() => {
    const suspend = () => {
      if (document.hidden) {
        void drop(m('Session ended when this tab went into the background'))
        void local('leave').catch(() => {})
        update({ hello: null, busy: false })
      }
    }
    const leave = () => {
      void local('leave').catch(() => {})
    }
    document.addEventListener('visibilitychange', suspend)
    window.addEventListener('pagehide', leave)
    return () => {
      document.removeEventListener('visibilitychange', suspend)
      window.removeEventListener('pagehide', leave)
    }
  }, [drop, local, update])
  const id = view.target?.id,
    sid = view.session?.sessionId
  const rpc = useCallback(
    (method, params = {}) => local('rpc', { id, method, params: { ...params, sessionId: sid } }),
    [local, id, sid],
  )
  const failed = useCallback(
    (reason) => {
      if (current.current.session?.sessionId === sid && current.current.session.state !== 'exited') {
        const mode = current.current.session.mode
        update({ hello: null })
        void drop(endMessage(reason), { mode, reason, unpaired: unpaired(reason) })
      }
    },
    [drop, sid, update],
  )
  const shellExited = useCallback(
    (exitCode) => {
      const session = current.current.session
      if (!session || session.sessionId !== sid) return
      update({ session: { ...session, state: 'exited', exitCode } })
      void rpc('session.close').catch(() => {})
    },
    [rpc, sid, update],
  )
  const exited = view.session?.state === 'exited'
  useEffect(() => {
    if (!sid || exited) return
    let active = true,
      timer
    async function heartbeat() {
      try {
        if (document.hidden) return
        const status = await rpc('session.renew')
        if (!active || current.current.session?.state === 'exited') return
        if (status.state === 'closed' || status.state === 'denied') {
          failed(status.reason || 'Access ended by the computer')
          return
        }
        if (status.state)
          update({ session: { ...current.current.session, ...status, controlPending: !!status.controlPending } })
        timer = setTimeout(heartbeat, 1300)
      } catch (e) {
        if (active) failed(message(e))
      }
    }
    timer = setTimeout(heartbeat, 900)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [sid, exited, rpc, failed, update])
  useEffect(() => {
    if (!view.pairing) heading.current?.focus()
  }, [id, view.pairing])
  async function work(fn) {
    if (current.current.busy) return
    const token = ++run.current
    const still = () => live.current && token === run.current
    update({ busy: true, status: '', confirm: null })
    try {
      await fn(still)
    } catch (e) {
      if (still()) update({ status: endMessage(message(e)) })
    } finally {
      if (still()) update({ busy: false })
    }
  }
  async function connect(machine) {
    await drop('')
    setDrawer(false)
    update({ target: machine, hello: null, pairing: false })
    await work(async (still) => {
      let hello
      try {
        hello = await local('connect', { id: machine.id })
      } catch (error) {
        if (still() && unpaired(message(error))) update({ recovery: { unpaired: true } })
        throw error
      }
      if (still()) update({ hello })
      await refresh()
    })
  }
  async function pair() {
    await work(async (still) => {
      let result
      try {
        result = await local('pair', { offer })
      } catch (error) {
        if (still() && /NOT_PAIRED|not paired|offer expired|offer has been used/i.test(message(error))) {
          setReview(null)
          setOffer('')
          throw new Error(m('Get a new offer on the computer'))
        }
        throw error
      }
      if (!still()) return
      setOffer('')
      setReview(null)
      update({ target: result.machine, hello: result.hello, pairing: false })
      await refresh()
    })
  }
  function pairPage() {
    setDrawer(false)
    setOffer('')
    setReview(null)
    update({ pairing: true, status: '', recovery: null, confirm: null })
  }
  async function start(mode, reconnect = false) {
    await work(async (still) => {
      const account = current.current.hello?.account
      const params = { mode, requestId: uuid() }
      const open = () => local('rpc', { id, method: 'session.open', params, reportConnectionRequired: true })
      async function reconnectHost() {
        update({ hello: null, recovery: { mode, reason: 'disconnected' } })
        let hello
        try {
          hello = await local('connect', { id })
        } catch (error) {
          if (still() && unpaired(message(error))) update({ recovery: { unpaired: true } })
          throw error
        }
        if (!still()) return false
        update({ hello, recovery: null })
        void refresh().catch(() => {})
        // If the shell account changed, show the new account for confirmation.
        return hello[mode] && (mode !== 'terminal' || hello.account === account)
      }
      if (reconnect && !(await reconnectHost())) return
      let result = await open()
      if (!reconnect && result.connectionRequired && still()) {
        if (!(await reconnectHost())) return
        result = await open()
      }
      if (result.connectionRequired) {
        if (still()) update({ hello: null, recovery: { mode, reason: 'disconnected' }, status: m('Connection lost') })
        return
      }
      const { session } = result
      if (!still()) {
        await local('rpc', { id, method: 'session.close', params: { sessionId: session.sessionId } }).catch(
          () => {},
        )
        return
      }
      if (['denied', 'closed'].includes(session.state))
        throw new Error(session.reason || 'Access denied by the computer')
      update({ session, status: '', recovery: null })
    })
  }
  function confirm(text, fn) {
    update({ confirm: { text, fn } })
  }
  function switchMachine(machine) {
    setDrawer(false)
    if (id === machine.id && view.hello && !view.pairing) return
    if (view.session && !exited)
      confirm(
        view.session.mode === 'terminal'
          ? m('End the shell as {account} on {name} and switch computers?', {
              account: view.hello?.account,
              name: view.target.name,
            })
          : m('End this session and switch computers?'),
        () => connect(machine),
      )
    else void connect(machine)
  }
  function add() {
    setDrawer(false)
    if (view.session && !exited)
      confirm(m('End this session and pair another computer?'), async () => {
        await drop('')
        pairPage()
      })
    else pairPage()
  }
  async function forget() {
    await drop('')
    await work(async (still) => {
      await local('forget', { id })
      if (still()) update({ target: null, hello: null })
      await refresh()
    })
  }
  async function control() {
    await work(async (still) => {
      const s = await rpc(
        view.session.control || view.session.controlPending ? 'desktop.releaseControl' : 'desktop.requestControl',
      )
      if (still()) update({ session: { ...current.current.session, ...s, controlPending: !!s.controlPending } })
    })
  }
  const busy = view.busy,
    machine = view.machines.find((item) => item.id === id) || view.target,
    hello = view.hello,
    session = view.session
  function pairing() {
    return h(
      'section',
      { className: 'gb-machine-form' },
      h('h3', null, review ? m('Trust this computer?') : m('Pair a computer')),
      review
        ? h(
            Fragment,
            null,
            h('p', null, review.name),
            h('p', null, review.server),
            h('p', null, m('Compare this fingerprint on the computer: '), h('code', null, review.fingerprint)),
          )
        : h(
            Fragment,
            null,
            h('p', null, m('Create a pairing offer in NativeCrew Computer Host on the target, then paste it here.')),
            h(
              'label',
              null,
              m('Pairing offer'),
              h('input', {
                type: 'password',
                value: offer,
                onChange: (e) => setOffer(e.target.value),
                autoComplete: 'off',
                spellCheck: false,
                placeholder: 'godbot://computer-pair?…',
              }),
            ),
          ),
      h(
        'div',
        { className: 'gb-machine-buttons' },
        button(
          m('Cancel'),
          () => {
            if (busy && review) return
            setOffer('')
            setReview(null)
            ++run.current
            update({ pairing: false, status: '', busy: false })
          },
          { disabled: busy && !!review },
        ),
        button(
          review ? m('Pair computer') : m('Review offer'),
          review
            ? pair
            : () =>
                void work(async (still) => {
                  const r = await local('inspect', { offer })
                  if (still()) setReview(r)
                }),
          { className: 'gb-machine-primary', disabled: busy || !offer.trim() },
        ),
      ),
    )
  }
  function machineDetails() {
    return h(
      'details',
      null,
      h('summary', null, m('Computer details')),
      h('p', null, machine.server),
      h('p', null, m('Host fingerprint') + ' · ', machine.fingerprint),
      machine.lastSeen && h('p', null, m('Last connected') + ' · ' + new Date(machine.lastSeen).toLocaleString()),
      h('p', null, m('To revoke this controller, remove it from Paired controllers on the computer.')),
      h(
        'label',
        null,
        h('input', { type: 'checkbox', checked: relayOnly, onChange: (e) => setRelayOnly(e.target.checked) }),
        ' ' + m('Require TURN for desktop video'),
      ),
      h(
        'div',
        null,
        button(m('Forget computer'), () =>
          confirm(m('Forget {name} on this controller?', { name: machine.name }), forget),
        ),
      ),
    )
  }
  function sessionPane() {
    if (!hello)
      return h(
        'section',
        { className: 'gb-machine-empty' },
        h(
          'p',
          null,
          busy
            ? m('Connecting to {name}…', { name: machine.name })
            : m('Check availability to see the modes supported by this host.'),
        ),
        busy
          ? button(m('Cancel'), () => {
              void drop(m('Request canceled'))
              void local('leave').catch(() => {})
            })
          : view.recovery?.unpaired
            ? button(m('Pair again'), pairPage, { disabled: busy })
            : view.recovery?.mode === 'desktop'
              ? button(m('Retry desktop'), () => start('desktop', true), { disabled: busy })
              : button(m(view.recovery ? 'Reconnect' : 'Check availability'), () => connect(machine), {
                  disabled: busy,
                }),
        view.recovery?.reason &&
          h(
            'details',
            null,
            h('summary', null, m('Session details')),
            h('p', null, endMessage(view.recovery.reason)),
          ),
        machineDetails(),
      )
    if (!session)
      return h(
        'section',
        { className: 'gb-machine-ready' },
        h('h4', null, m('Available sessions')),
        button(m('Check again'), () => connect(machine), { disabled: busy }),
        h(
          'div',
          { className: 'gb-machine-cards' },
          h(
            'div',
            null,
            h(Icon, { name: 'monitor', size: 24 }),
            h('h4', null, m('Desktop')),
            h(
              'p',
              null,
              hello.desktop
                ? m('View the selected display. Request keyboard and pointer access during the session.')
                : m(hello.desktopReason || 'No graphical session'),
            ),
            button(m('View desktop'), () => start('desktop'), {
              disabled: busy || !hello.desktop,
              className: 'gb-machine-primary',
            }),
          ),
          h(
            'div',
            null,
            h(Icon, { name: 'terminal', size: 24 }),
            h('h4', null, m('Terminal')),
            h(
              'p',
              null,
              hello.terminal
                ? m('Interactive shell as {account}', { account: hello.account })
                : m('Terminal access is unavailable.'),
            ),
            button(
              m('Open terminal'),
              () =>
                confirm(
                  m('Open a shell as {account} on {name}?', { account: hello.account, name: machine.name }),
                  () => start('terminal'),
                ),
              { disabled: busy || !hello.terminal },
            ),
          ),
        ),
        machineDetails(),
      )
    if (session.state === 'pending')
      return h(
        'section',
        { className: 'gb-machine-empty', role: 'status' },
        h('h4', null, m('Waiting for approval on {name}', { name: machine.name })),
        button(m('Cancel request'), () => void drop(m('Request canceled'))),
      )
    if (session.mode === 'terminal')
      return h(
        Fragment,
        null,
        h(
          'div',
          { className: 'gb-machine-bar' },
          h('strong', null, m('Terminal')),
          h('span', null, hello.account),
        ),
        h(MachineTerminal, { key: sid, rpc, onEnd: failed, onExit: shellExited }),
        exited &&
          h(
            'div',
            { className: 'gb-machine-bar' },
            h(
              'strong',
              { role: 'status' },
              m('Shell ended · exit {code}', { code: session.exitCode ?? m('Unknown') }),
            ),
            button(
              m('Open new terminal'),
              () =>
                confirm(
                  m('Open a shell as {account} on {name}?', { account: hello.account, name: machine.name }),
                  () => start('terminal'),
                ),
              { disabled: busy },
            ),
          ),
      )
    return h(MachineDesktop, {
      key: sid,
      rpc,
      session,
      onEnd: failed,
      control: session.control,
      requestControl: control,
      canControl: hello.control,
      targetName: machine.name,
      disconnect: () => void drop(),
      permissionHint:
        hello.os === 'macOS'
          ? m('Allow Accessibility on {name} to control the desktop.', { name: machine.name })
          : null,
      relayOnly,
    })
  }
  const askClose = () => {
    if (session && !exited) confirm(m('Disconnect and close Remote computers?'), close)
    else close()
  }
  const savedList = () =>
    h(
      'nav',
      { className: 'gb-machine-list', 'aria-label': m('Saved computers') },
      h(
        'div',
        { className: 'gb-machine-list-title' },
        h('strong', null, m('Computers')),
        button('+', add, { title: m('Pair computer'), 'aria-label': m('Pair computer'), disabled: busy }),
      ),
      view.machines.map((item) => {
        const currentHello = id === item.id && !view.pairing ? hello : null
        const facts = currentHello || item
        const modes = [facts.desktop && m('Desktop'), facts.terminal && m('Terminal')].filter(Boolean)
        const reachability =
          currentHello && session && !exited
            ? m('Connected')
            : item.lastSeen
              ? m('Last connected') + ' · ' + new Date(item.lastSeen).toLocaleString()
              : m('Check availability')
        return h(
          'button',
          {
            key: item.id,
            className: id === item.id ? 'selected' : '',
            'aria-current': id === item.id ? 'true' : undefined,
            disabled: busy,
            onClick: () => switchMachine(item),
          },
          h(Icon, { name: 'monitor' }),
          h(
            'span',
            null,
            h('strong', null, item.name || item.id),
            h('small', null, [item.os, ...modes].filter(Boolean).join(' · ')),
            h('small', null, reachability),
          ),
        )
      }),
    )
  return h(
    NativeCrewModal,
    { title: m('Remote computers'), wide: true, close: askClose },
    h('style', null, style),
    h(
      'div',
      { className: 'gb-machines' },
      h('div', { className: 'gb-machine-wide-nav' }, savedList()),
      h(
        'div',
        { className: 'gb-machine-compact-nav' },
        button(m('Computers'), () => setDrawer(true), {
          'aria-expanded': drawer,
          'aria-haspopup': 'dialog',
        }),
      ),
      drawer && h(MachineDrawer, { close: () => setDrawer(false) }, savedList()),
      h(
        'div',
        { className: 'gb-machine-work' },
        view.confirm &&
          h(MachineConfirmation, {
            text: view.confirm.text,
            cancel: () => update({ confirm: null }),
            confirm: () => {
              const fn = view.confirm.fn
              update({ confirm: null })
              void fn()
            },
          }),
        view.status && h('div', { className: 'gb-machine-status', role: 'status' }, m(view.status)),
        view.pairing
          ? pairing()
          : !machine
            ? h(
                'section',
                { className: 'gb-machine-empty' },
                h(Icon, { name: 'monitor', size: 36 }),
                h(
                  'h3',
                  { tabIndex: -1, ref: heading },
                  view.machines.length ? m('Select a computer') : m('Pair your first computer'),
                ),
                h('p', null, m('View a desktop or open a terminal on a paired Mac or Linux computer.')),
                button(m('Pair computer'), add, { className: 'gb-machine-primary' }),
              )
            : h(
                Fragment,
                null,
                h(
                  'div',
                  { className: 'gb-machine-title' },
                  h(
                    'div',
                    null,
                    h('h3', { tabIndex: -1, ref: heading }, machine.name || m('Computer')),
                    h(
                      'small',
                      null,
                      [
                        hello?.os || machine.os,
                        hello?.account || machine.account,
                        hello && session && !exited
                          ? m('Connected')
                          : hello
                            ? m('Available at last check')
                            : m('Saved computer'),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  session && button(exited ? m('Back to computer') : m('Disconnect'), () => void drop('')),
                ),
                session &&
                  hello &&
                  h(
                    'nav',
                    { className: 'gb-machine-modes', 'aria-label': m('Available sessions') },
                    ['desktop', 'terminal'].map((mode) =>
                      h(
                        'button',
                        {
                          key: mode,
                          type: 'button',
                          'aria-pressed': session.mode === mode,
                          disabled: busy || !hello[mode],
                          onClick: () => {
                            if (session.mode === mode) return
                            const title =
                              mode === 'terminal'
                                ? m('Switch to a shell as {account} on {name}?', {
                                    account: hello.account,
                                    name: machine.name,
                                  })
                                : m('End this shell and open the desktop?')
                            confirm(title, async () => {
                              await drop('')
                              await start(mode)
                            })
                          },
                        },
                        h(Icon, { name: mode === 'terminal' ? 'terminal' : 'monitor', size: 15 }),
                        m(mode === 'terminal' ? 'Terminal' : 'Desktop'),
                      ),
                    ),
                  ),
                sessionPane(),
              ),
      ),
    ),
  )
}
export function RemoteComputersButton({ client }) {
  const [open, setOpen] = useState(false)
  return h(
    Fragment,
    null,
    button(
      h(Icon, { name: 'monitor', size: 17 }),
      () => setOpen(true),
      {
        className: 'gb-workspace-action',
        title: m('Remote computers'),
        'aria-label': m('Remote computers'),
        'aria-haspopup': 'dialog',
      },
    ),
    open && h(Computers, { client, close: () => setOpen(false) }),
  )
}

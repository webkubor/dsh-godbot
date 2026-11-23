import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './chat-ui.js'
import { installGuide, providerRows, signInLabels } from './provider-agents-model.js'
import { AccountUsage, UsageOverview, ProviderUsageSummary, useLocalConsumption } from './provider-agents-usage.js'
import { usageDetail } from './provider-usage-model.js'
import style from './provider-agents.css'

const changedEvent = 'godbot:sandbox-settings-changed'
const errorText = error => error?.message || String(error)

function Button({ children, ...props }) {
  return h('button', { type:'button', className:'bt-soft bt-soft-sm', ...props }, children)
}

function LoginCommand({ value, opened }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  return h('div', { className:'gb-pr-commands' },
    h('span', { className:'gb-pr-hint', role:'status' }, opened ? '已打开宿主终端，请完成登录后核验身份。' : '在运行 NativeCrew Host 的交互终端登录'),
    h('code', { 'data-account-login-command':true }, value),
    h('div', { className:'gb-pr-actions' }, h(Button, { onClick:async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); setError('') }
      catch { setError('请选中上方命令并复制。') }
    } }, copied ? '已复制' : '复制命令'), error && h('small', { role:'status' }, error)))
}

function AccountRow({ account, provider, kind, change, busy, readOnly, usageProps }) {
  const [editing, setEditing] = useState(false)
  const [alias, setAlias] = useState('')
  const [login, setLogin] = useState(null)
  const [removing, setRemoving] = useState(false)
  const current = provider.defaultAvailable !== false && account.id === provider.defaultAccountId
  const identity = account.identity ?? {}
  const available = account.available !== false
  const checked = identity.checkedAt && new Date(identity.checkedAt)
  const caption = account.local ? '本机' : account.slotName
  const status = signInLabels[identity.status] ?? '尚未核验'
  const act = (verb, args) => change('provider-account-' + verb, { kind, accountId:account.id, ...args })
  const button = (action, label, onClick, disabled) =>
    h(Button, { 'data-account-action':action, disabled:busy || readOnly || disabled, onClick }, label)
  return h('article', { className:'gb-pr-account','data-account-id':account.id ?? 'local','data-account-default':String(current) },
    h('div', { className:'gb-pr-account-head' },
      h('div', { className:'gb-pr-copy' }, h('strong', null, account.name || caption),
        h('small', { 'data-account-identity':true }, [status,
          identity.email && identity.email !== account.name && identity.email,
          account.local && !available && '本机未检测到 CLI'].filter(Boolean).join(' · '))),
      current ? h('span', { className:'gb-pr-default' }, '默认账号') :
        button('default','设为默认', () => act('default'), !available)),
    h('div', { className:'gb-pr-actions' },
      button('check','核验身份', () => act('check'), !available),
      identity.status !== 'signed-in' && button('login','登录', async () => {
        const answer = await act('login',{ open:true }); if (answer) setLogin(answer)
      }, !available)),
    h('details', { className:'gb-pr-more' },
      h('summary', { 'data-account-action':'more' }, '更多操作'),
      h('div', { className:'gb-pr-extra' },
        !account.local && h('small', { className:'gb-pr-muted' }, ['隔离环境',caption,account.id].filter(Boolean).join(' · ')),
        checked && !Number.isNaN(checked.getTime()) && h('small', { className:'gb-pr-muted' }, '上次核验 · ' + checked.toLocaleString()),
        h('div', { className:'gb-pr-actions' },
          button('login-command','查看登录命令', async () => { const answer = await act('login'); if (answer) setLogin(answer) }, !available),
          identity.status === 'signed-in' && button('login','重新登录', async () => {
            const answer = await act('login',{ open:true }); if (answer) setLogin(answer)
          }, !available),
          !editing && button('edit','编辑名称', () => { setAlias(account.customName ?? ''); setEditing(true) }),
          !account.local && !removing && button('remove','移出账号列表', () => setRemoving(true))),
        removing && h('div', { className:'gb-pr-extra' },
          h('small', { className:'gb-pr-muted' }, '从此提供商的账号列表移出。沙箱登录和已有 Bot 会话会保留。'),
          h('div', { className:'gb-pr-actions' }, button('remove-confirm','确认移出', () => act('remove')),
            h(Button, { disabled:busy, onClick:() => setRemoving(false) }, '取消'))),
        editing && h('form', { className:'gb-pr-edit', onSubmit:async e => {
          e.preventDefault()
          if (await act('save', { name:alias.trim() })) setEditing(false)
        } }, h('label', null, '账号名称', h('input', { className:'bt-input', autoFocus:true, name:'accountAlias', value:alias,
          maxLength:120,placeholder:account.slotName || account.name, disabled:busy, onChange:e => setAlias(e.target.value) })),
        h('button', { type:'submit', className:'bt-send bt-soft-sm', 'data-account-action':'save', disabled:busy || readOnly }, '保存'),
        h(Button, { onClick:() => setEditing(false), disabled:busy }, '取消')),
        account.workspaces?.length > 0 && h('div', { className:'gb-pr-paths' }, h('strong', null, '已授权目录'),
          account.workspaces.map(folder => h('div', { key:folder.hostPath },
            h('code', null, folder.hostPath), h('small', { className:'gb-pr-muted' }, folder.readOnly ? ' · 只读' : ' · 读写'),
            h('div', null, h('code', { className:'gb-pr-muted' }, folder.guestPath))))))),
    h(AccountUsage, { ...usageProps,accountId:account.id,disabled:!available || busy,readOnly,
      identityKey:[identity.status,identity.email,identity.checkedAt].join('|') }),
    login?.command && h(LoginCommand, { key:login.command, value:login.command, opened:login.opened }))
}

function ProviderAccounts({ row, change, busy, readOnly, enabled, usageProps }) {
  const [adding, setAdding] = useState(false)
  const [slot, setSlot] = useState('')
  const [alias,setAlias] = useState('')
  const accounts = row.accounts.accounts
  const known = accounts.filter(a => !a.removed && (a.local || a.inUse || a.managed || a.identity?.status === 'signed-in'))
  const unadded = accounts.filter(a => !known.includes(a))
  const selected = unadded.find(a => a.id === slot) ?? unadded[0]
  const environments = unadded.filter(a => !a.removed)
  const render = account => h(AccountRow, { key:account.id === null ? 'host' : 'slot-' + account.id, account,
    provider:row.accounts, kind:row.kind, change, busy, readOnly, usageProps })
  return h('section', { className:'gb-pr-section' },
    h('div', { className:'gb-pr-heading' }, h('h4', null, '运行账号'),
      !readOnly && h(Button, { 'data-agent-action':'add-account', disabled:busy || adding, onClick:() => {
        setSlot(unadded[0]?.id ?? ''); setAlias(''); setAdding(true)
      } }, '添加账号')),
    adding && h('div', { className:'bt-set-card gb-pr-box' }, selected ?
      h('form', { className:'gb-pr-edit', onSubmit:async e => {
        e.preventDefault()
        if (await change('provider-account-save',{kind:row.kind,accountId:selected.id,name:alias.trim()})) setAdding(false)
      } }, h('label', null, '隔离环境', h('select', { className:'bt-input', name:'accountSlot', value:selected.id,
        onChange:e => setSlot(e.target.value) }, unadded.map(a => h('option', { key:a.id,value:a.id }, a.slotName)))),
      h('label',null,'账号名称',h('input',{className:'bt-input',name:'accountAlias',value:alias,onChange:e=>setAlias(e.target.value),
        maxLength:120,placeholder:'可选'})),
      h('button', {type:'submit',className:'bt-send bt-soft-sm','data-account-action':'save',disabled:busy},'保存'),
      h(Button,{onClick:()=>setAdding(false),disabled:busy},'取消')) :
      h(Fragment, null, h('small',{className:'gb-pr-muted'},enabled
        ? '没有可添加的隔离环境。请先在宿主机登记一个支持此提供商的沙箱。'
        : '请先在提供商列表中启用沙箱多账号。'),
      h('div',null,h(Button,{onClick:()=>setAdding(false)},'关闭')))),
    row.accounts.defaultAvailable === false && h('p',{className:'gb-pr-hint',role:'status'},'当前默认账号已不可用，请重新选择默认账号。'),
    h('div', { className:'bt-set-card' }, known.map(render)),
    environments.length > 0 && h('details', { className:'gb-pr-missing' },
      h('summary', { 'data-agent-action':'show-environments' }, '可用隔离环境（' + environments.length + '）'),
      h('div', { className:'bt-set-card' }, environments.map(render))))

}

function ProviderDetail({ row, AgentLogo, AgentForm, back, change, customAction, busy, readOnly, refresh, enabled, client, consumption, period, setPeriod, usageError }) {
  const [command, setCommand] = useState('')
  const [editing, setEditing] = useState(false)
  const [remove, setRemove] = useState(false)
  const title = useRef(null)
  useEffect(() => { title.current?.focus() }, [])
  return h('section', { className:'gb-pr-detail', 'data-provider-detail':row.route, 'aria-label':row.name },
    h('button', { type:'button', className:'gb-pr-back', onClick:back, 'aria-label':'返回提供商列表' },
      h(Icon, { name:'back',size:15 }), '提供商列表'),
    h('div', { className:'gb-pr-title' }, h(AgentLogo, { route:row.route, name:row.name, size:36 }),
      h('h3', { ref:title, tabIndex:-1 }, row.name)),
    h(ProviderUsageSummary,{provider:consumption,period,setPeriod,usageError}),
    !row.archived && h('section', { className:'gb-pr-section' }, h('h4', null, row.custom ? '自定义 ACP' : '本机 CLI'),
      h('div', { className:'bt-set-card gb-pr-box' },
        row.custom
          ? h(Fragment, null, h('code', { className:'gb-pr-path' }, [row.command,...row.args ?? []].join(' ')),
            editing ? h(AgentForm, { initial:row, close:() => setEditing(false),
              submit:payload => customAction('local-agent-update', { id:row.id, ...payload }) })
              : h('div', { className:'gb-pr-actions' }, h(Button, { 'data-agent-action':'edit-custom', disabled:busy || readOnly, onClick:() => setEditing(true) }, '编辑'),
                h(Button, { 'data-agent-action':'remove-custom', disabled:busy || readOnly, onClick:async () => {
                  if (!remove) return setRemove(true)
                  if (await change('remove-custom', { id:row.id })) back()
                } }, remove ? '确认移除' : '移除'), remove && h(Button, { onClick:() => setRemove(false) }, '取消')))
          : h(Fragment, null,
            h('div', { className:'gb-pr-inline' }, h('strong', null, row.installed ? '已检测到' : '未检测到'),
              row.version && h('span', { className:'gb-pr-muted' }, row.version)),
            h('code', { className:'gb-pr-path' }, row.path || row.command),
            !row.installed && h('div', { className:'gb-pr-hint' }, '安装 CLI 后刷新，即可在本机使用。 ',
              h('a', { href:installGuide(row.kind),target:'_blank',rel:'noreferrer' }, row.kind ? '安装指南' : '查看 ACP 安装目录')),
            h('div', { className:'gb-pr-actions' }, h(Button, { 'data-agent-action':'refresh', disabled:busy, onClick:refresh }, '刷新检测'),
              !row.accounts && row.installed && row.signIn && row.signedIn !== true &&
                h(Button, { onClick:() => setCommand(row.signIn) }, '登录')),
            typeof row.signedIn === 'boolean' && h('span', { className:'gb-pr-muted' }, row.signedIn ? 'CLI 已登录' : 'CLI 未登录'),
            command && h(LoginCommand, { value:command })))),
    row.accounts ? h(ProviderAccounts, { row, change, busy, readOnly, enabled, usageProps:{client,route:row.route,consumption,period} }) :
      h(AccountUsage, {client,route:row.route,accountId:null,consumption,period,disabled:!row.installed,readOnly}),
    h(ProviderUsageSummary,{provider:consumption,period,history:true,accountList:row.accounts?.accounts ?? []}))
}

function ProviderList({ rows, AgentLogo, select, focusRoute }) {
  return h('ul', { className:'bt-set-card gb-pr-list' }, rows.map(row => {
    const accounts = row.accounts
    const preferred = accounts?.defaultAvailable !== false && accounts?.accounts.find(a => a.id === accounts.defaultAccountId)
    const subtitle = preferred?.id ? '首选 · ' + preferred.name
      : preferred?.identity?.email || row.path || (row.custom ? row.command : '本机未检测到 CLI')
    const state = typeof row.signedIn === 'boolean' ? (row.signedIn ? '本机已登录' : '本机未登录') : ''
    const version = String(row.version ?? '').replace(/\s*\([^)]*\)\s*$/u, '').trim()
    return h('li', { key:row.route }, h('button', { type:'button', className:'gb-pr-row', 'data-provider-route':row.route,
      ref:el => { if (el && focusRoute.current === row.route) { el.focus(); focusRoute.current = null } }, onClick:() => select(row.route) },
      h(AgentLogo, { route:row.route, name:row.name, size:30 }),
      h('span', { className:'gb-pr-copy' }, h('span', {className:'gb-pr-name'}, row.name,
        version && h('small',{className:'gb-pr-version'},version)), h('small', {className:'gb-pr-subtitle',title:subtitle},subtitle)),
      h('span', { className:'gb-pr-row-end' }, row.accountCount ? row.accountCount + ' 个隔离账号' : state,
        h('span', { 'aria-hidden':true }, '›'))))
  }))
}

export function ProviderAgentsPage({ client, call, builtins, AgentLogo, AgentForm, readOnly }) {
  const [view, setView] = useState(null)
  const [catalog, setCatalog] = useState(null)
  const [route, setRoute] = useState('')
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [section,setSection] = useState('providers')
  const [period,setPeriod] = useState('week')
  const localUsage = useLocalConsumption(client)
  const focusRoute = useRef(null)
  const loadId = useRef(0)
  const pending = useRef(false)
  const mounted = useRef(false)
  const load = useCallback(async (scan = false) => {
    const id = ++loadId.current
    setLoading(true)
    const [agents, accounts] = await Promise.allSettled([call(scan ? 'local-agent-refresh' : 'local-agents'), client.dispatch({ action:'provider-accounts' })])
    if (!mounted.current || id !== loadId.current) return
    if (agents.status === 'fulfilled') setView(agents.value)
    if (accounts.status === 'fulfilled') setCatalog(accounts.value)
    setError([agents,accounts].filter(res => res.status === 'rejected').map(res => errorText(res.reason)).join(' · '))
    setLoading(false)
  }, [client, call])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => { mounted.current = false; loadId.current++ }
  }, [load])
  async function customAction(endpoint, payload) {
    await call(endpoint, payload)
    await load()
  }
  async function change(action, payload = {}) {
    if (pending.current || readOnly) return
    pending.current = true
    setBusy(true); setError('')
    try {
      if (action === 'remove-custom') {
        await customAction('local-agent-remove', payload)
        return true
      }
      const value = await client.dispatch({ action,...payload })
      if (!mounted.current) return
      if (action === 'provider-account-login') return value
      if (action === 'sandbox-settings-set') await load()
      else {
        ++loadId.current
        setCatalog(value); setLoading(false)
      }
      window.dispatchEvent(new Event(changedEvent))
      return value
    } catch (cause) {
      if (mounted.current) setError(errorText(cause))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const rows = providerRows(builtins, view, catalog)
  const consumption = localUsage.usage?.providers?.find(provider => provider.route === route)
  const current = usageDetail(route,rows,consumption)
  const filter = query.trim().toLowerCase()
  const visible = rows.filter(row => [row.name,row.route,row.command].some(text => text?.toLowerCase().includes(filter)))
  const primary = visible.filter(row => row.installed || row.isolated || row.custom || row.kind)
  const missing = visible.filter(row => !primary.includes(row))
  const back = () => { focusRoute.current = route; setRoute('') }
  const refresh = () => load(true)
  const list = choices => h(ProviderList, { rows:choices, AgentLogo, select:setRoute, focusRoute })
  return h('div', { className:'gb-providers','data-godbot-provider-agents':true },
    h('style', null, style),
    error && h('div', { role:'alert', className:'bt-error' }, error, ' ', h(Button, { onClick:() => load(), disabled:loading }, '重试')),
    !current && h('div',{className:'gb-pr-periods',role:'group','aria-label':'本地 Agent 视图'},
      ['providers','usage'].map(id=>h('button',{key:id,type:'button','data-agent-action':id,'aria-pressed':section===id,onClick:()=>setSection(id)},id==='usage'?'用量':'提供商'))),
    current ? h(ProviderDetail, { key:route,row:current, AgentLogo,AgentForm, back,change,customAction,busy:busy || loading,readOnly,refresh,
      enabled:catalog?.enabled,client,consumption,period,setPeriod,usageError:localUsage.error }) :
      section==='usage' ? h(UsageOverview,{rows,usage:localUsage,period,setPeriod,select:setRoute,client,readOnly}) :
      h(Fragment, null,
        h('div', { className:'gb-pr-heading' }, h('h3', null, '本地 Agent'),
          h('div', { className:'gb-pr-actions' }, h(Button, { 'data-agent-action':'refresh', onClick:refresh, disabled:loading || busy }, loading ? '正在检测…' : '刷新'),
            !readOnly && view?.available !== false && h(Button, { 'data-agent-action':'add-custom', onClick:() => setAdding(true), disabled:adding || busy }, '添加自定义 Agent'))),
        adding && h('div', { className:'bt-set-card gb-pr-box' }, h(AgentForm, { close:() => setAdding(false),
          submit:payload => customAction('local-agent-add',payload) })),
        h('div', { className:'gb-pr-toolbar' }, h('input', { type:'search', className:'bt-input', placeholder:'搜索提供商', 'aria-label':'搜索提供商',
          value:query, onChange:e => setQuery(e.target.value) })),
        !view && loading ? h('p', { className:'gb-pr-muted', role:'status' }, '正在读取本机 Agent…') : h(Fragment,null,
          view?.available === false && h('p', { className:'gb-pr-muted' }, '当前 DSH 无法注册本地 Agent 路由。'),
          primary.length > 0 && list(primary),
          missing.length > 0 && (filter ? list(missing) : h('details', { className:'gb-pr-missing' },
            h('summary',null,'其他内置提供商（' + missing.length + '）'),list(missing))),
          !visible.length && h('p', { className:'gb-pr-muted' }, '没有匹配的提供商。')),
        catalog && h('label', { className:'bt-set-card gb-pr-toggle' }, h('span', { className:'gb-pr-copy' },
          h('strong', null, '启用沙箱多账号'), h('small', null, '按提供商管理隔离账号和可访问的目录。')),
          h('input', { type:'checkbox',role:'switch','aria-label':'启用沙箱多账号',checked:catalog.enabled === true,
            disabled:loading || busy || readOnly,onChange:e => change('sandbox-settings-set',{enabled:e.target.checked}) }))))
}

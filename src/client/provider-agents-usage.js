import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { accountConsumption, localTime, quotaKind, quotaPercent, quotaWindowLabel, usageCount, usagePeriods, usageProviders } from './provider-usage-model.js'

const activeSources = { 'claude-usage':'Claude Code /usage', 'codex-app-server':'Codex app-server',
  'antigravity-statusline':'Antigravity 状态栏', 'gemini-cli-model':'Gemini CLI /model' }
const kindSources = { antigravity:'Antigravity',claude:'Claude Code',codex:'Codex',gemini:'Gemini CLI' }
const quotaStates = { unchecked:'尚未同步', stale:'上次读数', 'signed-out':'账号未登录', unavailable:'暂无额度数据' }
const reasonLabels = { 'not-authenticated':'请先登录当前账号，再刷新额度。', 'not-reported':'当前账号未报告可用的额度窗口。',
  'source-unavailable':'暂时无法从该账号读取额度。', unsupported:'此提供商未开放可读取的官方额度接口。',
  'identity-changed':'登录身份已变化，请刷新当前账号的额度。',expired:'上次额度读数已过期，请刷新。' }

export function useLocalConsumption(client) {
  const [usage,setUsage] = useState(null)
  const [error,setError] = useState('')
  const [loading,setLoading] = useState(false)
  const ticket = useRef(0)
  const refresh = useCallback(async (refreshHistory = false) => {
    const id = ++ticket.current
    setLoading(true)
    try {
      const deadline = Date.now() + 60000
      while (id === ticket.current) {
        const result = await client.dispatch({ action:'local-provider-usage', refreshHistory })
        if (id !== ticket.current) break
        setUsage(result); setError('')
        if (!refreshHistory || !result.historyScanning || Date.now() >= deadline) break
        await new Promise(resolve => setTimeout(resolve, 700))
      }
    } catch (cause) {
      if (id === ticket.current) setError(cause?.message ?? String(cause))
    } finally { if (id === ticket.current) setLoading(false) }
  },[client])
  useEffect(() => { void refresh(); return () => { ticket.current++ } },[refresh])
  return {usage,loading,error,refresh}
}

function PeriodSwitch({period, setPeriod}) {
  return h('div',{role:'group','aria-label':'用量统计周期',className:'gb-pr-periods'},
    Object.entries(usagePeriods).map(([key,label])=>h('button',{key,type:'button','data-usage-period':key,
      'aria-pressed':key===period,onClick:()=>setPeriod(key)},label)))
}

function Count({totals}) {
  if (!totals?.reports) return h('span',{className:'gb-pr-muted'}, totals?.unreported ? '未报告 token 数' : '暂无记录')
  return h('span',null,usageCount(totals.tokens),' token')
}

function Coverage({totals}) {
  if (!totals?.reports && !totals?.unreported) return null
  const text = []
  if (totals.reports) text.push(usageCount(totals.reports)+' 条用量记录')
  if (totals.unreported) text.push(usageCount(totals.unreported)+' 条未报告 token 数')
  return h('small',{className:'gb-pr-muted'},text.join(' · '))
}

function DailyHistory({history}) {
  if (!Array.isArray(history) || !history.some(day=>day.reports || day.unreported)) return null
  const peak = Math.max(1,...history.map(day=>day.tokens || 0))
  return h('details',null,h('summary',null,'近 7 个 UTC 日'),
    h('ol',{className:'gb-pr-days'},history.map(day=>h('li',{key:day.date},
      h('span',null,day.date.slice(5)),day.reports>0 ? h('progress',{max:peak,value:day.tokens,'aria-label':day.date+' token'}) : h('span'),
      h(Count,{totals:day})))))
}

function LocalDetail({row,period}) {
  const totals = row?.periods?.[period]
  return h('div',{className:'gb-pr-usage-local','data-godbot-account-usage':true},
    h('div',{className:'gb-pr-heading'},h('strong',null,'NativeCrew 会话用量'),h(Count,{totals})),
    (totals?.reports || totals?.unreported) > 0 && row.attribution !== 'unknown' &&
      h('small',{className:'gb-pr-muted'},'按运行环境累计。同一环境更换登录账号后，历史记录仍计入这里。'),
    h(Coverage,{totals}),h(DailyHistory,{history:row?.history}),
    totals?.reports > 0 && h('div',{className:'gb-pr-usage-numbers'},[['输入','input'],['输出','output'],['缓存读取','cacheRead'],['缓存写入','cacheWrite']].map(([label,key])=>
      h('span',{key},label+' '+usageCount(totals[key])))),
    row?.models?.some(model => model.periods?.[period]?.reports || model.periods?.[period]?.unreported) &&
      h('details',null,h('summary',null,'按模型查看'),h('ul',{className:'gb-pr-model-totals'},
        row.models.filter(m=>m.periods?.[period]?.reports || m.periods?.[period]?.unreported).map(model=>
          h('li',{key:model.model},h('span',null,model.model || '未标记模型'),h(Count,{totals:model.periods[period]}))))))
}

function QuotaWindows({snapshot}) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : []
  return h('div',{className:'gb-pr-windows'},windows.map(window=>{
    const percent = window.disabled ? undefined : quotaPercent(window)
    const hasAmount = typeof window.remainingAmount === 'number' && Number.isFinite(window.remainingAmount)
    const resets = localTime(window.resetsAt)
    const label = quotaWindowLabel(snapshot.source, window)
    return h('div',{key:window.id,className:'gb-pr-window','data-quota-window':window.id},
      h('div',{className:'gb-pr-heading'},h('span',null,label),
        h('strong',null,window.disabled ? '未启用' : percent ? percent.label+' '+usageCount(percent.value)+'%' : hasAmount ? '剩余 '+usageCount(window.remainingAmount) : '未报告比例')),
      percent && h('progress',{max:100,value:percent.value,'aria-label':label+' '+percent.label,
        'data-remaining':percent.label==='剩余' ? 'true' : undefined,
        'data-limited': (percent.label==='已用' ? percent.value>=90 : percent.value<=10) ? 'true' : undefined}),
      (resets || (hasAmount && percent)) && h('small',{className:'gb-pr-muted'},[resets && (resets+' 重置'),
        hasAmount && percent && ('剩余额度 '+usageCount(window.remainingAmount))].filter(Boolean).join(' · ')))
  }))
}

function OfficialQuota({client,kind,id,disabled,readOnly}) {
  const [snapshot,setSnapshot] = useState(null)
  const [error,setError] = useState('')
  const [pending,setPending] = useState(false)
  const [reading,setReading] = useState(false)
  const revision = useRef(0)
  const load = useCallback(async (fresh=false) => {
    const req = ++revision.current
    setPending(fresh); setReading(!fresh); setError('')
    try {
      const result = await client.dispatch({action:fresh?'provider-usage-refresh':'provider-usage',kind,accountId:id})
      if (req !== revision.current) return
      if (result?.kind !== kind || result?.accountId !== id) throw Error('额度来源与所选账号不一致。')
      setSnapshot(result)
    } catch (cause) {
      if (req === revision.current) setError(cause?.message ?? String(cause))
    } finally { if (req===revision.current) { setPending(false); setReading(false) } }
  },[client,kind,id])
  useEffect(()=>{setSnapshot(null); if (kind) void load(); return ()=>{revision.current++}},[load,kind])
  if (!kind) return h('div',{className:'gb-pr-usage-official gb-pr-muted'},'官方额度 · 暂无可读取的接口')
  const state = snapshot?.status ?? 'unchecked'
  const data = state === 'available' || state === 'stale'
  const credits = data && snapshot?.credits
  const source = activeSources[snapshot?.source] || kindSources[kind]
  const updated = localTime(snapshot?.updatedAt)
  const checked = localTime(snapshot?.checkedAt)
  return h('section',{className:'gb-pr-usage-official','data-account-quota':true,'data-quota-status':state,'aria-label':'官方额度'},
    h('div',{className:'gb-pr-heading'},h('strong',null,'官方额度',source && h('small',{className:'gb-pr-muted'},' · '+source)),
      h('button',{type:'button',className:'bt-soft bt-soft-sm','data-account-action':'refresh-usage',
        disabled:disabled || readOnly || pending || reading,onClick:()=>load(true)},pending?'正在同步…':'刷新额度')),
    snapshot?.plan && data && h('small',{className:'gb-pr-muted'},snapshot.plan),
    state!=='available' && h('small',{className:'gb-pr-muted',role:'status'},reading ? '正在读取已保存的额度…' :
      [quotaStates[state],reasonLabels[snapshot?.reason]].filter(Boolean).join(' · ')),
    data && snapshot?.windows?.length>0 && h(QuotaWindows,{snapshot}),
    credits && h('span',{className:'gb-pr-muted'},credits.unlimited ? '积分余额 · 不限量' :
      typeof credits.balance==='number' ? '积分余额 · '+usageCount(credits.balance) :
      credits.hasCredits===true ? '账号有可用积分' : credits.hasCredits===false ? '账号无可用积分' : null),
    (updated || checked) && h('small',{className:'gb-pr-muted'},
      [updated && ('上次同步 '+updated),checked && snapshot?.checkedAt !== snapshot?.updatedAt && ('最近检查 '+checked)].filter(Boolean).join(' · ')),
    error && h('small',{className:'bt-error',role:'alert'},error))
}

export function AccountUsage({client,route,accountId,consumption,period,disabled,readOnly,identityKey=''}) {
  return h('div',{className:'gb-pr-account-usage'},
    h(OfficialQuota,{key:route+':'+(accountId ?? '')+':'+identityKey,client,kind:quotaKind(route),id:accountId,disabled,readOnly}),
    h(LocalDetail,{row:accountConsumption(consumption,accountId),period}))
}

function QuotaComparison({rows,client,readOnly}) {
  const providers = rows.filter(row => quotaKind(row.route))
  const [picked,setPicked] = useState('')
  const current = providers.find(row=>row.route===picked) ?? providers.find(row=>row.accountCount || row.installed) ?? providers[0]
  if (!current) return null
  const accounts = current.accounts?.accounts.filter(a=>!a.removed && (a.local || a.managed || a.inUse || a.identity?.status==='signed-in'))
    ?? [{id:null,local:true,name:'本机',available:current.installed}]
  return h('section',{className:'gb-pr-section','data-official-quota-comparison':true},
    h('div',{className:'gb-pr-heading'},h('h3',null,'账号额度'),
      h('label',null,h('select',{name:'usageProvider',className:'bt-input','aria-label':'额度提供商',value:current.route,onChange:e=>setPicked(e.target.value)},
        providers.map(row=>h('option',{key:row.route,value:row.route},row.name))))),
    h('div',{className:'bt-set-card'},accounts.map(account=>h('div',{key:current.route+':'+account.id,
      className:'gb-pr-quota-compare','data-quota-account':account.id??'local'},h('strong',null,account.name),
      h(OfficialQuota,{key:[account.identity?.email,account.identity?.checkedAt].join('|'),client,kind:quotaKind(current.route),
        id:account.id,disabled:!account.available,readOnly})))))
}

export function UsageOverview({rows,usage,period,setPeriod,select,client,readOnly}) {
  const data = usage.usage
  const sorted = usageProviders(rows,data?.providers,period)
  return h('section',{className:'gb-pr-section','data-provider-usage-overview':true},
    h(QuotaComparison,{rows,client,readOnly}),
    h('div',{className:'gb-pr-heading'},h('h3',null,'NativeCrew 会话用量'),
      h('button',{type:'button',className:'bt-soft bt-soft-sm',onClick:()=>usage.refresh(true),disabled:usage.loading},'刷新统计')),
    h(PeriodSwitch,{period,setPeriod}),
    h('p',{className:'gb-pr-muted'},'按提供商汇总本工作台收到的 token 计数。'),
    usage.error && h('small',{className:'bt-error',role:'alert'},usage.error),
    data?.historyScanning && h('small',{className:'gb-pr-muted',role:'status'},'正在读取历史会话，当前显示已收录的记录。'),
    data?.ledgerStatus==='unavailable' && h('small',{className:'gb-pr-muted',role:'status'},'团队用量账本暂不可读，以下为当前可取得的记录。'),
    sorted.length ? h('div',{className:'bt-set-card'},sorted.map(provider=>{
      const totals=provider.periods?.[period]
      return h('button',{key:provider.route,className:'gb-pr-row gb-pr-usage-summary',type:'button','data-usage-provider':provider.route,
        onClick:()=>select(provider.route)},h('span',{className:'gb-pr-copy'},h('strong',null,provider.name),provider.archived && h('small',{className:'gb-pr-muted'},'历史提供商'),
        h(Coverage,{totals})),h(Count,{totals}),h('span',{'aria-hidden':true},'›'))
    })) : h('p',{className:'gb-pr-muted',role:'status'},usage.loading?'正在读取统计…':'暂无已记录的提供商会话。'),
    data?.asOf && h('small',{className:'gb-pr-muted'},'更新于 '+localTime(data.asOf)))
}

export function ProviderUsageSummary({provider,period,setPeriod,usageError,history=false,accountList=[]}) {
  const totals = provider?.periods?.[period]
  if (history) {
    const previous = (provider?.accounts ?? []).filter(row =>
      (row.attribution==='unknown' || (row.attribution==='sandbox' && !accountList.some(a => a.id===row.accountId && !a.removed))) &&
      (row.periods?.[period]?.reports || row.periods?.[period]?.unreported))
    return previous.length ? h('details',{className:'gb-pr-extra'},h('summary',null,'历史账号与未归属的记录'),
      previous.map(row=>h('div',{key:row.attribution+':'+row.accountId},h('strong',null,row.attribution==='unknown'?'未归属账号':row.accountId),h(LocalDetail,{row,period})))) : null
  }
  return h('div',{className:'gb-pr-section'},h('div',{className:'gb-pr-heading'},
    h('h4',null,'提供商会话用量'),h(Count,{totals})),h(PeriodSwitch,{period,setPeriod}),h(Coverage,{totals}),h(DailyHistory,{history:provider?.history}),
    usageError && h('small',{className:'bt-error',role:'alert'},usageError))
}

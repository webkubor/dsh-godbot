import { createElement as h, useEffect, useState } from 'react'
import { apply as applyBot, inject as botServices } from './team-ui/index.js'
import { earlierReports, reportSessionUsage, turnReport } from './team-report.js'
import { NativeCommandReport } from './native-command-report.js'
import { TerminalPanel } from './terminal-panel.js'
import { botNativeTarget, nativeTabs } from './native-agent-target.js'
import { PanelMenu } from './team-ui/browser-pane.js'
import { ChatsIcon, TerminalIcon } from './team-ui/icons.js'
import { installStyles } from './team-ui/styles.js'
import { SandboxBinding } from './sandbox-settings.js'
import { ProviderAgentsPage } from './provider-agents.js'
import { useProviderChoices } from './provider-agents-hook.js'
import { sandboxSettingsStyle } from './bot-settings-style.js'
import { AgentSetup } from './agent-setup.js'
import { ConnectorToolsPanel } from './connector-tools.js'
import { ExecutionHistory, executionStyle, InlineExecution, useExecutionTools } from './execution-history.js'
import { openWorkspace } from './workspace-entry.js'
import { botHome } from './session-links.js'
import { Icon } from './chat-ui.js'
import { WorkspaceActions } from './workspace-actions.js'
import { TaskSettings } from './task-settings.js'
import { BotSchedulesPage } from './bot-schedules.js'
import { WebBrowserButton } from './browser-viewer.js'
import { mainSession, sessionSelection } from './navigation.js'
import { bindTeamSlashSource, teamSlashSource } from './team-slash.js'
import { AutomationSetupPage } from './automation-setup.js'
import { ComponentSettings, GovernanceSettings, RemoteAgentSettings } from './platform-settings.js'

const lastSessionKey = 'dsh.godbot.bot-session.v1'
const controlsStyle = `
.bt-side .bt-side-top { flex-wrap: wrap; gap: 2px; padding: 3px 0; }
.bt-side-top > .bt-round {
  width: 30px;
  height: 32px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
}
.bt-side .bt-tile-wrap { padding: 6px 0 9px; }
.bt-side .bt-tile {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 1px;
  align-content: center;
  align-items: center;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--bt-line);
  border-radius: 10px;
  background: var(--bt-card);
  text-align: start;
}
.bt-side .bt-tile:has(.bt-chip) > .bt-mark { grid-row: span 2; }
.bt-side .bt-tile-name { max-width: none; font-size: 14px; font-weight: 650; }
.bt-side .bt-tile .bt-chip {
  justify-self: start;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--bt-ink-2);
}
.bt-side .bt-tile[aria-current=page] { border-color: var(--bt-accent); }
.bt-side .bt-row[aria-current=page] { box-shadow: inset 3px 0 var(--bt-accent); }
.bt-side:not(.bt-rail) .bt-row { border-radius: 8px; }

.bt-msg[data-gb-command-report]{width:min(42rem,100%)}
.bt-msg[data-gb-command-report]>.bt-msg-line{width:100%}
.bt-msg[data-gb-command-report]>.bt-msg-line>.bt-bubble{width:100%;background:transparent;padding:0}
.bt-head:has(> .gb-chat-bar) {
  justify-content: flex-end;
  min-width: 0;
  padding-inline: 12px;
  box-sizing: border-box;
  container-type: inline-size;
}
/* A phone-width column keeps the avatar, the model and the tools; a name cut
   to a letter or two says less than the avatar does. */
@container (max-width: 480px) {
  .gb-chat-heading:has(> .gb-bot-model) > .bt-pill { flex: none; padding-inline: 4px; }
  .gb-chat-heading:has(> .gb-bot-model) > .bt-pill > .bt-pill-name { display: none; }
}
/* One floating glass bar at the top-right: the conversation (name, then the
   Bot's model) and its tools, split by a hairline. Segments are flat inside it. */
.gb-chat-bar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  max-width: min(100%, 46rem);
  height: 40px;
  padding: 3px;
  box-sizing: border-box;
  border: 0.5px solid var(--bt-glass-rim);
  border-radius: 12px;
  background: var(--bt-glass-bg);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  backdrop-filter: blur(20px) saturate(180%);
  box-shadow: var(--bt-glass-shadow);
  pointer-events: auto;
}
.gb-chat-heading {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 2px;
  min-width: 0;
  height: 100%;
}
.gb-chat-heading > .bt-pill {
  /* In a narrow bar the name yields first, keeping its avatar and the model. */
  flex: 0 2 auto;
  min-width: 34px;
  max-width: none;
  height: 100%;
  gap: 7px;
  padding: 0 10px 0 4px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.gb-chat-heading:has(> .gb-bot-model) > .bt-pill > .bt-pill-go { display: none; }
.gb-chat-heading > .bt-pill:active { transform: none; }
.gb-bot-model {
  flex: 0 1 auto;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 16rem;
  height: 100%;
  padding: 0 8px 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--bt-ink);
  font: inherit;
  text-align: start;
  pointer-events: auto;
}
.gb-bot-model::before,
.gb-chat-heading + .gb-chat-tools:not(:empty)::before {
  content: '';
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--bt-line-2);
}
.gb-bot-model::before {
  position: absolute;
  inset-inline-start: -1px;
  inset-block-start: 8px;
}
.gb-chat-heading + .gb-chat-tools:not(:empty)::before { margin-inline: 3px 1px; }
.gb-chat-heading > .bt-pill:hover,
.gb-chat-heading > .bt-pill[aria-expanded=true],
button.gb-bot-model:hover { background: var(--bt-hover); }
button.gb-bot-model { cursor: pointer; }
.gb-chat-heading > .bt-pill:focus-visible,
button.gb-bot-model:focus-visible,
.gb-chat-tools > .bt-icon-btn:focus-visible,
.gb-chat-tools .gb-native-button:focus-visible { outline: 2px solid var(--bt-accent); outline-offset: -2px; }
.gb-bot-model-copy { display: grid; min-width: 0; }
.gb-bot-model-name, .gb-bot-model-effort { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gb-bot-model-name { font-size: 12px; font-weight: 500; line-height: 16px; }
.gb-bot-model-effort { color: var(--bt-ink-2); font-size: 11px; line-height: 13px; }
.gb-chat-tools { display: inline-flex; align-items: center; flex: none; gap: 2px; height: 100%; }
.gb-chat-tools:empty { display: none; }
.gb-chat-tools > .bt-icon-btn, .gb-chat-tools .gb-native-button {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--bt-ink-2);
  cursor: pointer;
  pointer-events: auto;
}
.gb-chat-tools > .bt-icon-btn svg, .gb-chat-tools .gb-native-button svg { width: 17px; height: 17px; }
.gb-chat-tools .bt-pmenu-pop { pointer-events: auto; }
.gb-chat-tools > .bt-icon-btn:hover, .gb-chat-tools .gb-native-button:hover,
.gb-chat-tools .gb-native-button[aria-expanded=true] { background: var(--bt-hover); color: var(--bt-ink); }
.gb-chat-tools .gb-native-button[data-active] { color: var(--bt-accent); }
.gb-chat-tools .gb-native-button[data-active]::after {
  content: '';
  position: absolute;
  inset-block-start: 5px;
  inset-inline-end: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 1.5px var(--bt-card);
}
`

function useNativeTerminalActive(client, target, running) {
  const { botId, sessionId } = target ?? {}
  const [activePart, setActivePart] = useState()
  useEffect(() => {
    if (!botId || !sessionId) return
    let timer, mounted = true
    async function update() {
      try {
        const value = await client.terminalStatus({ botId, sessionId })
        if (mounted) setActivePart(value.active ? sessionId : undefined)
      } catch { /* The opener can show a connection error on demand. */ }
      if (mounted) timer = setTimeout(update, running ? 1000 : 4000)
    }
    void update()
    return () => { mounted = false; clearTimeout(timer) }
  }, [client, botId, sessionId, running])
  return target != null && activePart === sessionId
}

function NativeAgentButton({ target, active, actions }) {
  const { sessionId, agent } = target
  const title = agent === 'local-claude-code' ? '打开原生会话并信任此 Bot 的工作目录' : undefined
  return h(PanelMenu, { className: 'gb-native-button', 'aria-label': '原生 Agent', active,
    title: active ? '原生 Agent 控制中，聊天消息等待交还' : '原生 Agent',
    items: [
      { key: 'terminal', icon: TerminalIcon, label: '原生终端', title, onPick: () => actions.showDetails(sessionId, nativeTabs.terminal) },
      { key: 'conversation', icon: ChatsIcon, label: '原生对话', title, onPick: () => actions.showDetails(sessionId, nativeTabs.conversation) },
    ] }, h(TerminalIcon))
}

function readLast() {
  try {
    return sessionStorage.getItem(lastSessionKey)
  } catch {
    return null
  }
}
function remember(id) {
  if (id)
    try {
      sessionStorage.setItem(lastSessionKey, id)
    } catch {
      /* Storage is optional. */
    }
}

function TeamCommandReport({ ctx, client, report, text, bot, sessionId }) {
  const part = report.partId ?? sessionId
  const { seq, messageId } = report
  const entries = part && ctx.sessions.binding(part)?.eventSource?.getSnapshot().entries
  const current = reportSessionUsage(entries, seq, messageId)
  const botId = bot?.id
  const receiptKey = JSON.stringify([botId, part, seq, messageId])
  const loadSession = botId && part && Number.isInteger(seq)
    ? () => client.claudeReportSession({ botId, sessionId: part, seq, messageId }) : undefined
  const isCurrentClaude = bot && (bot.sessionId ?? bot.id) === sessionId &&
    (bot.model ?? bot.appliedModel)?.split('/')[0] === 'local-claude-code'
  const loadStats = isCurrentClaude ? () => client.claudeStats({ botId, sessionId }) : undefined
  return h(NativeCommandReport, { ...report, text, loadStats, sessionUsage: current, loadSession, receiptKey })
}

/** Mount the team UI in its own Cordis lifetime. Outside this route its
 * slots, styles, keyboard handlers, dialogs, and background polls are withdrawn. */
export function mountTeamSurface(ctx, client, navigation, target) {
  return openWorkspace(ctx, client, navigation, (ready) => mountProduct(ctx, client, navigation, target, ready))
}
function mountProduct(ctx, client, navigation, target, ready) {
  const landing = botHome(typeof target === 'string' ? target : undefined, readLast())
  let initialSettings = target?.settings
  let active = true,
    roster
  const idOf = (session) => roster?.byId[session]?.id ?? roster?.roomsById[session]?.id
  const priorSidebar = document.querySelector('[class*="_sidebarCol"]')?.parentElement
  const wasCollapsed = priorSidebar?.hasAttribute('data-sidebar-collapsed')
  const canViewExecution = (bot, id, state) => bot && !state.readOnly && !state.roomsById[id]
  const teamControls = {
    active: () => active,
    sessionSelection,
    back: navigation.back,
    turnReport, earlierReports,
    renderReport: (report, text, bot, sessionId) => h(TeamCommandReport, { ctx, client, report, text, bot, sessionId }),
    browserButton(bot, id, state) {
      return bot && !state.readOnly && !state.browser && (bot.sessionId ?? bot.id) === id
        ? h(WebBrowserButton, { key: 'web-browser-' + bot.id, client, bot, sessionId: id }) : null
    },
    useNativeTerminalActive: (bot, id, state, running) =>
      useNativeTerminalActive(client, botNativeTarget(bot, id, state), running),
    nativeButton(bot, id, state, actions, terminalActive) {
      const target = botNativeTarget(bot, id, state)
      return target && h(NativeAgentButton, { key: 'native:' + id, target, active: terminalActive, actions })
    },
    nativePane(bot, id, state, close, mode, actions) {
      const target = botNativeTarget(bot, id, state)
      return target ? h(TerminalPanel, { client, target, close, mode,
        onModeChange: next => actions.showDetails(id, nativeTabs[next]) }) : h('p', { role: 'status' }, '请选择当前 Bot 的 CLI 会话。')
    },
    executionButton(bot, id, state, actions) {
      return canViewExecution(bot, id, state) && h('button', { key: 'execution:' + id, type: 'button',
        className: 'bt-icon-btn bt-head-search', 'aria-label': '查看会话执行记录', title: '查看会话执行记录',
        onClick: () => actions.showDetails(id, 'godbot-execution') }, h(Icon, { name: 'clock', size: 17 }))
    },
    executionPane(bot, id, state, close) {
      return canViewExecution(bot, id, state) ? h(ExecutionHistory, { key: id, client, bot, sessionId: id, close }) : null
    },
    useExecutionTools: (botId, sessionId, turn, enabled) => useExecutionTools(client, botId, sessionId, turn, enabled),
    inlineExecution: (key, botId, sessionId, turn, running, events) => h(InlineExecution, {
      key, client, botId, sessionId, turn, running, events,
    }),
    providerAgents: props => h(ProviderAgentsPage, { client, ...props }),
    taskSettings: (page, focus, actions, readOnly) => h(TaskSettings, { client, actions, page, focus, readOnly }),
    platformSettings(page, roster, actions, initial, ui = {}) {
      const pages = { automation: AutomationSetupPage, components: ComponentSettings, governance: GovernanceSettings, 'remote-agents': RemoteAgentSettings }
      return h('div', { className: 'gb-platform' }, h(pages[page], { client, roster, actions, initial, ...ui }))
    },
    schedulesPage(state, actions, start, publish) {
      const session = mainSession(ctx)
      return h(BotSchedulesPage, { key: start ?? 'all', client, roster: state, actions, start,
        initialTarget: state.byId[session]?.id ?? state.roomsById[session]?.id ?? state.mainBotId, publish })
    },
    useProviderChoices: (wanted, call) => useProviderChoices(wanted, call, client),
    async changeProvider(bot, agent, target, actions, avatarAfter) {
      if (agent?.disabled || (!agent && target.startsWith('local-')))
        throw new Error('运行账号已变化，请重新选择提供商。')
      const hostKind = { 'local-antigravity':'antigravity', 'local-claude-code':'claude', 'local-codex-cli':'codex' }[agent?.route]
      if (agent?.accountId || (bot.accountProfileId && hostKind)) {
        return actions.afterSandboxBinding(client.dispatch({
          action:'sandbox-bot-bind', botId:bot.id, kind:agent.kind ?? hostKind,
          accountProfileId:agent.accountId ?? null, ...(agent.cwd ? { cwd:agent.cwd } : {}),
        }))
      }
      return actions.updateBot(bot.id, { model:target,changeEngine:true,...avatarAfter(bot,target) })
    },
    openInitialSettings(actions) {
      if (!initialSettings) return
      const page = initialSettings
      initialSettings = null
      actions.openSettings(page)
    },
    sandboxBinding(bot, roster, actions) {
      if (roster.readOnly) return null
      const route = (bot.appliedModel ?? bot.model ?? '').split('/')[0]
      const kind = bot.sandboxKind ?? ({ 'local-antigravity': 'antigravity', 'local-claude-code': 'claude', 'local-codex-cli': 'codex' })[route]
      return h(SandboxBinding, { key: 'sandbox-'+bot.id, client, subject: bot, kind, fullTeam: true,
        onSave: patch => actions.afterSandboxBinding(client.dispatch({ action: 'sandbox-bot-bind', botId: bot.id, ...patch })) })
    },
    connectorTools: bot => h(ConnectorToolsPanel, { key: 'connector-tools-' + bot.id, client, bot, sessionId: bot.sessionId ?? bot.id }),
    startCli: (props) => h(AgentSetup, { ...props, key: props.bot.id }),
    installSlash(triggers, roster, actions, controllerOf) {
      const source = teamSlashSource(roster, actions, client)
      const unregister = triggers.registerSource(source)
      actions.bindNativeCrewSlash = (sessionId) => bindTeamSlashSource(controllerOf(sessionId), source, sessionId)
      return () => {
        delete actions.bindNativeCrewSlash
        unregister()
      }
    },
    home(snapshot, main) {
      roster = snapshot
      return landing(snapshot, main)
    },
    navigation(wide, latest, actions) {
      roster = latest
      return h(WorkspaceActions, { client, wide, onSchedules: () => actions.openSettings('schedules'), onBack: navigation.back })
    },
  }
  const fiber = ctx.plugin({
    inject: botServices,
    apply(child) {
      if (!active) return
      try {
        applyBot(child, teamControls)
        child.effect(() => {
          const style = installStyles(controlsStyle + executionStyle + sandboxSettingsStyle, 'team-controls')
          return () => style.remove()
        }, 'NativeCrew team styles')
        ready()
      } catch (error) {
        ready(error)
        throw error
      }
    },
  })
  const off = ctx.sessions.list.subscribe(() => {
    const id = mainSession(ctx)
    if (idOf(id) || roster?.agentOf[id]) remember(id)
  })
  return () => {
    active = false
    off()
    const selected = mainSession(ctx)
    if (idOf(selected) || roster?.agentOf[selected]) remember(selected)
    void fiber.dispose()
    const frame = document.querySelector('[class*="_sidebarCol"]')?.parentElement
    if (
      frame &&
      wasCollapsed != null &&
      !frame.hasAttribute('data-sidebar-drawer') &&
      frame.hasAttribute('data-sidebar-collapsed') !== wasCollapsed
    )
      ctx.layout.toggleSidebar()
  }
}

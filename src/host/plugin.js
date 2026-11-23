import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildId } from './build-id.js'
import { RemoteComputers } from './remote-computers.js'
import { BotTerminals } from './bot-terminals.js'
import { NativeCrewService, readOnlyWorkspaceSnapshot } from './service.js'
import { createNativeCrewRemote } from './dsh-remote.js'
import { dshModelCatalog } from './dsh-models.js'
import { teamRuntimeStatus, getTeamRuntime, mountTeamRuntime } from './team-runtime.js'
import { prepareWorkspaceIndex } from './web-index.js'

export const name = '@dsh-plugins/nativecrew'
export const inject = ['profileContext', 'agents', 'sessionController', 'agentDefaultModel', 'llm', 'tools', 'typertGateway']

// A reading DSH host may later acquire the Bot team's write lock. Only a
// writable runtime may open/migrate the task store or start its timers.
export function workspaceOperations(rt, create, onError = () => {}) {
  let active = true, operations, opening, retry
  const stopped = () => new Error('Bot 团队工作区已关闭。')
  function checkLater() {
    if (!active || retry) return
    retry = setTimeout(() => {
      retry = undefined
      void scope.ready().catch(error => { if (active) onError(error) })
    }, 5000)
    retry.unref()
  }
  async function initialize() {
    const next = create()
    try {
      await next.start()
      if (!active) throw stopped()
      operations = next
      return next
    } catch (error) {
      await next.close()
      throw error
    }
  }
  const scope = {
    runtime: rt,
    async ready() {
      if (!active) throw stopped()
      await rt.refresh()
      if (!active) throw stopped()
      if (rt.readOnly()) { checkLater(); return operations }
      if (operations) {
        operations.service.botTasks.resume()
        return operations
      }
      opening ??= initialize().catch(error => {
        if (error.code === 'GODBOT_STATE_IN_USE') checkLater()
        throw error
      }).finally(() => { opening = undefined })
      return opening
    },
    existing({ write = false } = {}) {
      if (!active || !operations) throw new Error(rt.readOnly() || 'Bot 团队工作区尚未就绪。')
      if (write && rt.readOnly()) throw new Error(rt.readOnly())
      return operations
    },
    async close() {
      active = false
      clearTimeout(retry)
      await opening?.catch(() => {})
      const previous = operations
      operations = undefined
      await previous?.close()
    },
  }
  return scope
}

export async function apply(ctx, config = {}) {
  const profile = ctx.profileContext
  const stateDir = resolve(config.stateDir || join(profile.home, 'godbot', profile.name))
  const restoreJournal = join(stateDir, '.godbot-restore.json')
  if (existsSync(restoreJournal) && JSON.parse(readFileSync(restoreJournal, 'utf8')).status !== 'complete')
    throw new Error('NativeCrew workspace restoration was interrupted. Stop this Host and run godbot workspace recover for the same home and profile.')
  const models = dshModelCatalog(ctx.sessionController)
  let current
  const workspace = () => {
    if (!current) throw new Error('Bot 团队工作区尚未就绪。')
    return current
  }
  mountTeamRuntime(ctx, stateDir, config.teamWorkspace ?? config.dsBot, async (runtime, child) => {
    const scope = workspaceOperations(runtime, () => {
      const subprocess = ctx.get('subprocess')
      const service = new NativeCrewService({ stateDir, config, subprocess, runtime })
      const terminals = new BotTerminals(service, subprocess)
      const computers = new RemoteComputers(stateDir)
      return { service, terminals, computers, start: () => service.start(child),
        async close() { try { await computers.close() } finally { try { await terminals.dispose() } finally { await service.close() } } } }
    }, error => child.logger.warn('Could not activate Bot workspace operations: %s', error.message))
    current = scope
    child.effect(() => () => {
      if (current === scope) current = undefined
      return scope.close()
    }, 'NativeCrew workspace operations')
    await scope.ready()
  })
  async function snapshot(scope) {
    if (!scope) return {}
    const operations = await scope.ready()
    return operations?.service.botTasks.snapshot() ?? readOnlyWorkspaceSnapshot(stateDir, scope.runtime)
  }
  const terminal = write => workspace().existing({ write }).terminals
  async function service() {
    const scope = workspace()
    await scope.ready()
    return scope.existing().service
  }
  ctx.plugin(createNativeCrewRemote({
    snapshot: async () => ({ buildId, ...await snapshot(current), ...models.view(), workspaceRuntime: teamRuntimeStatus(ctx) }),
    machine: async (request, peer, signal) => {
      const scope = workspace()
      await scope.ready()
      return scope.existing({ write: true }).computers.handle(request, peer, signal)
    },
    terminalStatus: async request => (await workspace().ready())?.terminals.status(request) ?? { active: false, closing: false },
    terminalOpen: async request => {
      const scope = workspace()
      await scope.ready()
      return scope.existing({ write: true }).terminals.open(request)
    },
    terminalRead: ({ terminalId, cursor, waitMs }, signal) => terminal(false).pty.read(terminalId, { cursor, waitMs, signal }),
    terminalWrite: ({ terminalId, data }) => terminal(true).pty.write(terminalId, data),
    terminalResize: ({ terminalId, cols, rows }) => terminal(true).pty.resize(terminalId, cols, rows),
    terminalClose: ({ terminalId }) => terminal(false).close(terminalId),
    slashCommands: async target => (await service()).slashCommands(target),
    claudeReportSession: async target => (await service()).claudeReportSession(target),
    claudeStats: async target => (await service()).claudeStats(target),
    dispatch: async request => {
      const rt = await getTeamRuntime(ctx)
      const scope = workspace()
      if (request.action === 'team-workspace.management') return { ...await snapshot(scope), ...models.view() }
      await scope.ready()
      const { service, terminals } = scope.existing()
      if (request.action === 'terminal.history') return terminals.history(request.terminalId)
      if (request.action === 'execution.history') {
        await rt.refresh()
        return rt.executionHistory.read(request)
      }
      if (request.action.startsWith('browser.')) {
        if (rt.readOnly()) throw new Error(rt.readOnly())
        if (!rt.godbotBrowser) throw new Error('当前宿主未启用 Web 浏览器执行环境')
        return rt.godbotBrowser.invoke(request)
      }
      if (request.action === 'budget.configure' && request.settings?.backup)
        await models.require(request.settings.backup.provider, request.settings.backup.model)
      return service.dispatch(request)
    },
  }))
  ctx.inject(['commands'], commandCtx => commandCtx.commands.register({
    name: 'godbot', definitionId: '@dsh-plugins/nativecrew', description: '打开 Bot 团队工作台',
    handler: () => ({ kind: 'success', text: '在左侧栏打开 NativeCrew。点击 Bot 私聊右上角的终端图标（原生 Agent）接手会话，在「设置 → 任务板」中给 Bot 分配任务。' }),
  }))
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.tapIndex(prepareWorkspaceIndex), 'NativeCrew workspace document')
  })
}

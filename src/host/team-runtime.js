import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import manifest from '../../package.json' with { type: 'json' }
// Link the workspace graph during DSH plugin discovery. A later dynamic import
// races the loader's CommonJS cache reconciliation during profile startup.
import { createRuntime } from './team-runtime/runtime.js'
import { workspaceHome } from './workspace-home.js'
import * as workspaceSearch from './workspace-search.js'

const mounts = new WeakMap()
const services = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection', 'profileContext']
const startupMessage = 'Waiting for the NativeCrew workspace services in this DSH profile.'
const standaloneMessage = 'Another team plugin is active in this DSH profile. To open the NativeCrew team workspace here, disable that plugin and restart DSH.'

function hasEntry(rows, names) {
  return rows.some(row => !row.disabled && (
    names.includes(row.name) || (row.group && Array.isArray(row.config) && hasEntry(row.config, names))
  ))
}

export const hasStandaloneWorkspace = rows => hasEntry(rows, ['ds-bot'])

// A profile can override the app's service rows with second instances of the
// platform libraries. In particular, a foreign tools service cannot read the
// agent-loop's private scope symbol: its first per-Bot registration becomes a
// global tool. Verify the physical package roots before registering any tools.
export function verifyWorkspaceScope(profile) {
  const fromApp = createRequire(profile.installAnchor)
  for (const id of ['dsh-scope', 'dsh-tools', 'dsh-agent-loop', 'dsh-system-prompt']) {
    const name = '@deepseek-ai/' + id
    const inProfile = join(profile.dir, 'node_modules', name, 'package.json')
    if (!existsSync(inProfile)) continue
    if (realpathSync(inProfile) !== realpathSync(fromApp.resolve(name + '/package.json'))) {
      throw new Error('This DSH profile uses a separate copy of ' + name + '. Run the NativeCrew local installer for this profile and restart DSH to restore per-Bot tool isolation.')
    }
  }
}

export function mountTeamRuntime(ctx, stateDir, options = {}, onReady) {
  if (mounts.has(ctx)) return
  const mount = { mode: 'starting', message: startupMessage, ready: Promise.withResolvers() }
  mounts.set(ctx, mount)
  const update = (mode, message, runtime) => {
    Object.assign(mount, { mode, message, runtime })
    if (mode !== 'starting') mount.ready.resolve()
  }
  ctx.effect(() => () => {
    update('unavailable', 'The NativeCrew workspace has stopped.')
    mounts.delete(ctx)
  }, 'NativeCrew workspace')
  let installSearch
  try {
    const rows = composeEntries([readProfilePatches('dsh', ctx.profileContext)])
    if (hasStandaloneWorkspace(rows) || ctx.typertGateway.claimsEndpoint?.('dsBot/call')) {
      update('standalone', standaloneMessage)
      return
    }
    verifyWorkspaceScope(ctx.profileContext)
    // Respect a separately mounted search plugin, regardless of loader order.
    installSearch = !hasEntry(rows, ['ds-bot/web-search', 'dsh-godbot/web-search'])
  } catch (error) {
    update('unavailable', 'Cannot determine NativeCrew workspace ownership: ' + error.message)
    return
  }

  ctx.inject(services, async function godbotTeamWorkspace(child) {
    if (mount.mode !== 'starting') mount.ready = Promise.withResolvers()
    update('starting', startupMessage)
    let active = true
    child.effect(() => () => {
      active = false
      if (mount.mode !== 'unavailable') update('unavailable', 'The NativeCrew workspace services have stopped.')
    }, 'NativeCrew workspace resources')
    try {
      const home = workspaceHome(stateDir)
      const rt = createRuntime(child, { ...options, godbotStateDir: stateDir, workspace: options.workspace ?? join(home, 'workspace'), home })
      await rt.load()
      if (active && mounts.get(ctx) === mount) await onReady?.(rt, child)
      if (active && mounts.get(ctx) === mount) {
        if (installSearch) child.inject?.(['web'], searchCtx => workspaceSearch.apply(searchCtx, options.webSearch))
        update('embedded', undefined, rt)
      }
    } catch (error) {
      if (!active || mounts.get(ctx) !== mount) return
      update('unavailable', 'Could not start the NativeCrew workspace: ' + error.message)
      child.logger.warn('NativeCrew workspace startup failed: %s', error.stack ?? error.message)
      // A partial installation may have acquired the state lock or registered
      // tools. Dispose only this child after apply returns to the Cordis runner.
      queueMicrotask(() => { void child.fiber?.dispose() })
    }
  })
}

export function teamRuntimeStatus(ctx) {
  const mount = mounts.get(ctx)
  return { mode: mount?.mode ?? 'unavailable', message: mount?.message, version: manifest.version }
}

export async function getTeamRuntime(ctx) {
  const mount = mounts.get(ctx)
  if (mount?.mode === 'starting') {
    // A custom DSH profile may intentionally omit one of NativeCrew's services.
    // Do not leave an explicit import waiting indefinitely.
    let timer
    try {
      await Promise.race([mount.ready.promise, new Promise(resolve => {
        timer = setTimeout(resolve, 10000)
        timer.unref?.()
      })])
    } finally {
      clearTimeout(timer)
    }
  }
  if (mount?.runtime) return mount.runtime
  const error = new Error(mount?.message ?? 'The NativeCrew team workspace is unavailable.')
  if (mount?.mode === 'standalone') error.code = 'GODBOT_TEAM_DISABLED'
  throw error
}

// Modified for Godbot. See THIRD_PARTY_NOTICES.
import * as sandboxPrivacy from './sandbox-privacy.js'
// NativeCrew: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
import { join } from 'node:path'
import * as diagnostics from './core/diagnostics.js'
import * as store from './core/store.js'
import * as models from './core/models.js'
import * as providers from './core/providers.js'
import * as permissions from './core/permissions.js'
import * as governance from './core/governance.js'
import * as turns from './core/turns.js'
import * as steer from './core/steer.js'
import * as handoffs from './core/handoffs.js'
import * as requests from './core/requests.js'
import * as delivery from './core/delivery.js'
import * as roster from './roster.js'
import * as folders from './core/folders.js'
import * as privacy from './privacy.js'
import * as agents from './core/agents.js'
import * as prompt from './core/prompt.js'
import * as timeContext from './core/time-context.js'
import * as tools from './core/tools.js'
import * as chatIndex from './core/chat-index.js'
import * as groups from './core/groups.js'
import * as ledger from './core/ledger.js'
import * as goals from './core/goals.js'
import * as agentCommands from './core/agent-commands.js'
import * as tasks from './core/tasks.js'
import * as approvals from './core/approvals.js'
import * as resume from './core/resume.js'
import * as memoryObserver from './core/memory.js'
import * as parts from './core/parts.js'
import * as changes from './core/changes.js'
import * as images from './core/images.js'
import * as avatarLibrary from './core/avatar-library.js'
import * as browser from './core/browser.js'
import * as browserPlugins from './browser-viewer.js'
import * as computer from './core/computer/index.js'
import * as secrets from './core/secrets.js'
import * as connectors from './connector-tools.js'
import * as capabilities from './core/capabilities.js'
import * as components from './core/components.js'
import * as learningObserver from './core/learning.js'
import * as schedules from './core/schedules.js'
import * as usage from './core/usage.js'
import * as update from './core/update.js'
import * as dshUpdate from './core/dsh-update.js'
import * as thinking from './core/thinking.js'
import * as phone from './core/phone.js'
import * as channel from './core/channel.js'
import * as remote from './core/remote.js'
import * as mobile from './core/mobile.js'
import * as feed from './core/feed.js'
import * as im from './core/im/index.js'
import * as officeSkills from './core/office-skills.js'
import * as goalSkills from './core/goal-skills.js'
import * as localAgents from './local-agents.js'
import * as remoteAgents from './core/remote-agents.js'
import * as roomRouting from './room-routing.js'
import * as executionHistory from './execution-history.js'

export { COLORS } from './core/constants.js'

export { name, inject } from './core/entry.js'

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them. privacy checks a
// call before the hooks of tools do, so a closed call never reaches a card they show.
const memory = sandboxPrivacy.sandboxAwareObserver(memoryObserver)
const learning = sandboxPrivacy.sandboxAwareObserver(learningObserver)
const MODULES = [diagnostics, store, ledger, models, sandboxPrivacy, providers, permissions, governance, turns, steer, handoffs, requests, delivery, roster, folders, privacy, agents, prompt, timeContext, tools, chatIndex, groups, goals, agentCommands, tasks, approvals, resume, memory, parts, changes, images, avatarLibrary, secrets, connectors, capabilities, components, learning, schedules, browser, browserPlugins, computer, usage, update, dshUpdate, thinking, mobile, feed, phone, im, channel, remote, officeSkills, goalSkills, executionHistory, localAgents, remoteAgents, roomRouting]

export function apply(ctx, config = {}) {
  createRuntime(ctx, config)
}

export function createRuntime(ctx, config = {}) {
  const dshHome = folders.dshHomeOf(ctx.profileContext?.home ?? process.env.DSH_HOME)
  const home = config.home ?? join(dshHome, 'bot')
  const rt = {
    ctx,
    config,
    dshHome,
    home,
    statePath: join(home, 'state.json'),
    // The Bot-only tools each module defines; tools.js registers them in each
    // Bot Session's own scope, never globally (see shareBotTools).
    teamTools: [],
    defaults: {
      mainName: config.mainName ?? 'NativeCrew',
      mainRole: config.mainRole ?? 'Team Lead',
    },
  }
  for (const module of MODULES) module.install(rt)
  // A live Agent can be scoped before the last module has added its tools (the memory
  // module starts a load during install): complete the scope now that every tool is in.
  rt.syncScopedTools?.()
  // dsh can load this plugin again in place, its files replaced while it runs: dsh
  // keeps the turns and child agents it had, while this runtime starts with empty
  // maps. Adopt them now, so Stop, the group view and a late child settle still see
  // the work. A fresh start has nothing to adopt.
  void rt.adoptLiveWork?.().catch(error => rt.warn?.('godbot: adopting the work still running failed: %s', error))
  return rt
}

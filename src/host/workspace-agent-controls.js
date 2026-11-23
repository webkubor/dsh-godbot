// NativeCrew owns the conversation, approvals, tool bridge and permissions. Its
// Claude 0.3.8 transport has no settings stream, and advertises four aliases.
// Attach the same native controls used by a direct NativeCrew session to its child.
import { randomUUID } from 'node:crypto'
import { ClaudeControlSession, configureClaude, describeClaude } from '../drivers/external/claude-settings.js'
import { attachClaudeBotTimeline } from './claude-bot-timeline.js'

import { ClaudeEngine } from './team-runtime/core/local-agents/claude.js'

class TeamClaudeControl extends ClaudeControlSession {
  constructor(session, options) {
    super()
    this.session = session
    this.launchModel = options.model
    this.resumeId = options.resumeId
    attachClaudeBotTimeline(session, {
      cwd: options.cwd,
      usageDelivery: () => this.usageDelivery,
      onControl: response => {
        if (!this.controlRequests?.has(response?.request_id)) return false
        this.receiveControl(response)
        return true
      },
    })
  }

  write(message) {
    const input = this.session.child?.stdin
    if (!input?.writable || this.session.dead) return Promise.reject(new Error('Claude input is closed'))
    return new Promise((resolve, reject) => {
      input.write(JSON.stringify(message) + '\n', (error) => (error ? reject(error) : resolve()))
    })
  }
}

class WorkspaceClaudeEngine extends ClaudeEngine {
  controls = new WeakMap()
  env = { CLAUDE_CODE_CHILD_SESSION: undefined }

  constructor(route, spec, dependencies) {
    super(route, { ...spec, args: [...(spec.args ?? []), '--include-partial-messages'] }, dependencies)
  }

  async open(id, options) {
    const session = await super.open(id, options)
    if (!this.controls.has(session)) this.controls.set(session, new TeamClaudeControl(session, options))
    return session
  }

  async listModels({ cwd }) {
    const id = randomUUID()
    try {
      const session = await this.open(id, { cwd })
      const metadata = await describeClaude(this.controls.get(session))
      const reasoning = (levels) =>
        metadata.canConfigureEffort && levels?.length ? { efforts: levels } : undefined
      this.defaultReasoning = reasoning(metadata.efforts)
      if (this.defaultReasoning && metadata.currentEffort)
        this.defaultReasoning.defaultEffort = metadata.currentEffort
      if (!metadata.models.length) return super.listModels()
      return metadata.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: reasoning(model.efforts),
      }))
    } finally {
      this.forget(id)
    }
  }

  async prompt(session, blocks, { effort, signal } = {}) {
    const control = this.controls.get(session)
    // A model or permission change reopens NativeCrew's CLI process. Clear a
    // previous override only on the process to which we actually applied it.
    const choice = effort ?? null
    if (choice !== (control.lastChoice ?? null)) {
      await configureClaude(control, { effort: choice })
      control.lastChoice = choice
      session.emit({
        type: 'effort',
        effort: control.currentEffort,
        defaultEffort: control.nativeDefaults.get(control.model),
      })
    }
    signal?.throwIfAborted()
    return super.prompt(session, blocks)
  }

  steer(session, input) {
    return session.prompt(Array.isArray(input) ? input : [{ type: 'text', text: input }], { steer: true })
  }

  cancel(session) {
    if (!session.running || session.dead) return
    // Claude requires an ID even if the adapter has already stopped reading.
    session.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }
}

export function createWorkspaceClaudeEngine(route, spec, dependencies) {
  return new WorkspaceClaudeEngine(route, spec, dependencies)
}

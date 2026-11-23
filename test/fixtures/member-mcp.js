import { randomBytes } from 'node:crypto'
import { LoopbackMcp } from '../../src/team/mcp.js'
import { teamTools } from './member-tools.js'

const reads = new Set(['list_members', 'list_tasks'])
const turnContext = { type: 'string', description: 'Copy the turnContext from this NativeCrew turn. Earlier turns expire.' }

// Native MCP transports identify their process/session but do not attest which
// turn sent a request. A separate value travels only in each actual turn prompt.
export class MemberMcp extends LoopbackMcp {
  constructor(member, currentTurn, invoke) {
    const catalog = teamTools.filter(tool => member.workspaceMode !== 'shared-readonly' || tool.name !== 'assign_task')
      .map(tool => reads.has(tool.name) ? tool : {
        ...tool,
        parameters: { ...tool.parameters, properties: { ...tool.parameters.properties, turnContext },
          required: [...tool.parameters.required, 'turnContext'] },
      })
    super(() => catalog, async ({ name, arguments: args, callId }) => {
      const current = currentTurn()
      if (!current || !catalog.some(tool => tool.name === name)) throw new Error('This session has no active team tool call')
      const { turnContext: provided, ...input } = args
      if (!reads.has(name) && (this.turn?.id !== current || provided !== this.turn.key))
        throw new Error('The team tool belongs to another or expired turn. Use the turnContext supplied with the current task.')
      return { text: JSON.stringify(await invoke(name, input, callId)) }
    })
  }

  beginTurn(id) {
    this.turn = { id, key: 'gbturn_' + randomBytes(24).toString('hex') }
    return this.turn.key
  }
}

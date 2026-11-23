import { teamTools } from './member-tools.js'

export function registerMemberTools(agent, memberId, memberTool, isAuthorized) {
  const registrations = []
  try {
    for (const tool of teamTools) {
      registrations.push(
        agent.ctx.tools.register({
          ...tool,
          name: 'godbot_' + tool.name,
          output: {
            schema: {},
            render: (_input, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: (input, execution) => {
            execution.signal.throwIfAborted()
            if (execution.agent !== agent || !isAuthorized())
              throw new Error('This turn does not own the NativeCrew member')
            return memberTool(memberId, tool.name, input, execution.callId)
          },
        }),
      )
    }
  } catch (error) {
    for (const unregister of registrations.reverse()) unregister()
    throw error
  }
  return () => {
    for (const unregister of registrations.splice(0).reverse()) unregister()
  }
}

const commandHelp =
  '打开左侧栏的 NativeCrew 工作台控制团队。在已绑定的 dsh 成员会话中可以使用 /godbot team、/godbot members、/godbot send <成员> <消息>、/godbot stop。'

export async function runNativeCrewCommand(ctx, service, { agent, rawInput, signal }) {
  signal.throwIfAborted()
  const input = rawInput.trim()
  if (!input || input === 'help') return { kind: 'success', text: commandHelp }
  const invocation = agent.ctx.get?.('invocation')
  if (invocation && invocation.peer?.principal?.kind !== 'owner')
    return { kind: 'error', text: 'Only the dsh owner can run this command.' }
  if (ctx.agents.get(agent.id) !== agent) return { kind: 'success', text: commandHelp }
  const snapshot = await service.snapshot()
  const member = snapshot.members.find((item) => item.kind === 'dsh' && item.nativeId === agent.id)
  if (!member) return { kind: 'success', text: commandHelp }
  const team = snapshot.teams.find((item) => item.id === member.teamId)
  if (!team) return { kind: 'error', text: 'This team no longer exists.' }
  signal.throwIfAborted()
  const peers = snapshot.members.filter((item) => item.teamId === team.id)
  if (input === 'team') {
    const lead = peers.find((peer) => peer.id === team.leadId)
    return {
      kind: 'success',
      text: team.name + (lead ? ' · Lead: ' + lead.name : '') + ' · ' + (team.stopped ? 'stopped' : 'active'),
    }
  }
  if (input === 'members')
    return {
      kind: 'success',
      text: peers.map((peer) => peer.name + ' · ' + peer.kind + ' · ' + peer.status).join('\n'),
    }
  if (input === 'stop' || input.startsWith('stop ')) {
    const target = input.slice(4).trim().replace(/^@/, '')
    // DSH's command callback has no authenticated owner credential. A bound
    // member may control its own turn; the owner panel can stop other members.
    if (target && target !== member.id && target !== member.name)
      return {
        kind: 'error',
        text: 'A member can stop its own turn. Open the NativeCrew panel to stop another agent.',
      }
    if (!member.activeTurnId) return { kind: 'success', text: member.name + ' is idle.' }
    const result = await service.dispatch({
      action: 'member.stop',
      memberId: member.id,
      expectedTurnId: member.activeTurnId,
    })
    return { kind: 'success', text: member.name + ' · ' + result.status }
  }
  if (input.startsWith('send ')) {
    const body = input.slice(5).trimStart().replace(/^@/, '')
    const target = peers
      .flatMap((peer) => [
        { peer, address: peer.name },
        { peer, address: peer.id },
      ])
      .sort((a, b) => b.address.length - a.address.length)
      .find(({ address }) => body.startsWith(address) && /\s/u.test(body[address.length] || ''))
    if (!target) return { kind: 'error', text: 'Use /godbot send <team member name or ID> <message>.' }
    const message = body.slice(target.address.length).trim()
    if (!message) return { kind: 'error', text: 'A message is required.' }
    const receipt = await service.memberTool(member.id, 'send_message', { to: target.peer.id, text: message })
    return { kind: 'success', text: 'Message to ' + target.peer.name + ' accepted (' + receipt.id + ').' }
  }
  return { kind: 'error', text: commandHelp }
}

export function registerCommand(ctx, service) {
  ctx.commands.register({
    name: 'godbot',
    definitionId: 'dsh-godbot',
    description: 'Open the NativeCrew agent team controls',
    input: { hint: 'team | members | send <member> <message> | stop' },
    handler: async (invocation) => {
      try {
        return await runNativeCrewCommand(ctx, service, invocation)
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  })
}

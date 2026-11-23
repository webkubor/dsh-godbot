import test from 'node:test'
import assert from 'node:assert/strict'
import { runNativeCrewCommand } from '../fixtures/member-dsh-tools.js'

test('slash controls use the actual DSH member, resolve only teammates and stop only the issuing session', async () => {
  const agent = { id: 'native-a', ctx: { get: () => undefined } }
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined } }
  const tools = [], commands = []
  const service = {
    snapshot: () => ({ teams: [{ id: 't', name: 'Design', leadId: 'a' }], members: [
      { id: 'a', name: 'Lead', teamId: 't', kind: 'dsh', nativeId: 'native-a', status: 'running', activeTurnId: 'turn' },
      { id: 'b', name: 'Code Reviewer', teamId: 't', kind: 'codex', status: 'idle' },
      { id: 'c', name: 'Other', teamId: 'u', kind: 'dsh' },
    ] }),
    memberTool: (...args) => { tools.push(args); return { id: 'message' } },
    dispatch: data => { commands.push(data); return { status: 'stopping' } },
  }
  const run = rawInput => runNativeCrewCommand(ctx, service, { agent, rawInput, signal: new AbortController().signal })
  assert.match((await run('team')).text, /Design/)
  assert.doesNotMatch((await run('members')).text, /Other/)
  assert.equal((await run('send Other ignored')).kind, 'error')
  assert.equal((await run('send @Code Reviewer verify the diff')).kind, 'success')
  assert.deepEqual(tools, [['a', 'send_message', { to: 'b', text: 'verify the diff' }]])
  assert.equal((await run('stop Code Reviewer')).kind, 'error')
  assert.equal((await run('stop')).kind, 'success')
  assert.deepEqual(commands, [{ action: 'member.stop', memberId: 'a', expectedTurnId: 'turn' }])
  agent.ctx.get = () => ({ peer: { principal: { kind: 'guest' } } })
  assert.equal((await run('send Code Reviewer hidden')).kind, 'error')
  assert.equal(tools.length, 1)
  agent.ctx.get = () => undefined
  agent.id = 'ordinary'
  assert.match((await run('send Code Reviewer hidden')).text, /工作台/)
  assert.equal(tools.length, 1)
})

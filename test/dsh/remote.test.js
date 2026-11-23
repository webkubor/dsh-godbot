import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeCrewRemote } from '../../src/host/dsh-remote.js'

test('the panel API requires an authenticated owner even if the payload claims ownership', async () => {
  const calls = []
  const Remote = createNativeCrewRemote({
    snapshot: () => ({ members: [] }),
    slashCommands: () => [{ name: 'review' }],
    claudeStats: () => ({ available: true }),
    dispatch: request => { calls.push(request); return { status: 'ok' } },
  })
  const request = { action: 'team.stop', principal: { kind: 'owner' } }
  for (const peer of [undefined, { principal: { kind: 'team-guest' } }]) {
    const context = { ctx: { invocation: peer && { peer, request: { method: 'snapshot' } } } }
    for (const method of ['terminalStatus', 'terminalOpen', 'terminalRead', 'terminalWrite', 'terminalResize', 'terminalClose']) {
      await assert.rejects(Remote.prototype[method].call(context, request), { code: 'remote-access/denied' })
    }
    await assert.rejects(Remote.prototype.snapshot.call(context), { code: 'remote-access/denied' })
    await assert.rejects(Remote.prototype.claudeReportSession.call(context, request), { code: 'remote-access/denied' })
    await assert.rejects(Remote.prototype.claudeStats.call(context, request), { code: 'remote-access/denied' })
    await assert.rejects(Remote.prototype.slashCommands.call(context, request), { code: 'remote-access/denied' })
    await assert.rejects(Remote.prototype.dispatch.call(context, request), { code: 'remote-access/denied' })
  }
  assert.deepEqual(calls, [])
  const owner = { ctx: { invocation: { peer: { principal: { kind: 'owner' } } } } }
  assert.deepEqual(await Remote.prototype.snapshot.call(owner), { members: [] })
  assert.deepEqual(await Remote.prototype.slashCommands.call(owner, {memberId: 'a'}), [{ name: 'review' }])
  assert.deepEqual(await Remote.prototype.dispatch.call(owner, request), { status: 'ok' })
  assert.deepEqual(calls, [request])
})

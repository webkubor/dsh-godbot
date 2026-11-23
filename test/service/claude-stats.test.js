import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readClaudeStats } from '../../src/host/claude-stats.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-stats-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return {
    dir,
    path: join(dir, 'stats-cache.json'),
    write: data => writeFile(join(dir, 'stats-cache.json'), JSON.stringify(data)),
    read: () => readClaudeStats({ configDir: dir }),
  }
}

test('reads only v5 aggregates with an explicit cutoff, omitting private IDs and missing metrics', async t => {
  const f = await fixture(t)
  const cache = {
    version: 5, lastComputedDate: '2025-01-02', firstSessionDate: '2024-12-30T14:36:02.000Z',
    totalSessions: 3, totalMessages: '9', longestSession: { sessionId: 'private-sid', duration: 882, messageCount: 9 },
    dailyActivity: [
      { date: '2025-01-03', messageCount: 88 },
      { date: '2025-01-02', messageCount: 5, sessionCount: 1, toolCallCount: 8, cwd: '/private/working-dir' },
      { date: '2025-01-01', messageCount: 4, sessionCount: -1, toolCallCount: 0 },
      { date: '2025-02-30', messageCount: 199 },
    ],
    modelUsage: {
      'anthropic/claude-test': { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 0, sessionId: 'private' },
      'unsafe/path/part': { inputTokens: 4 },
      '12345678-1234-1234-1234-123456789abc': { inputTokens: 5 },
      'empty-model': { costUSD: 1 },
    },
  }
  await f.write(cache)
  const stats = await f.read()
  assert.deepEqual(stats, {
    available: true, asOf: '2025-01-02',
    totals: { sessions: 3 }, firstSessionDate: '2024-12-30',
    longest: { durationMs: 882, messages: 9 },
    daily: [{ date: '2025-01-01', messages: 4, toolCalls: 0 }, { date: '2025-01-02', messages: 5, sessions: 1, toolCalls: 8 }],
    models: [{ name: 'anthropic/claude-test', inputTokens: 3, outputTokens: 4, cacheReadTokens: 2, cacheCreationTokens: 0 }],
  })
})

test('a missing file, unsupported version, empty cache, repeated day, invalid JSON or oversize file have no synthetic stats', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.read(), { available: false, reason: 'missing' })
  await f.write({ version: 4, totalSessions: 100 })
  assert.equal((await f.read()).reason, 'unsupported')
  await f.write({ version: 5, lastComputedDate: '2025-01-01', totalSessions: 0, totalMessages: 0 })
  assert.equal((await f.read()).reason, 'empty')
  await f.write({ version: 5, lastComputedDate: '2025-01-01', dailyActivity: Array(2).fill({ date: '2025-01-01', messageCount: 3 }) })
  assert.equal((await f.read()).reason, 'unreadable')
  await writeFile(f.path, '{')
  assert.equal((await f.read()).reason, 'unreadable')
  await truncate(f.path, 4 * 1024 * 1024 + 1)
  assert.equal((await f.read()).reason, 'unreadable')
})

test('honors the selected config directory and rejects paths redirected to a different file', async t => {
  const f = await fixture(t)
  assert.equal((await readClaudeStats({ configDir: './relative' })).reason, 'unreadable')
  const other = join(f.dir, 'another.json')
  await writeFile(other, JSON.stringify({ version: 5, lastComputedDate: '2025-01-01', totalSessions: 7 }))
  try {
    await symlink(other, f.path)
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return
    throw error
  }
  assert.deepEqual(await f.read(), { available: false, reason: 'unreadable' })
})

test('uses CLAUDE_CONFIG_DIR for the current CLI identity when no override is given', async t => {
  const f = await fixture(t)
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = f.dir
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
  })
  await f.write({ version: 5, lastComputedDate: '2025-08-12', totalMessages: 4 })
  assert.equal((await readClaudeStats()).totals.messages, 4)
})

test('historical team statistics are selected by Bot, part, sequence and assistant identity', async () => {
  const { NativeCrewService } = await import('../../src/host/service.js')
  const report = { durationMs: 20, models: [] }
  const reply = { id: 'm', source: { provider: 'local-claude-code', replayState: { response: {godbotClaudeSessionUsage: report} } } }
  let queried = 0
  const rt = { refresh: async () => {}, state: {bots:{a:{id:'a'}, b:{id:'b'}}},
    chatOwners: new Map([['current','b']]), pastOwners: new Map([['older',{botId:'a'}],['room',{botId:'a',roomId:'group'}]]),
    ctx: {sessionController:{page: async ({address, throughSeq}) => {
      queried++
      assert.equal(address.sessionId,'older')
      return { records: [{event:{seq:10,type:'assistant/message',data:{message:reply}}}].filter(x=>x.event.seq<=throughSeq) }
    }}} }
  const read = (opts) => NativeCrewService.prototype.claudeReportSession.call({ runtime:rt }, opts)
  assert.deepEqual(await read({botId:'a',sessionId:'older',seq:10,messageId:'m'}), report)
  assert.equal(await read({botId:'a',sessionId:'older',seq:10,messageId:'wrong'}), null)
  assert.equal(await read({botId:'a',sessionId:'older',seq:11}), null)
  await assert.rejects(read({botId:'b',sessionId:'older',seq:10}), /不属于/)
  await assert.rejects(read({botId:'a',sessionId:'room',seq:10}), /不属于/)
  assert.equal(queried, 3)
})

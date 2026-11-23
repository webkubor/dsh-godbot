import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { NativeCrewService } from '../fixtures/member-service.js'
import { Store } from '../../src/host/store.js'
import { addMember, createTeam } from '../fixtures/member-team.js'
import { memberWorkspace, prepareMemberWorkspace, workspaceBlocker } from '../fixtures/member-workspace.js'

function workspace(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'godbot-workspace-')))
  const resources = []
  t.after(async () => {
    try {
      for (const close of resources.reverse()) await close()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
  const stateDir = join(base, 'state'),
    repo = join(base, 'source')
  mkdirSync(stateDir)
  mkdirSync(repo)
  const git = (cwd, ...args) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      encoding: 'utf8',
    }).trim()
  git(repo, 'init', '--quiet', '--initial-branch=main')
  mkdirSync(join(repo, 'app'))
  writeFileSync(join(repo, 'app', 'tracked'), 'original')
  git(repo, 'add', '--', 'app/tracked')
  git(repo, 'commit', '--quiet', '-m', 'base')
  return { base, stateDir, repo, git, resources }
}

function memberFixture(t) {
  const { base, stateDir, repo, git, resources } = workspace(t)
  const store = new Store(stateDir)
  resources.push(() => store.close())
  const team = createTeam(store, { name: 'test', cwd: repo })
  const member = addMember(
    store,
    { teamId: team.id, kind: 'codex', name: 'writer', workspaceMode: 'worktree', cwd: join(repo, 'app') },
    stateDir,
  )
  return { base, stateDir, repo, git, store, team, member }
}

test('managed checkout pins HEAD, preserves relative cwd, source edits and subsequent member changes', async (t) => {
  const { stateDir, repo, git, member } = memberFixture(t)
  assert.equal(member.status, 'preparing')
  assert.equal(member.baseBranch, 'main')
  writeFileSync(join(repo, 'app', 'tracked'), 'later source edit')
  git(repo, 'commit', '-am', 'later commit')
  const prepared = await Promise.all([
    prepareMemberWorkspace(member, stateDir),
    prepareMemberWorkspace(member, stateDir),
  ])
  assert.deepEqual(prepared[0], prepared[1])
  assert.equal(prepared[0].cwd, join(stateDir, 'worktrees', member.id, 'app'))
  assert.equal(git(member.cwd, 'rev-parse', 'HEAD'), member.baseCommit)
  assert.equal(git(member.cwd, 'branch', '--show-current'), `godbot/${member.id}`)
  assert.equal(readFileSync(join(member.cwd, 'tracked'), 'utf8'), 'original')
  writeFileSync(join(member.cwd, 'tracked'), 'uncommitted member changes')
  await prepareMemberWorkspace(member, stateDir)
  assert.equal(readFileSync(join(member.cwd, 'tracked'), 'utf8'), 'uncommitted member changes')
  assert.equal(readFileSync(join(repo, 'app', 'tracked'), 'utf8'), 'later source edit')
  assert.equal(
    workspaceBlocker({ id: 'original', workspaceRoot: repo }, [{ ...member, activeTurnId: 'active' }]),
    undefined,
  )
})

test('a retry adopts the original member branch with advanced commits rather than resetting it', async (t) => {
  const { stateDir, repo, git, member } = memberFixture(t)
  await prepareMemberWorkspace(member, stateDir)
  writeFileSync(join(member.cwd, 'tracked'), 'committed by member')
  git(member.cwd, 'commit', '-am', 'member commit')
  const tip = git(member.cwd, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'remove', member.workspaceRoot)
  await prepareMemberWorkspace(member, stateDir)
  assert.equal(git(member.cwd, 'rev-parse', 'HEAD'), tip)
  assert.notEqual(tip, member.baseCommit)
})

test('failed checkout preserves unrelated files in the reservation and never overwrites a changed branch', async (t) => {
  const { member, stateDir, git } = memberFixture(t)
  mkdirSync(member.workspaceRoot)
  writeFileSync(join(member.workspaceRoot, 'keep'), 'untouched')
  await assert.rejects(prepareMemberWorkspace(member, stateDir), /Could not prepare/)
  assert.equal(readFileSync(join(member.workspaceRoot, 'keep'), 'utf8'), 'untouched')
  rmSync(member.workspaceRoot, { recursive: true })
  await prepareMemberWorkspace(member, stateDir)
  git(member.cwd, 'switch', '--quiet', '-c', 'manual-branch')
  writeFileSync(join(member.cwd, 'tracked'), 'new manual work')
  await assert.rejects(prepareMemberWorkspace(member, stateDir), /different checkout, repository or branch/)
  assert.equal(git(member.cwd, 'branch', '--show-current'), 'manual-branch')
  assert.equal(readFileSync(join(member.cwd, 'tracked'), 'utf8'), 'new manual work')
})

test('ordinary paths stay usable without Git; managed worktrees require a committed source directory', (t) => {
  const { stateDir, base, repo } = workspace(t)
  assert.deepEqual(memberWorkspace(base, 'shared', 'shared', stateDir), {
    cwd: base,
    workspaceRoot: base,
    workspaceMode: 'shared',
  })
  assert.throws(() => memberWorkspace(base, 'worktree', 'no-repo', stateDir), /Git repository/)
  const absent = join(repo, 'untracked')
  mkdirSync(absent)
  assert.throws(() => memberWorkspace(absent, 'worktree', 'absent', stateDir), /absent from HEAD/)
})

test('write admission covers other teams, Git siblings, non-Git descendants, aliases, and unknown activity', (t) => {
  const { base, repo } = workspace(t)
  const first = { id: 'a', cwd: join(repo, 'app'), teamId: 'first', role: 'reader' }
  const alias = join(base, 'alias')
  symlinkSync(repo, alias, 'dir')
  const other = { id: 'b', cwd: alias, teamId: 'second', activeTurnId: 'busy', role: 'reader' }
  assert.equal(workspaceBlocker(first, [other]), other)
  const unconfirmed = { ...other, activeTurnId: null, status: 'unknown' }
  assert.equal(workspaceBlocker(first, [unconfirmed]), unconfirmed)
  assert.equal(workspaceBlocker(first, [{ ...other, activeTurnId: null, status: 'idle' }]), undefined)
  const outer = { id: 'c', workspaceRoot: base }
  const child = { ...other, workspaceRoot: join(base, 'plain', 'nested') }
  assert.equal(workspaceBlocker(outer, [child]), child)
  assert.equal(workspaceBlocker({ id: 'sibling', workspaceRoot: join(base, 'plain-2') }, [child]), undefined)
})

test('only two host-enforced read-only policies can share a working tree, and only Codex can be registered as such', (t) => {
  const { stateDir, store, team } = memberFixture(t)
  const add = (name, kind) =>
    addMember(store, { teamId: team.id, name, kind, workspaceMode: 'shared-readonly' }, stateDir)
  assert.throws(() => add('not-enforced', 'dsh'), /Codex read-only sandbox/)
  const a = add('reviewA', 'codex'),
    b = { ...add('reviewB', 'codex'), activeTurnId: 'turn' }
  const enforced = (row) => row.kind === 'codex' && row.workspaceMode === 'shared-readonly'
  assert.equal(workspaceBlocker(a, [b]), b)
  assert.equal(workspaceBlocker(a, [b], enforced), undefined)
  const writer = { ...b, workspaceMode: 'shared' }
  assert.equal(workspaceBlocker(a, [writer], enforced), writer)
})

test('service submits independent worktree turns while overlapping writers queue, then wakes the blocked writer', async (t) => {
  const { repo, stateDir, resources } = workspace(t)
  const started = new Map()
  const service = new NativeCrewService({
    stateDir,
    openDriver: async (options) => ({
      nativeId: options.memberId,
      capabilities: {},
      close: async () => {},
      async start({ turnId }) {
        started.set(options.memberId, {
          turnId,
          config: options.config,
          complete() {
            options.onEvent({ type: 'done', turnId, status: 'completed' })
          },
        })
      },
    }),
  })
  resources.push(() => service.close())
  await service.ready()
  const team = service.dispatch({ action: 'team.create', name: 'team', cwd: repo })
  const member = (name, workspaceMode = 'shared') =>
    service.dispatch({ action: 'member.add', teamId: team.id, kind: 'codex', name, workspaceMode })
  const first = member('writer'),
    blocked = member('waiting writer'),
    independent = member('independent', 'worktree')
  const send = (row) =>
    service.dispatch({ action: 'member.send', memberId: row.id, text: 'Test native submission' })
  const waitFor = async (check) => {
    for (let i = 0; i < 250; i++) {
      if (check()) return
      await pause(10)
    }
    assert.fail('Timed out waiting for workspace admission')
  }
  send(first)
  send(blocked)
  send(independent)
  await waitFor(() => started.has(first.id) && started.has(independent.id))
  assert.equal(started.has(blocked.id), false)
  assert.equal(service.snapshot().commands.find((row) => row.memberId === blocked.id).status, 'queued')
  started.get(first.id).complete()
  await waitFor(() => started.has(blocked.id))
  started.get(independent.id).complete()
  started.get(blocked.id).complete()
  const readA = member('first reader', 'shared-readonly'),
    readB = member('second reader', 'shared-readonly')
  send(readA)
  send(readB)
  await waitFor(() => started.has(readA.id) && started.has(readB.id))
  assert.equal(started.get(readA.id).config.readOnly, true)
  assert.equal(started.get(readB.id).config.readOnly, true)
  assert.equal(started.get(blocked.id).config.readOnly, false)
  started.get(readA.id).complete()
  started.get(readB.id).complete()
})

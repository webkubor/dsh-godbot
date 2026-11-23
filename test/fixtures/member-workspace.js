import { execFile, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { lstat, realpath, rmdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const provisioning = new Map()

function gitOptions() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_PREFIX',
  ])
    delete env[key]
  return { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
}
const stripEol = (text) => text.replace(/\r?\n$/, '')

export function inspectGit(cwd, args, optional = false) {
  const result = spawnSync('git', ['-C', cwd, ...args], gitOptions())
  if (result.status === 0) return stripEol(result.stdout)
  if (optional) return null
  throw new Error(
    `Cannot inspect Git workspace ${cwd}: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
  )
}

function rootOf(cwd) {
  const gitRoot = inspectGit(cwd, ['rev-parse', '--show-toplevel'], true)
  return gitRoot ? realpathSync(gitRoot) : null
}

function worktreePath(stateDir, memberId) {
  if (!stateDir || !/^[A-Za-z0-9_-]+$/.test(memberId))
    throw new Error('Missing trusted state directory or invalid member ID')
  const parent = join(realpathSync(stateDir), 'worktrees')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  if (!lstatSync(parent).isDirectory())
    throw new Error('NativeCrew worktrees must be a directory inside its state directory')
  return join(parent, memberId)
}

/** Pin the selected source revision before queuing a checkout. Large Git checkouts run asynchronously after commit. */
export function memberWorkspace(cwd, mode, memberId, stateDir) {
  if (!['shared', 'shared-readonly', 'worktree'].includes(mode)) throw new Error('Unsupported workspace mode')
  const sourceRoot = rootOf(cwd)
  if (mode !== 'worktree') return { cwd, workspaceMode: mode, workspaceRoot: sourceRoot ?? cwd }
  if (!sourceRoot) throw new Error('An independent worktree requires a Git repository with a committed HEAD')
  const baseRef = inspectGit(cwd, ['symbolic-ref', '--quiet', 'HEAD'], true)
  const baseCommit = inspectGit(cwd, ['rev-parse', '--verify', `${baseRef ?? 'HEAD'}^{commit}`])
  const subdir = relative(sourceRoot, cwd)
  if (
    subdir &&
    inspectGit(sourceRoot, ['cat-file', '-t', `${baseCommit}:${subdir.split(sep).join('/')}`], true) !== 'tree'
  ) {
    throw new Error(
      'The selected directory is absent from HEAD. Select the repository root or a committed directory.',
    )
  }
  const workspaceRoot = worktreePath(stateDir, memberId)
  return {
    workspaceMode: mode,
    cwd: join(workspaceRoot, subdir),
    workspaceRoot,
    sourceCwd: cwd,
    sourceRoot,
    sourceGitDir: realpathSync(inspectGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])),
    baseCommit,
    baseBranch: baseRef?.replace(/^refs\/heads\//, '') ?? null,
    branch: `godbot/${memberId}`,
  }
}

async function pathExists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function git(cwd, args, signal) {
  const { stdout } = await execute('git', ['-C', cwd, ...args], { ...gitOptions(), signal })
  return stripEol(stdout)
}
function pointsInto(parent, path) {
  const offset = relative(parent, path)
  return offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
}

async function verifyTree(member, expectedPath, signal) {
  if (!(await lstat(expectedPath)).isDirectory()) throw new Error('The managed worktree path is not a directory')
  const opts = ['rev-parse', '--path-format=absolute']
  const [top, repo, branch, listings] = await Promise.all([
    git(expectedPath, [...opts, '--show-toplevel'], signal),
    git(expectedPath, [...opts, '--git-common-dir'], signal),
    git(expectedPath, ['symbolic-ref', '--quiet', 'HEAD'], signal),
    git(expectedPath, ['worktree', 'list', '--porcelain', '-z'], signal),
  ])
  if (
    (await realpath(top)) !== expectedPath ||
    (await realpath(repo)) !== member.sourceGitDir ||
    branch !== `refs/heads/${member.branch}` ||
    !listings.split('\0').includes(`worktree ${expectedPath}`)
  ) {
    throw new Error('The managed worktree is attached to a different checkout, repository or branch')
  }
  const cwd = await realpath(member.cwd)
  if (!pointsInto(expectedPath, cwd) || !(await lstat(cwd)).isDirectory())
    throw new Error('The member directory no longer belongs to its worktree')
  return { cwd, workspaceRoot: expectedPath }
}

async function provision(member, expectedPath, signal) {
  if (
    member.workspaceRoot !== expectedPath ||
    member.branch !== `godbot/${member.id}` ||
    !pointsInto(expectedPath, member.cwd)
  )
    throw new Error('Managed worktree identity changed')
  const existed = await pathExists(expectedPath)
  try {
    if (!existed) {
      const repo = await realpath(
        await git(member.sourceRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal),
      )
      if (repo !== member.sourceGitDir) throw new Error('Source directory now refers to another repository')
      const ref = `refs/heads/${member.branch}`
      // A prior attempt can have created the branch before checkout failed. Attach its current tip; never reset it to baseCommit.
      const branchExists = await git(member.sourceRoot, ['show-ref', '--verify', '--quiet', ref], signal).then(
        () => true,
        (error) => {
          if (error.code === 1) return false
          throw error
        },
      )
      const args = branchExists
        ? [expectedPath, member.branch]
        : ['-b', member.branch, expectedPath, member.baseCommit]
      await git(member.sourceRoot, ['worktree', 'add', '--quiet', ...args], signal)
    }
    return await verifyTree(member, expectedPath, signal)
  } catch (error) {
    // Only Git or the empty-directory primitive may clean a failed checkout. A dirty, moved or mismatched checkout and its ref are always left intact.
    if (!existed) {
      try {
        await rmdir(expectedPath)
      } catch (cleanupError) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(cleanupError.code))
          throw new AggregateError([error, cleanupError], `Failed to provision and clean ${expectedPath}`)
      }
    }
    throw new Error(`Could not prepare NativeCrew worktree ${expectedPath}: ${error.message}`, { cause: error })
  }
}

/** Retrying a workspace-error member reuses its identity and original base; existing local edits and commits stay in place. */
export function prepareMemberWorkspace(member, stateDir, { signal } = {}) {
  if (member.workspaceMode !== 'worktree')
    return Promise.resolve({ cwd: member.cwd, workspaceRoot: member.workspaceRoot ?? member.cwd })
  const path = worktreePath(stateDir, member.id)
  let current = provisioning.get(path)
  if (!current) {
    current = provision(member, path, signal).finally(() => provisioning.delete(path))
    provisioning.set(path, current)
  }
  return current
}

function accessRoot(member) {
  if (member.workspaceRoot) return member.workspaceRoot
  // Older member records only persisted a cwd. A renamed or removed directory may still belong to an unconfirmed native turn.
  try {
    const cwd = realpathSync(member.cwd)
    return rootOf(cwd) ?? cwd
  } catch {
    return resolve(member.cwd)
  }
}

/** Select under the same transaction that claims the turn. The callback must reflect a host-enforced read-only sandbox. */
export function workspaceBlocker(member, members, isEnforcedReadOnly = () => false) {
  const root = accessRoot(member)
  return members.find((other) => {
    if (other.id === member.id || (!other.activeTurnId && !other.terminalOwned && other.status !== 'unknown')) return false
    if (isEnforcedReadOnly(member) && isEnforcedReadOnly(other)) return false
    const occupied = accessRoot(other)
    return pointsInto(root, occupied) || pointsInto(occupied, root)
  })
}

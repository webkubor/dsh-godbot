import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const currentTeamDirectory = 'team-workspace'
export const previousTeamDirectory = 'ds-bot'

// Keep existing workspaces in place. DSH sessions, worktrees and browser volumes
// can all refer to this exact directory, including outside the NativeCrew database.
export function workspaceHome(stateDir) {
  const current = join(stateDir, currentTeamDirectory)
  const previous = join(stateDir, previousTeamDirectory)
  if (!existsSync(previous)) return current
  if (existsSync(current)) {
    throw new Error(`Two team workspace directories exist: ${current} and ${previous}. Stop DSH and move the inactive one aside before reopening this profile.`)
  }
  return previous
}

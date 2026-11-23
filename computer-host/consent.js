import { spawn } from 'node:child_process'
import { claimComputerInput } from '../src/host/computer-input-lock.js'

// A local terminal can decide the same request while the dialog is open.
// The caller aborts this prompt after expiry, revocation, or a CLI decision.
export async function askLocal({ name, account }, scope, signal) {
  if (signal.aborted) return
  const message =
    'Controller: ' +
    name +
    '\n' +
    (scope === 'terminal'
      ? 'Allow an interactive shell as ' + account + ' for this session?'
      : scope === 'desktop.control'
        ? 'Allow this controller to use your keyboard and pointer for this session?'
        : 'Allow this controller to view your desktop for this session?')
  let command, args
  if (process.platform === 'darwin') {
    command = '/usr/bin/osascript'
    args = [
      '-e',
      'on run argv',
      '-e',
      'display dialog (item 1 of argv) with title "NativeCrew Computer Host" buttons {"Decline", "Allow once"} default button "Decline" cancel button "Decline" giving up after 55',
      '-e',
      'if gave up of result then return "decline"',
      '-e',
      'return "allow"',
      '-e',
      'end run',
      '--',
      message,
    ]
  } else if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    command = 'zenity'
    args = [
      '--question',
      '--title=NativeCrew Computer Host',
      '--default-cancel',
      '--no-markup',
      '--ok-label=Allow once',
      '--cancel-label=Decline',
      '--timeout=55',
      '--text=' + message,
    ]
  } else return
  const release = claimComputerInput('consent')
  try {
    return await new Promise((resolve) => {
      const cp = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], signal })
      let output = ''
      cp.stdout.on('data', (bytes) => {
        output += bytes.toString().slice(0, 256)
      })
      cp.on('error', () => resolve(undefined))
      cp.once('close', (code) => {
        if (signal.aborted) resolve(undefined)
        else if (command === '/usr/bin/osascript') resolve(code === 0 && output.trim() === 'allow')
        else resolve(code === 0)
      })
    })
  } finally {
    release()
  }
}

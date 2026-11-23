// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Settings → About NativeCrew: the version, updates for NativeCrew and DSH (with the
// automatic update mode), and the links to the repository. The sidebar's cloud
// button shows the same update state.
import { version } from '../../../package.json'
import { webIconUrl } from '../../host/web-icon.js'
import { createElement as h, useState } from 'react'
import { GitHubMark } from './connector-marks.js'
import { whenText } from './feedback.js'
import { hostText, t } from './i18n.js'
import { showsDshRow } from './dsh-offer.js'

// What an automatic install waits for, read from the host's busy reasons.
function waitingText(waiting) {
  const turns = waiting?.find(reason => reason.kind === 'turns')?.count
  if (turns) return t('It installs once no Bot is working ({count} running).', { count: turns })
  if (waiting?.some(reason => reason.kind === 'terminals')) return t('It installs once every native terminal is handed back.')
  return t('It installs in a moment, while NativeCrew is idle.')
}

export function blockedText(update) {
  const blocked = update.blocked ?? {}
  if (blocked.reason === 'dsh') return t('NativeCrew {version} needs DSH {dsh}.', { version: update.latest, dsh: blocked.dsh })
  if (blocked.reason === 'peers') return t('NativeCrew {version} needs a fresh install: run scripts/install-local.mjs again.', { version: update.latest })
  return t('The NativeCrew {version} download does not match its release.', { version: update.latest })
}

export function downloadText(update) {
  const { done = 0, total = null } = update.progress ?? {}
  return total > 0
    ? t('Downloading NativeCrew {version}… {percent}%', { version: update.latest, percent: Math.min(100, Math.floor((done / total) * 100)) })
    : t('Downloading NativeCrew {version}…', { version: update.latest })
}

/** Two sentences of copy: a space between them, none after CJK end punctuation. */
export const sentences = (first, second) => (/[。！？]$/u.test(first) ? `${first}${second}` : `${first} ${second}`)

/** The line for a downloaded release: when it installs, or that it waits for a click. */
export function readyText(update) {
  const downloaded = t('NativeCrew {version} is downloaded.', { version: update.latest })
  return sentences(downloaded, update.mode === 'auto' ? waitingText(update.waiting) : t('Install it when you are ready.'))
}

function botHint(update) {
  if (update.phase === 'installing') return t('Updating NativeCrew…')
  if (update.phase === 'installed') return t('Restart DSH to start using NativeCrew {version}.', { version: update.installed ?? update.latest })
  if (update.phase === 'updated') return t('NativeCrew {version} is installed.', { version: update.installed ?? update.latest })
  if (update.phase === 'downloading') return downloadText(update)
  if (update.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(update.error ?? '') })
  if (update.blocked) return blockedText(update)
  if (update.phase === 'ready') return readyText(update)
  if (update.available) return t('NativeCrew {version} is available', { version: update.latest })
  if (update.source === 'app') return t('Updates are managed by the desktop host that installed this workspace.')
  if (update.enabled === false) return t('Update checks are off.')
  if (update.source === 'path') return t('Installed from a local folder; update it there.')
  if (!update.checkedAt) return null
  if (!update.latest && !['registry', 'archive'].includes(update.source)) return t('Updates are not offered for this install.')
  const checked = t('Checked {time}', { time: whenText(update.checkedAt) })
  // A registry that answers nothing was not reached; a release list can simply be empty.
  const failed = update.checkFailed === true || (update.source === 'registry' && !update.latest)
  return `${failed ? t('Could not check for updates.') : t('Up to date')} · ${checked}`
}

// The sources NativeCrew can update by itself, and so offer the automatic modes for.
const SELF_UPDATING = new Set(['archive', 'registry', 'git'])

function modeHint(mode) {
  if (mode === 'notify') return t('Checks every six hours and downloads new releases; you choose when to install.')
  if (mode === 'off') return t('NativeCrew checks only when you click Check for updates.')
  return t('Checks every six hours, downloads new releases and installs them while NativeCrew is idle.')
}

// A desktop host can supply its packaged update state through the NativeCrew bridge.
export function ownAppRow(ownApp) {
  if (ownApp === null || typeof ownApp !== 'object') return null
  const version = typeof ownApp.version === 'string' ? ownApp.version : ''
  switch (ownApp.phase) {
    case 'checking': return { hint: t('Checking for updates…'), button: null }
    case 'current': return { hint: t('Up to date'), button: 'check' }
    case 'downloading': return { hint: t('Downloading {version}…', { version }), button: null }
    case 'downloaded': return { hint: t('{version} is ready; it installs when you restart', { version }), button: 'restart' }
    case 'available': return { hint: t('{version} is available', { version }), button: 'open' }
    case 'failed': return { hint: t('Could not check for updates.'), button: 'check' }
    default: return null
  }
}

function dshHint(dsh, shown) {
  if (dsh.phase === 'installing') return t('Updating DSH…')
  if (dsh.phase === 'installed') return t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
  if (dsh.phase === 'failed') return t('The update did not finish: {reason}', { reason: hostText(dsh.error ?? '') })
  if (dsh.available === false && dsh.blockedBy) return t('Update NativeCrew {version} first.', { version: dsh.blockedBy })
  if (shown) return t('DSH {version} is available', { version: dsh.verified })
  return t('Version {version}', { version: dsh.current })
}

const linkProps = href => ({ className: 'bt-soft bt-soft-sm bt-about-link', href, target: '_blank', rel: 'noopener noreferrer' })

export function RestartDshButton({ update, actions, className }) {
  const pending = update.restart?.pending === true
  if (!update.canRestartDsh && !pending) return null
  return h('button', {
    type: 'button', className, disabled: pending, 'aria-live': 'polite', onClick: actions.restartDsh,
  }, pending ? t('Restarting DSH…') : t('Restart DSH'))
}

export function AboutPage({ useUpdate, actions, run, Section, Row }) {
  const update = useUpdate(value => value) ?? {}
  const [checking, setChecking] = useState(false)
  const check = async () => {
    setChecking(true)
    try { await run(actions.checkUpdate()) } finally { setChecking(false) }
  }
  const phase = update.phase ?? 'idle'
  const dsh = update.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  // Same rule as the sidebar card.
  const dshNew = showsDshRow(dsh, update.app)
  const dshShown = dshNew && dsh.available
  const ownRow = update.source === 'app' ? ownAppRow(update.ownApp) : null
  const restartControl = h(RestartDshButton, { update, actions, className: 'bt-fb-primary' })
  const ownControl = ownRow?.button === 'restart'
    ? h('button', { type: 'button', className: 'bt-fb-primary', onClick: () => run(actions.installOwnApp()) }, t('Restart to update'))
    : ownRow?.button === 'check'
      ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.checkOwnApp()) }, t('Check for updates'))
      : ownRow?.button === 'open'
        ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openOwnApp()) }, t('Download'))
        : null
  const botControl = ownRow !== null ? ownControl
    : phase === 'installed' ? restartControl
    : phase === 'updated' || update.source === 'app' ? null
    : update.available || phase === 'installing'
      ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: phase === 'installing', onClick: () => run(actions.installUpdate()) },
          phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : phase === 'downloading' ? t('Install when downloaded') : t('Update'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: checking || update.enabled === false, onClick: check }, checking ? t('Checking…') : t('Check for updates'))
  const modeControl = update.enabled !== false && typeof update.mode === 'string' && SELF_UPDATING.has(update.source)
    ? h(Row, { label: t('Automatic updates'), hint: modeHint(update.mode) },
        h('select', {
          className: 'bt-select', 'aria-label': t('Automatic updates'), value: update.mode,
          onChange: event => run(actions.setUpdateMode(event.target.value)),
        },
        h('option', { value: 'auto' }, t('Install automatically')),
        h('option', { value: 'notify' }, t('Download, then ask')),
        h('option', { value: 'off' }, t('Check manually'))))
    : null
  const dshControl = !dshNew ? null
    : dshPhase === 'installed' ? phase === 'installed' ? null : restartControl
    : dsh.kind === 'app'
      ? dsh.available ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.openAppUpdates(dsh.verified)) }, t('Open updates')) : null
      : dsh.available || dshPhase !== 'idle'
        ? h('button', { type: 'button', className: 'bt-fb-primary', disabled: dshPhase === 'installing', onClick: () => run(actions.installDshUpdate()) },
            dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update'))
        : null
  const repo = update.repoUrl
  return [
    h('div', { key: 'hero', className: 'bt-about-hero' },
      h('img', { className: 'bt-about-mark', src: webIconUrl, width: 48, height: 48, alt: '' }),
      h('div', { className: 'bt-about-copy' },
        h('span', { className: 'bt-about-name' }, 'NativeCrew'),
        h('span', { className: 'bt-about-version' }, t('Version {version}', { version })))),
    h(Section, { key: 'updates', title: t('Updates') },
      h(Row, { label: 'NativeCrew', hint: ownRow?.hint ?? botHint(update) }, botControl, update.available && update.notesUrl ? h('a', linkProps(update.notesUrl), t("What's new")) : null),
      modeControl,
      dsh?.current ? h(Row, { label: 'DeepSeek Harness', hint: dshHint(dsh, dshShown) }, dshControl) : null,
      update.restart?.error ? h('div', { className: 'bt-error', role: 'alert' }, update.restart.error) : null),
    h(Section, { key: 'links', title: t('Links') },
      repo ? h(Row, { label: t('Source code'), hint: repo.replace(/^https:\/\//, '') }, h('a', linkProps(repo), h(GitHubMark), t('Open'))) : null,
      update.notesUrl ? h(Row, { label: t('Release notes') }, h('a', linkProps(update.notesUrl), t('Open'))) : null,
      h(Row, { label: t('Report a problem') }, h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openSettings('feedback') }, t('Open')))),
  ]
}

export const ABOUT_CSS = `
.bt-about-hero{display:flex;align-items:center;gap:14px;padding:16px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-about-mark{display:block;flex:none;border-radius:12px}
.bt-about-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-about-name{font-size:16px;line-height:22px;font-weight:600}
.bt-about-version{font-size:12px;line-height:16px;color:var(--bt-ink-2);font-variant-numeric:tabular-nums}
.bt-about-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
.bt-about-link svg{width:14px;height:14px}
.bt-fb-primary:disabled{opacity:.6;cursor:default;filter:none}
`

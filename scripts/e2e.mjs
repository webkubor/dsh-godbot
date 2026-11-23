import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildArchive, inspectArchive, repository, saveEvidence } from '../test/e2e/artifacts.mjs'
import { createHost, EnvironmentError, installedVersions, openBrowser, redact } from '../test/e2e/host.mjs'

const { values } = parseArgs({ options: {
  case: { type: 'string' }, suite: { type: 'string' }, artifact: { type: 'string' },
  previous: { type: 'string' }, 'report-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} })
if (values.help) {
  console.log('node scripts/e2e.mjs [--case E0|--suite release|all|live-connectors|live-routines] [--artifact <tgz>] [--previous <tgz>] [--report-dir <output>]')
} else {
  if (values.case && values.suite) throw new Error('Select a case or a suite')
  // E12 upgrades from the 0.1.0 build committed at this revision. Clones without
  // that commit (such as the public history) skip E12 unless --previous is given.
  const upgradeBaseline = '71e8cac'
  const hasRevision = revision => {
    try {
      execFileSync('git', ['cat-file', '-e', revision + '^{commit}'], { cwd: repository, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  const release = ['WORKSPACE-CAPABILITIES', 'BOT-MANAGEMENT', 'NEW-SESSION', 'BACKGROUND-REPLY', 'E0', 'E1', 'E2', 'E4', 'E4-FULL', 'E5', 'E8', 'E12', 'E13', 'E15', 'E16', 'E17', 'UPDATE', 'PHONE', 'PHONE-PAGES', 'REMOTE-COMPUTERS']
  const all = ['WORKSPACE-CAPABILITIES', 'BOT-MANAGEMENT', 'NEW-SESSION', 'BACKGROUND-REPLY', ...Array.from({ length: 18 }, (_, i) => 'E' + i).filter(id => id !== 'E3').flatMap(id => id === 'E4' ? [id, 'E4-FULL'] : [id]), 'UPDATE', 'PHONE', 'PHONE-PAGES', 'REMOTE-COMPUTERS']
  const connectorCases = ['L-CLAUDE', 'L-CODEX']
  const routineFiles = { 'L-TEAM-ROUTINES': 'live-team-routines.mjs', 'L-BOT-WORKFLOW': 'live-bot-workflow.mjs' }
  const androidCases = ['PHONE-ANDROID', 'PHONE-TOOLS']
  const live = [...connectorCases, ...Object.keys(routineFiles), 'L-SANDBOX']
  const suites = { release, all, 'live-connectors': connectorCases, 'live-routines': Object.keys(routineFiles) }
  if ((values.case && ![...all, ...live, ...androidCases].includes(values.case)) || (values.suite && !Object.hasOwn(suites, values.suite))) throw new Error('Unknown case or suite')
  const cases = values.case ? [values.case] : suites[values.suite ?? 'release']
  const reportDir = values['report-dir'] ? resolve(values['report-dir']) : await mkdtemp(join(tmpdir(), 'godbot-e2e-report-'))
  await mkdir(reportDir, { recursive: true, mode: 0o700 })
  const scratch = await mkdtemp(join(tmpdir(), 'godbot-e2e-'))
  const report = { startedAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
    platform: process.platform + '-' + process.arch, versions: installedVersions(), cases: cases.map(id => ({ id, status: 'not-run', evidence: [] })),
    level: androidCases.includes(values.case) ? 'packaged Android app / emulator / relay / packaged DSH Web / fixture agents'
      : cases.some(id => live.includes(id)) ? 'packaged DSH Web / browser / authenticated native CLI / local test application' : 'packaged DSH Web / browser / fixture models' }
  await saveEvidence(reportDir, 'report.json', report)
  let browser
  try {
    const candidate = values.artifact ? await inspectArchive(values.artifact) : await buildArchive(scratch)
    report.archive = { sha256: candidate.sha256, buildId: candidate.buildId, version: candidate.version }
    let previous
    if (cases.includes('E12')) {
      if (values.previous) previous = await inspectArchive(values.previous)
      else if (hasRevision(upgradeBaseline)) previous = await buildArchive(scratch, upgradeBaseline)
      if (previous) report.previous = { sha256: previous.sha256, buildId: previous.buildId, version: previous.version }
    }
    const launch = await openBrowser()
    browser = launch.browser
    report.browser = { engine: browser.browserType().name(), version: browser.version(), source: launch.source }
    console.log('Browser: ' + report.browser.engine + ' ' + report.browser.version + ' (' + launch.source + ')')
    for (const row of report.cases) {
      const { id } = row
      const scenarioFile = connectorCases.includes(id) ? 'live-connectors.mjs' : (routineFiles[id] ?? 'cases/' + id + '.mjs')
      const file = new URL('../test/e2e/' + scenarioFile, import.meta.url)
      const hosts = []
      const dir = join(reportDir, id)
      await mkdir(dir, { recursive: true })
      const note = (event, detail) => row.evidence.push({ event, time: new Date().toISOString(), ...detail })
      try {
        if (!existsSync(file)) {
          row.reason = 'Scenario has no implementation'
          continue
        }
        if (id === 'E12' && !previous) {
          row.status = 'skipped'
          row.reason = 'Upgrade baseline ' + upgradeBaseline + ' is not in this checkout; pass --previous <tgz> to run E12'
          console.log(row.reason)
          continue
        }
        // PHONE needs a godbot-server relay binary (renjiegod/godbot-server, go build ./cmd/godbot-relay).
        if ((id.startsWith('PHONE') || id === 'REMOTE-COMPUTERS') && !process.env.GODBOT_RELAY_BIN) {
          row.status = 'skipped'
          row.reason = 'Set GODBOT_RELAY_BIN to a godbot-relay binary to run ' + id
          console.log(row.reason)
          continue
        }
        console.log('Running ' + id)
        const check = (await import(file)).default
        if (typeof check !== 'function') throw new Error('Missing case implementation')
        const makeHost = async (options = {}) => {
          const host = await createHost({ scratch, browser, reportDir: dir, note }, options)
          hosts.push(host)
          return host
        }
        await check({ makeHost, candidate, previous, reportDir: dir, scratch, note, scenario: id })
        if (!row.evidence.some(item => item.event === 'started' && item.buildId === candidate.buildId && item.clientSha256 === candidate.clientSha256)) {
          throw new Error('Scenario did not load the candidate Host and browser client')
        }
        row.status = 'passed'
      } catch (error) {
        row.status = error instanceof EnvironmentError ? 'environment-failure' : 'failed'
        row.reason = redact(error.stack ?? error)
        console.error(row.reason)
        for (const [index, host] of hosts.entries()) await host.capture('failure-' + index).catch(() => {})
      } finally {
        for (const host of hosts.reverse()) {
          try { await host.close() } catch (error) { row.status = 'environment-failure'; row.cleanupError = redact(error.message) }
        }
        console.log(id + ' ' + row.status)
        await saveEvidence(reportDir, 'report.json', report)
      }
    }
  } catch (error) {
    report.environmentFailure = redact(error.stack ?? error)
    for (const row of report.cases) if (row.status === 'not-run' && !row.reason) row.reason = 'Setup failed before this scenario could run'
    console.error(report.environmentFailure)
  } finally {
    await browser?.close()
    await rm(scratch, { recursive: true, force: true })
    report.endedAt = new Date().toISOString()
    await saveEvidence(reportDir, 'report.json', report)
    console.log('NativeCrew E2E report: ' + join(reportDir, 'report.json'))
    if (report.environmentFailure || report.cases.some(row => row.status !== 'passed' && row.status !== 'skipped') || report.cases.length !== cases.length) process.exitCode = 1
  }
}

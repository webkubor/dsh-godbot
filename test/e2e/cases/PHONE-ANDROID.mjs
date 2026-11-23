// PHONE-ANDROID: the real NativeCrew Android app on an emulator pairs with this NativeCrew through a
// godbot-server relay, loads the team, sends the Main Bot a message and shows the Bot's reply.
// Needs GODBOT_RELAY_BIN (godbot-relay), GODBOT_ANDROID_E2E (a godbot-app checkout with a built
// APK) and a running emulator; ANDROID_SERIAL picks one when several are attached.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { saveEvidence } from '../artifacts.mjs'
import { EnvironmentError, until } from '../host.mjs'
import { startRelay } from '../phone-relay.mjs'

async function channel(host, endpoint, payload = null) {
  const res = await host.page.context().request.post(host.url + '/api/godbot/team', {
    data: { endpoint, payload }, headers: { Origin: host.url }, timeout: 15_000,
  })
  assert.ok(res.ok(), 'team channel ' + endpoint + ' returned HTTP ' + res.status())
  const result = await res.json()
  if (!result.ok) throw Object.assign(new Error(endpoint + ': ' + result.error?.message), { code: result.error?.code })
  return result.value
}

function runApp(app, env) {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(process.execPath, [join(app, 'e2e', 'android.mjs')], { cwd: app, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = chunk => { output = (output + chunk).slice(-64_000) }
    child.stdout.setEncoding('utf8').on('data', collect)
    child.stderr.setEncoding('utf8').on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), 8 * 60_000)
    child.once('error', reject)
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error('The app e2e script failed (' + code + '):\n' + output.slice(-6000)))
    })
  })
}

// Text currently on the emulator's screen, from a uiautomator dump.
function screenText() {
  const serial = process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : []
  const xml = execFileSync('adb', [...serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { encoding: 'utf8', timeout: 30_000 })
  return [...xml.matchAll(/(?:text|content-desc)="([^"]*)"/g)].map(match => match[1]).join('\n')
}

export default async function check({ makeHost, candidate, reportDir, scratch, note }) {
  const app = process.env.GODBOT_ANDROID_E2E
  if (!app) throw new EnvironmentError('Set GODBOT_ANDROID_E2E to a godbot-app checkout to run PHONE-ANDROID')
  try { execFileSync('adb', ['get-state'], { stdio: 'ignore', timeout: 10_000 }) }
  catch { throw new EnvironmentError('No Android emulator or device is attached (adb get-state failed)') }
  const relay = await startRelay(scratch, note)
  try {
    const host = await makeHost()
    await host.install(candidate)
    await host.start()
    await channel(host, 'phone-set', { server: relay.url, on: true })
    await until(async () => (await channel(host, 'phone-set', {})).status === 'online', 'NativeCrew online at the relay', 30_000)
    const { pairing } = await channel(host, 'phone-pair')
    assert.ok(pairing.uri.startsWith('godbot://pair?'))

    const marker = 'ANDROID-' + Date.now()
    host.model.reply = body => JSON.stringify(body.messages ?? []).includes(marker) ? 'Reply for ' + marker : 'Fixture acknowledged'
    const output = await runApp(app, { GODBOT_E2E_PAIRING_URI: pairing.uri, GODBOT_E2E_MESSAGE: 'ping ' + marker })
    note('app-script', { lines: output.split('\n').filter(line => line.startsWith('✓')).slice(0, 20) })

    // The computer sees the phone, connected, and the message in the Main Bot's chat.
    const view = await until(async () => {
      const current = await channel(host, 'phone-set', {})
      return current.phones.find(row => row.connected) ? current : undefined
    }, 'the Android phone connected on the computer', 30_000)
    const phone = view.phones.find(row => row.connected)
    note('phone', { name: phone.name, push: phone.push })

    // The Bot's reply travels back over the link and shows in the app.
    await until(() => screenText().includes('Reply for ' + marker), 'the Bot reply on the phone screen', 60_000)
    note('reply-on-phone', { marker })

    // Keep connected in background: the app's foreground service holds the link, and news for
    // a phone whose app is in the background becomes a system notification.
    const ui = await import(pathToFileURL(join(app, 'e2e', 'adb.mjs')).href)
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Open team list', '打开团队列表'), 'the team list button'))
    ui.tap(await ui.waitFor(nodes => ui.find(nodes, 'Settings', '设置'), 'the Settings button'))
    const keepAlive = nodes => nodes.find(node => node.cls.endsWith('Switch') && /Keep connected in background|后台保持连接/.test(node.desc))
    ui.tap(await ui.waitFor(keepAlive, 'the keep-alive switch'))
    await until(() => /NativeCrewKeepAlive|KeepAliveService|keepalive/i.test(ui.shell(`dumpsys activity services ${ui.PACKAGE}`)), 'the keep-alive service running', 20_000)
    ui.screenshot('phone-android-keepalive-on')
    ui.shell('input keyevent KEYCODE_HOME')
    const background = 'BACKGROUND-' + Date.now()
    host.model.reply = body => JSON.stringify(body.messages ?? []).includes(background) ? 'Away reply for ' + background : 'Fixture acknowledged'
    const pushesBefore = relay.google.messages.length
    const state = await host.bot('state')
    const lead = state.bots.find(bot => bot.id === state.mainBotId)
    await host.bot('send', { sessionId: lead.sessionId ?? lead.id, text: 'ping ' + background })
    await until(() => ui.shell('dumpsys notification --noredact').includes('Away reply for ' + background), 'the reply as a system notification while the app is in the background', 60_000)
    ui.shell('cmd statusbar expand-notifications')
    await new Promise(resolve => setTimeout(resolve, 1500))
    ui.screenshot('phone-android-background-notification')
    ui.shell('cmd statusbar collapse')
    assert.equal(relay.google.messages.length, pushesBefore, 'a connected phone is told over the link, not by push')
    note('background-notification', { marker: background })

    // Turn the service off again, as the person would.
    ui.shell(`monkey --pct-syskeys 0 -p ${ui.PACKAGE} -c android.intent.category.LAUNCHER 1`)
    const toggle = await ui.waitFor(keepAlive, 'the keep-alive switch after reopening', { timeout: 20_000 }).catch(() => undefined)
    if (toggle) ui.tap(toggle)
    await saveEvidence(reportDir, 'android.json', { relay: relay.url, phone: { name: phone.name, push: phone.push }, marker, background })
  } finally {
    await relay.close()
  }
}

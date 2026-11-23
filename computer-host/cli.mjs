#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { defaultHome, localRequest } from './local.js'
import { startComputerHost } from './runtime.js'

const help = `NativeCrew Computer Host

  godbot-computer start --relay wss://<relay>/v1/link [--name NAME]
  godbot-computer status | controllers | sessions | history
  godbot-computer manage
  godbot-computer pair [--qr | --out FILE]
  godbot-computer grant DEVICE_ID terminal|desktop.view|desktop.control
  godbot-computer ungrant DEVICE_ID SCOPE
  godbot-computer remember-portal DEVICE_ID desktop.view|desktop.control
  godbot-computer forget-portal DEVICE_ID desktop.view|desktop.control
  godbot-computer approve|deny|stop SESSION_ID
  godbot-computer revoke DEVICE_ID
  godbot-computer install-service [--relay URL] [--name NAME] [--headless]
  godbot-computer uninstall-service

--home DIRECTORY selects the host identity and local control socket.
--headless starts a terminal-only host. --no-prompts uses local CLI decisions.
On Wayland, remember-portal lets this controller reuse a screen you select in
the local system picker. Grant the matching desktop scope first. View and
control each have their own setting. Use forget-portal to clear one setting.
A shell grant runs a real interactive shell as the current OS user.`

async function main() {
  const {
    values,
    positionals: [command, ...args],
  } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' },
      relay: { type: 'string' },
      name: { type: 'string' },
      headless: { type: 'boolean' },
      'no-prompts': { type: 'boolean' },
      help: { type: 'boolean' },
      out: { type: 'string' },
      qr: { type: 'boolean' },
    },
  })
  if (values.help || !command || command === 'help') {
    console.log(help)
    return
  }
  const directory = resolve(values.home || defaultHome())
  const options = {
    home: directory,
    relay: values.relay,
    name: values.name,
    headless: values.headless,
    noPrompts: values['no-prompts'],
  }
  if (command === 'manage') {
    const { openManagementWindow } = await import('./manage.js')
    await openManagementWindow(directory); return
  }
  if (command === 'install-service' || command === 'uninstall-service') {
    const { manageService } = await import('./service-install.js')
    await manageService(command === 'install-service', options)
    return
  }
  if (command === 'start') {
    const host = await startComputerHost(options)
    let exiting = false
    const stop = async () => {
      if (exiting) return
      exiting = true
      await host.close()
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
    console.log('NativeCrew Computer Host started for ' + host.deviceId)
    return
  }
  const result = await localRequest(directory, command, args)
  if (command === 'pair') {
    if (values.out) {
      writeFileSync(resolve(values.out), result.uri + '\n', { mode: 0o600, flag: 'wx' })
      console.log('Pairing offer written. Expires ' + new Date(result.expiresAt).toISOString())
    } else if (values.qr) {
      const { default: qrCode } = await import('qrcode-generator')
      const qr = qrCode(0, 'M')
      qr.addData(result.uri)
      qr.make()
      console.log(qr.createASCII(1, 2))
      console.log('Scan with NativeCrew. Expires ' + new Date(result.expiresAt).toISOString())
    } else console.log(result.uri)
  } else console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(
    err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
      ? 'The local computer host is not running.'
      : String(err.message || err),
  )
  process.exitCode = 1
})

// The separate probe and stream helpers may observe different display layouts.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createDesktopAdapter } from '../desktop.js'

test('rejects a layout change between probe and native stream readiness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'godbot-geometry-race-'))
  const osHelper =
    process.platform === 'darwin'
      ? join(root, 'NativeCrew Computer Host.app', 'Contents', 'MacOS', 'godbot-screen')
      : join(root, 'godbot-screen')
  const fixture = join(root, 'stream-revision')
  const rtc = join(root, 'godbot-desktop-rtc')
  const previousRuntime = process.env.GODBOT_DESKTOP_RUNTIME
  const previousEncoder = process.env.GODBOT_DESKTOP_FFMPEG
  t.after(async () => {
    if (previousRuntime === undefined) delete process.env.GODBOT_DESKTOP_RUNTIME
    else process.env.GODBOT_DESKTOP_RUNTIME = previousRuntime
    if (previousEncoder === undefined) delete process.env.GODBOT_DESKTOP_FFMPEG
    else process.env.GODBOT_DESKTOP_FFMPEG = previousEncoder
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(dirname(osHelper), { recursive: true })
  await writeFile(rtc, '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 })
  await writeFile(
    osHelper,
    '#!/usr/bin/env node\n' +
      `
const fs=require('node:fs')
if (process.argv[2]==='launch') process.argv.splice(2,1)
if (process.argv[2]==='probe') {
  console.log(JSON.stringify({available:true,control:true,displays:[{id:'7',name:'Monitor',width:800,height:600,revision:104}]}))
} else {
  fs.writeFileSync(${JSON.stringify(fixture)},process.argv[7]||'missing')
  console.log(JSON.stringify({type:'ready',revision:105,control:true}))
  process.stdin.resume()
}
`,
    { mode: 0o700 },
  )
  process.env.GODBOT_DESKTOP_RUNTIME = root
  process.env.GODBOT_DESKTOP_FFMPEG = rtc
  await assert.rejects(
    createDesktopAdapter({ directory: root }).start({
      sessionId: 'geometry-test',
      displayId: '7',
    }),
    /Display geometry changed before sharing/,
  )
  assert.equal(await readFile(fixture, 'utf8'), '104')
})

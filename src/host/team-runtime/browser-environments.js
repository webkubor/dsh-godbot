import { chromium } from 'playwright-core'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const viewport = { width: 1200, height: 760 }
const label = 'io.godbot.browser-owner'
const hostLabel = 'io.godbot.browser-profile'
const profileKey = home => createHash('sha256').update(home).digest('hex')

function dockerCommand(config, target) {
  const command = config.dockerCommand || 'docker'
  const context = target === 'cloud' ? config.cloudContext : config.containerContext
  if (target === 'cloud' && !context) throw new Error('Cloud browser requires an explicitly configured remote Docker context')
  const prefix = context ? ['--context', context] : []
  return {
    run: async (...args) => (await exec(command, [...prefix, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim(),
    pipe: args => spawn(command, [...prefix, ...args], { stdio: ['pipe', 'pipe', 'ignore'] }),
  }
}

function resource(home, botId) {
  const id = createHash('sha256').update(home).update('\0').update(botId).digest('hex')
  return { id, name: 'godbot-browser-' + id.slice(0, 24) }
}

async function inspect(docker, type, name, id) {
  try {
    const labelPath = type === 'volume' ? '.Labels' : '.Config.Labels'
    const owner = await docker.run(type, 'inspect', '--format', '{{index ' + labelPath + ' "' + label + '"}}', name)
    if (owner !== id) throw new Error('Browser resource name belongs to a different workspace')
    return true
  } catch (error) {
    if (/no such (volume|container|object)/iu.test(error.stderr || '')) return false
    throw error
  }
}

// Forward only the single browser WebSocket owned by this allocation. Docker never publishes a CDP port.
async function bridge(docker, container, path) {
  const localPath = '/' + randomUUID()
  const connections = new Set()
  const server = createServer((_, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key']
    if (req.url !== localPath || !/^[A-Za-z0-9+/]{22}==$/u.test(key ?? '')) return socket.destroy()
    const wire = docker.pipe(['exec', '-i', container, 'socat', '-', 'TCP4:127.0.0.1:9222'])
    connections.add(socket)
    socket.on('close', () => { connections.delete(socket); wire.kill() })
    socket.on('error', () => socket.destroy())
    wire.on('error', () => socket.destroy())
    wire.stdin.on('error', () => socket.destroy())
    wire.once('close', () => socket.destroy())
    wire.stdin.write('GET ' + path + ' HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n')
    if (head.length) wire.stdin.write(head)
    socket.pipe(wire.stdin)
    wire.stdout.pipe(socket)
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return {
    endpoint: 'ws://127.0.0.1:' + server.address().port + localPath,
    close: () => new Promise(resolve => {
      server.close(resolve)
      for (const socket of connections) socket.destroy()
    }),
  }
}

async function browserSocket(docker, name) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const raw = await docker.run('exec', name, 'wget', '-qO-', 'http://127.0.0.1:9222/json/version')
      const path = new URL(JSON.parse(raw).webSocketDebuggerUrl).pathname
      if (/^\/devtools\/browser\/[\w-]+$/u.test(path)) return path
    } catch { /* Chromium may not have opened its listener yet. */ }
    await delay(180)
  }
  throw new Error('The isolated Chromium process did not open its browser session')
}

async function stopOwned(docker, name, id) {
  if (!await inspect(docker, 'container', name, id)) return
  await docker.run('stop', '-t', '5', name)
  await docker.run('rm', '-f', name)
}

export async function recoverContainers(home, target, config) {
  const docker = dockerCommand(config, target)
  if (target === 'cloud') {
    const device = JSON.parse(await docker.run('context', 'inspect', config.cloudContext))[0]?.Endpoints?.docker?.Host
    if (!/^(?:ssh|tcp|https):\/\//u.test(String(device)) || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(device).hostname)) {
      throw new Error('云端容器需要专用远程 Docker context')
    }
  }
  const names = await docker.run('ps', '-a', '--filter', 'label=' + hostLabel + '=' + profileKey(home), '--format', '{{.Names}}')
  for (const name of names.split(/\s+/u).filter(Boolean)) {
    const id = await docker.run('container', 'inspect', '--format', '{{index .Config.Labels "' + label + '"}}', name)
    if (/^[0-9a-f]{64}$/u.test(id) && name === 'godbot-browser-' + id.slice(0, 24)) await stopOwned(docker, name, id)
  }
}

export async function removeVolume(home, botId, target, config) {
  const docker = dockerCommand(config, target)
  const { id, name } = resource(home, botId)
  await stopOwned(docker, name, id)
  if (await inspect(docker, 'volume', name, id)) await docker.run('volume', 'rm', name)
}

const desktopKeys = { Enter: 'Return', Tab: 'Tab', 'Shift+Tab': 'shift+Tab', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next' }

function isolatedDisplay(docker, name) {
  const run = (...args) => docker.run('exec', name, ...args)
  const windowId = async () => {
    const token = await run('xdotool', 'getactivewindow')
    if (!/^\d+$/u.test(token)) throw new Error('The desktop has no focused window')
    return token
  }
  return {
    async frame() {
      const id = await windowId()
      const script = `set -eu; dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT; scrot -q 45 "$dir/frame.jpg"; base64 "$dir/frame.jpg"`
      const data = await run('sh', '-c', script)
      return { data: data.replace(/\s+/gu, ''), window: id, viewport, title: await run('xdotool', 'getwindowname', id) }
    },
    async input(req, wanted) {
      if (await windowId() !== wanted) throw new Error('桌面窗口已切换，请刷新画面')
      if (req.kind === 'click' && Number.isFinite(req.x) && Number.isFinite(req.y) && req.x >= 0 && req.x < 1 && req.y >= 0 && req.y < 1) {
        await run('xdotool', 'mousemove', String(Math.floor(req.x * viewport.width)), String(Math.floor(req.y * viewport.height)), 'click', '1')
      } else if (req.kind === 'key' && Object.hasOwn(desktopKeys, req.key)) await run('xdotool', 'key', '--clearmodifiers', desktopKeys[req.key])
      else if (req.kind === 'scroll' && Number.isFinite(req.delta) && Math.abs(req.delta) <= 2000) {
        await run('xdotool', 'click', '--repeat', String(Math.max(1, Math.ceil(Math.abs(req.delta) / 120))), req.delta < 0 ? '4' : '5')
      } else if (req.kind === 'text' && typeof req.text === 'string' && req.text.length <= 8192) {
        const process = docker.pipe(['exec', '-i', name, 'xdotool', 'type', '--clearmodifiers', '--delay', '0', '--file', '-'])
        const done = new Promise((resolve, reject) => {
          process.on('error', reject); process.once('close', code => code === 0 ? resolve() : reject(new Error('桌面输入失败')))
          process.stdin.on('error', reject)
        })
        process.stdout.resume()
        process.stdin.end(req.text)
        await done
      } else throw new Error('不支持的桌面输入')
    },
  }
}

async function openContainer(home, botId, target, config) {
  const docker = dockerCommand(config, target)
  const { id, name } = resource(home, botId)
  const image = target === 'cloud' ? config.cloudImage || config.containerImage : config.containerImage
  if (!image) throw new Error('Configure the dedicated NativeCrew browser image in this profile first')
  if (!(await inspect(docker, 'volume', name, id))) await docker.run('volume', 'create', '--label', label + '=' + id, name)
  // A crashed Host can leave a process that still holds the profile's Chromium lock.
  await stopOwned(docker, name, id)
  await docker.run('run', '-d', '--init', '--name', name, '--hostname', name, '--label', label + '=' + id, '--label', hostLabel + '=' + profileKey(home), '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--shm-size=256m', '--memory=1g', '--mount', 'type=volume,source=' + name + ',target=/profile', image)
  let tunnel
  try {
    tunnel = await bridge(docker, name, await browserSocket(docker, name))
    const browser = await chromium.connectOverCDP(tunnel.endpoint, { timeout: 20_000 })
    return {
      browser, context: browser.contexts()[0], resourceId: name, desktop: isolatedDisplay(docker, name),
      close: async () => {
        try { await browser.close() } finally {
          try { await tunnel.close() } finally { await stopOwned(docker, name, id) }
        }
      },
    }
  } catch (error) {
    await tunnel?.close()
    await stopOwned(docker, name, id)
    throw error
  }
}

export async function openEnvironment({ home, botId, target, config, profileDir }) {
  if (target !== 'local') return openContainer(home, botId, target, config)
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const executablePath = config.executablePath ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
  const context = await chromium.launchPersistentContext(profileDir, {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true, viewport, acceptDownloads: true,
  })
  return { context, resourceId: botId, close: () => context.close() }
}

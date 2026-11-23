// Native helpers communicate over inherited descriptors. Only the authenticated
// coordinator starts a session; media is encoded and sent by the private peer.
import { spawn, execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { socketPath } from '../local.js'

const exec = promisify(execFile)
const mac = platform() === 'darwin'
const desktopError = (message) => Object.assign(new Error(message), { code: 'DESKTOP_UNAVAILABLE' })
export function nativeRuntimePath() {
  return (
    process.env.GODBOT_DESKTOP_RUNTIME ||
    (mac
      ? join(homedir(), 'Library', 'Application Support', 'NativeCrew Computer Host', 'native')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'godbot-computer', 'native'))
  )
}
function programs() {
  const root = nativeRuntimePath()
  return {
    media: join(root, 'godbot-desktop-rtc'),
    platform: mac
      ? join(root, 'NativeCrew Computer Host.app', 'Contents', 'MacOS', 'godbot-screen')
      : join(root, 'godbot-screen'),
    encoder: process.env.GODBOT_DESKTOP_FFMPEG || 'ffmpeg',
  }
}
function encodingSize(w, h, low) {
  const factor = Math.min(1, (low ? 960 : 1280) / w, (low ? 540 : 960) / h)
  return [w, h].map((v) => Math.max(2, Math.floor((v * factor) / 2) * 2))
}
function displayInfo(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    width: row.width,
    height: row.height,
    revision: row.revision,
  }
}
function portalDetails(info) {
  const portal = info.portalContext
  if (mac || !info.available || !portal) return
  const { seat, backend, revision, screenCastVersion, remoteDesktopVersion } = portal
  if (
    ![seat, backend].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256) ||
    !Number.isInteger(revision) ||
    !info.displays.some((display) => display.id === 'portal' && display.revision === revision)
  )
    return
  const scopes = []
  if (Number.isInteger(screenCastVersion) && screenCastVersion >= 4) scopes.push('desktop.view')
  if (info.control && Number.isInteger(remoteDesktopVersion) && remoteDesktopVersion >= 2)
    scopes.push('desktop.control')
  return { context: { seat, backend, revision }, scopes }
}
function checkedInput(event, display) {
  if (!event || event.displayId !== display.id || event.revision !== display.revision) return
  const point = () => [event.x, event.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  switch (event.type) {
    case 'move':
      if (point()) return { type: 'move', x: event.x, y: event.y }
      break
    case 'button':
      if (point() && [0, 1, 2].includes(event.button) && typeof event.down === 'boolean')
        return { type: 'button', x: event.x, y: event.y, button: event.button, down: event.down }
      break
    case 'wheel':
      if ([event.dx, event.dy].every((n) => Number.isFinite(n) && Math.abs(n) <= 16000))
        return { type: 'wheel', dx: event.dx, dy: event.dy }
      break
    case 'key':
      if (
        typeof event.code === 'string' &&
        /^[a-zA-Z0-9]{1,30}$/.test(event.code) &&
        typeof event.down === 'boolean'
      )
        return { type: 'key', code: event.code, down: event.down }
      break
    case 'text':
      if (typeof event.text === 'string' && event.text.length <= 2048)
        return { type: 'text', text: event.text }
      break
    case 'reset':
      return { type: 'reset' }
  }
}
function deadline(ms, reason) {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  const timer = setTimeout(() => reject(desktopError(reason)), ms)
  timer.unref()
  return {
    promise,
    resolve(v) {
      clearTimeout(timer)
      resolve(v)
    },
    reject(e) {
      clearTimeout(timer)
      reject(e)
    },
  }
}
function startProcess(file, args, descriptors) {
  return spawn(file, args, { stdio: descriptors, windowsHide: true })
}

export function createDesktopAdapter({ directory, onEnded: adapterEnded } = {}) {
  let active
  async function inspect(signal) {
    if (!['darwin', 'linux'].includes(platform()))
      return { available: false, control: false, displays: [], reason: 'Unsupported graphical platform' }
    const paths = programs()
    try {
      await Promise.all([access(paths.media, constants.X_OK), access(paths.platform, constants.X_OK)])
      const probe = await exec(paths.platform, mac ? ['launch', 'probe'] : ['probe'], {
        timeout: mac ? 7000 : 5000, maxBuffer: 64 * 1024, ...(signal && { signal, killSignal: 'SIGKILL' }),
      })
      const info = JSON.parse(probe.stdout)
      if (!info.available) return { ...info, control: false, displays: [] }
      if (!Array.isArray(info.displays) || !info.displays.length) throw new Error('No graphical display')
      return { ...info, displays: info.displays.map(displayInfo) }
    } catch (error) {
      if (mac && error.code === 2) {
        return {
          available: false, control: false, displays: [],
          reason: 'Update the NativeCrew Computer Host and desktop helper together, then restart the host',
        }
      }
      return {
        available: false,
        control: false,
        displays: [],
        reason: 'Install the NativeCrew desktop helper and launch it in an unlocked user session',
      }
    }
  }
  return {
    async probe() {
      const { available, control, reason } = await inspect()
      return { available, control, reason }
    },
    async displays() {
      return (await inspect()).displays
    },
    async portalSupport() {
      if (mac || !(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) return []
      return portalDetails(await inspect())?.scopes ?? []
    },
    async start({
      sessionId,
      displayId,
      iceServers = [],
      controllerName,
      onSignal,
      onEnded,
      onControlRevoked,
      signal,
      quality,
      portalPolicy,
    }) {
      if (active) throw desktopError('Desktop busy')
      const owner = Symbol(sessionId)
      active = owner
      const paths = programs()
      let platformChild,
        encoder,
        rtc,
        closed = false,
        granted = false,
        systemControl = false,
        requestId = 0,
        controlVersion = 0
      const pending = new Map()
      const procs = []
      const exits = []
      let closeDone, frameWatch, permissionCheck
      let macRevocationReported = false
      const onAbort = () => shutdown('Session closed')
      const ready = deadline(80_000, 'Timed out waiting for the target screen chooser')
      // Capture and peer can fail while the caller is still awaiting probe.
      ready.promise.catch(() => {})
      const write = (proc, msg) => {
        if (closed || !proc?.stdin.writable) throw desktopError('Desktop helper unavailable')
        if (proc.stdin.writableLength > 256 * 1024) throw desktopError('Desktop helper is overloaded')
        proc.stdin.write(JSON.stringify(msg) + '\n')
      }
      function revokeControl(reason) {
        if (mac && macRevocationReported) return
        if (mac) macRevocationReported = true
        ++controlVersion
        granted = false
        systemControl = false
        try {
          Promise.resolve(onControlRevoked?.(reason)).catch(() => shutdown('Could not revoke remote control'))
        } catch {
          shutdown('Could not revoke remote control')
        }
      }
      // The streaming app can retain its original Accessibility decision after an
      // owner reset. A separate, non-prompting instance of the signed app checks it.
      function checkMacControl() {
        const revision = controlVersion
        const check = new AbortController()
        permissionCheck = check
        const revokeIfCurrent = () => {
          if (!closed && granted && revision === controlVersion)
            revokeControl('Desktop input permission could not be verified')
        }
        const timeout = setTimeout(() => {
          check.abort()
          revokeIfCurrent()
        }, 2500)
        timeout.unref()
        inspect(check.signal).then((seat) => {
          if (!seat.available || seat.control !== true) revokeIfCurrent()
        }, revokeIfCurrent).finally(() => {
          clearTimeout(timeout)
          if (permissionCheck === check) permissionCheck = undefined
        })
      }
      function shutdown(reason) {
        if (closed) return closeDone
        closed = true
        granted = false
        clearInterval(frameWatch)
        permissionCheck?.abort()
        closeDone = Promise.all(exits).then(() => {
          if (active === owner) active = undefined
        })
        signal?.removeEventListener('abort', onAbort)
        const err = desktopError(reason || 'Desktop session ended')
        ready.reject(err)
        for (const req of pending.values()) req.reject(err)
        pending.clear()
        // Give the OS adapter time to synthesize all key/button releases.
        if (platformChild?.stdin.writable) platformChild.stdin.end('{"type":"close"}\n')
        if (rtc?.stdin.writable) rtc.stdin.end('{"type":"close"}\n')
        encoder?.kill('SIGTERM')
        for (const p of procs) {
          const t = setTimeout(() => {
            if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
          }, 1300)
          t.unref()
        }
        if (reason) {
          try {
            ;(onEnded || adapterEnded)?.(reason)
          } catch {}
        }
        return closeDone
      }
      function child(file, args, stdio, receive) {
        const p = startProcess(file, args, stdio)
        procs.push(p)
        exits.push(
          new Promise((resolve) => {
            // The LaunchServices process still owns the stream descriptors after its proxy exits.
            p.once('close', resolve)
            p.once('error', () => {
              if (!p.pid) resolve()
            })
          }),
        )
        p.once('error', () => shutdown('Could not start the desktop helper'))
        p.once('exit', (code) => shutdown(
          mac && p === platformChild && code === 3
            ? 'Start the current signed NativeCrew Computer Host and its matching desktop helper with an approved desktop session'
            : 'A desktop session process stopped'
        ))
        for (const stream of p.stdio) stream?.on('error', () => shutdown('Desktop helper connection closed'))
        if (receive) {
          const lines = createInterface({ input: p.stdout })
          lines.on('line', (line) => {
            if (closed) return
            try {
              const msg = JSON.parse(line)
              if (Number.isSafeInteger(msg.id)) {
                const req = pending.get(msg.id)
                pending.delete(msg.id)
                if (req) {
                  if (msg.ok) req.resolve(req.portal ? msg.portal : undefined)
                  else {
                    const err = desktopError(msg.error || 'The target denied this operation')
                    if (req.enable && msg.code === 'INPUT_DENIED') err.code = 'INPUT_DENIED'
                    req.reject(err)
                  }
                }
              } else receive(msg)
            } catch {
              shutdown('Invalid desktop helper response')
            }
          })
        }
        return p
      }
      function request(proc, msg) {
        const id = ++requestId,
          wait = deadline(
            msg.type === 'control' && msg.enabled && platform() === 'linux' ? 80_000 : 7_000,
            'Desktop helper request timed out',
          )
        pending.set(id, {
          ...wait,
          enable: proc === platformChild && msg.type === 'control' && msg.enabled === true,
          portal: proc === platformChild && msg.type === 'control' && msg.portal?.remember === true,
        })
        try {
          write(proc, { ...msg, id })
        } catch (e) {
          wait.reject(e)
        }
        return wait.promise.finally(() => pending.delete(id))
      }
      try {
        if (signal?.aborted) throw desktopError('Desktop session closed')
        signal?.addEventListener('abort', onAbort, { once: true })
        const info = await inspect()
        if (closed) throw desktopError('Desktop session closed')
        const display =
          info.displays.find((row) => row.id === String(displayId)) ||
          (!displayId ? info.displays[0] : undefined)
        if (!display) throw desktopError(info.reason || 'Display disconnected')
        const portal = display.id === 'portal' && portalDetails(info)
        const usePortal = portal && portal.scopes.some((scope) => portalPolicy?.enabled(scope))
        const view = usePortal && portal.scopes.includes('desktop.view')
          ? portalPolicy.take('desktop.view', portal.context)
          : undefined
        let savedView
        systemControl = info.control
        const low = quality === 'low'
        let osReady = false,
          rtcReady = false,
          firstFrame = false,
          lastFrameTime = 0
        const checkReady = () => {
          if (osReady && rtcReady && firstFrame) ready.resolve()
        }
        frameWatch = setInterval(() => {
          if (osReady && encoder && Date.now() - lastFrameTime > 8000)
            shutdown('The compositor did not deliver desktop video frames')
          else if (mac && !closed && granted && !permissionCheck) checkMacControl()
        }, 1000)
        frameWatch.unref()
        function encode(width, height) {
          if (encoder || ![width, height].every((v) => Number.isInteger(v) && v >= 2 && v <= 1920))
            throw desktopError('Invalid display geometry')
          encoder = child(
            paths.encoder,
            [
              '-hide_banner',
              '-nostdin',
              '-loglevel',
              'error',
              '-analyzeduration',
              '0',
              '-probesize',
              '32',
              '-f',
              'rawvideo',
              '-pixel_format',
              'bgra',
              '-video_size',
              width + 'x' + height,
              '-framerate',
              '15',
              '-i',
              'pipe:0',
              '-an',
              '-c:v',
              'libvpx',
              '-pix_fmt',
              'yuv420p',
              '-deadline',
              'realtime',
              '-cpu-used',
              '8',
              '-threads',
              '2',
              '-lag-in-frames',
              '0',
              '-g',
              '15',
              ...(low
                ? ['-b:v', '350k', '-maxrate', '400k', '-bufsize', '350k', '-drop-threshold', '30']
                : ['-b:v', '1800k']),
              '-flush_packets',
              '1',
              '-f',
              'ivf',
              'pipe:1',
            ],
            ['pipe', 'pipe', 'ignore'],
          )
          lastFrameTime = Date.now()
          // A portal can accept the session even if the compositor cannot
          // supply a frame. Wait for an actual encoded IVF frame before
          // exposing the display as ready to either controller.
          const header = Buffer.alloc(44)
          let received = 0
          encoder.stdout.on('data', (chunk) => {
            lastFrameTime = Date.now()
            if (firstFrame) return
            if (received < header.length)
              chunk.copy(header, received, 0, Math.min(chunk.length, header.length - received))
            received += chunk.length
            if (received >= header.length) {
              const size = header.readUInt32LE(32)
              if (size > 0 && received >= header.length + size) {
                firstFrame = true
                checkReady()
              }
            }
          })
          platformChild.stdio[3].pipe(encoder.stdin)
          encoder.stdout.pipe(rtc.stdio[3])
          checkReady()
        }
        rtc = child(paths.media, [], ['pipe', 'pipe', 'ignore', 'pipe'], (msg) => {
          if (msg.type === 'ready') {
            rtcReady = true
            checkReady()
          } else if (msg.type === 'ended') shutdown(msg.reason)
          else if (msg.type === 'signal')
            Promise.resolve(onSignal?.(msg.signal)).catch(() => shutdown('Signaling closed'))
          else if (msg.type === 'release') {
            if (granted) write(platformChild, { type: 'reset' })
          } else if (msg.type === 'input' && granted) {
            const input = checkedInput(msg.event, display)
            if (input) write(platformChild, input)
          }
        })
        write(rtc, { type: 'start', iceServers })
        const [w, h] =
          display.width && display.height ? encodingSize(display.width, display.height, low) : [0, 0]
        const label = String(controllerName || 'Paired controller')
          .replace(/[\p{C}]/gu, '')
          .slice(0, 96)
        platformChild = child(
          paths.platform,
          [
            ...(mac ? ['launch'] : []),
            'stream',
            display.id,
            String(w),
            String(h),
            label,
            String(display.revision),
            ...(mac ? [socketPath(directory), sessionId] : low ? ['low'] : []),
            ...(usePortal ? ['--portal-restore-v1'] : []),
          ],
          ['pipe', 'pipe', 'ignore', 'pipe'],
          (msg) => {
            if (msg.type === 'ended') shutdown(msg.reason)
            else if (usePortal && msg.type === 'portal-saved' && msg.scope === 'desktop.view') savedView = msg
            else if (usePortal && msg.type === 'portal-cleared') portalPolicy.clear()
            else if (msg.type === 'control-revoked') {
              if (usePortal) portalPolicy.clear('desktop.control')
              revokeControl(msg.reason || 'Desktop input permission was revoked')
            } else if (msg.type === 'format') encode(msg.width, msg.height)
            else if (msg.type === 'ready') {
              if (!Number.isInteger(msg.revision) || msg.revision !== display.revision) {
                shutdown('Display geometry changed before sharing')
                return
              }
              osReady = true
              systemControl = info.control && msg.control !== false
              checkReady()
            }
          },
        )
        if (usePortal) {
          write(platformChild, { type: 'portal-init', view: view?.request, context: portal.context })
        }
        if (mac) encode(w, h)
        await ready.promise
        if (!closed) view?.replace(savedView)
        return {
          async signal(msg) {
            if (msg?.type === 'offer' && typeof msg.sdp === 'string' && msg.sdp.length <= 128 * 1024)
              return request(rtc, { type: 'offer', sdp: msg.sdp })
            if (
              msg?.type === 'candidate' &&
              msg.candidate &&
              typeof msg.candidate.candidate === 'string' &&
              msg.candidate.candidate.length <= 4000
            )
              return request(rtc, { type: 'candidate', candidate: msg.candidate })
            throw desktopError('Invalid desktop signaling message')
          },
          async setControl(enabled) {
            const revision = ++controlVersion
            granted = false
            if (enabled && (mac || !systemControl)) {
              const seat = await inspect()
              if (!seat.available) throw desktopError('The target desktop is no longer available')
              if (!seat.control)
                throw Object.assign(desktopError('Allow desktop input on the target computer'), {
                  code: 'INPUT_DENIED',
                })
            }
            if (revision !== controlVersion || closed) return
            if (mac && enabled) macRevocationReported = false
            const memory = enabled && usePortal && portal.scopes.includes('desktop.control')
              ? portalPolicy.take('desktop.control', portal.context)
              : undefined
            const saved = await request(platformChild, {
              type: 'control',
              enabled: enabled === true,
              ...(memory && { portal: memory.request }),
            })
            if (revision === controlVersion && !closed) {
              memory?.replace(saved)
              granted = enabled === true
            }
          },
          close() {
            return shutdown()
          },
        }
      } catch (error) {
        await shutdown()
        throw error
      }
    },
  }
}

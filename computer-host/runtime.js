import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  DeviceRegistry,
  HostLink,
  deviceIdFor,
  generateKeyPair,
  identityFingerprint,
  machinePairingUri,
  randomToken,
} from '../src/host/team-runtime/mobile-link.js'
import { claimComputerInput } from '../src/host/computer-input-lock.js'
import { MachineSessions } from './sessions.js'
import { askLocal } from './consent.js'
import { defaultHome, localRequest, privateDir, socketPath } from './local.js'
import { createPortalMemory } from './portal-memory.js'

const desktopScopes = ['desktop.view', 'desktop.control']
const scopes = [...desktopScopes, 'terminal']
const headlessDesktop = {
  probe: async () => ({ available: false, control: false, reason: 'No graphical session' }),
  displays: async () => [],
}

function portalFileStamp(stat) {
  if (stat.birthtimeNs > 0n && stat.ino > 0n) return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function relayUrl(value) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      url.protocol === 'wss:' ||
      (url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  ) {
    throw new Error('Use a secure wss relay or a loopback ws relay')
  }
  if (url.pathname === '/') url.pathname = '/v1/link'
  if (url.pathname !== '/v1/link') throw new Error('The relay path must be /v1/link')
  return url.href
}

function saveConfig(directory, cfg) {
  const target = join(directory, 'identity.json')
  const temp = target + '.' + randomUUID()
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try {
      const stored = { ...cfg }
      if (stored.portalMemory && Object.keys(stored.portalMemory).length) {
        const stamp = portalFileStamp(fstatSync(fd, { bigint: true }))
        if (stamp) stored.portalMemoryFile = stamp
        else delete stored.portalMemory
      }
      writeFileSync(fd, JSON.stringify(stored) + '\n')
    } finally {
      closeSync(fd)
    }
    renameSync(temp, target)
  } catch (err) {
    unlinkSync(temp)
    throw err
  }
}

function loadConfig(directory, options) {
  const path = join(directory, 'identity.json')
  let cfg
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let stamp
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (!stat.isFile() || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o077n) !== 0n)
        throw new Error('Unsafe host identity file permissions')
      cfg = JSON.parse(readFileSync(fd, 'utf8'))
      stamp = portalFileStamp(stat)
    } finally {
      closeSync(fd)
    }
    if (
      cfg.version !== 1 ||
      cfg.identity.deviceId !== deviceIdFor(cfg.identity.publicKey) ||
      typeof cfg.identity.privateKey !== 'string' ||
      typeof cfg.token !== 'string' ||
      !Array.isArray(cfg.devices) ||
      !cfg.grants ||
      !Array.isArray(cfg.audit)
    )
      throw new Error('Invalid computer host identity file')
    // Old hosts replace identity.json without understanding portal memory.
    // A file-specific stamp catches an intervening rollback or external copy,
    // even if legacy code removes and later re-adds the same desktop grant.
    if (!stamp || cfg.portalMemoryFile !== stamp) delete cfg.portalMemory
    delete cfg.portalMemoryFile
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    const keys = generateKeyPair()
    cfg = {
      version: 1,
      identity: { ...keys, deviceId: deviceIdFor(keys.publicKey) },
      token: randomToken(),
      name: hostname(),
      devices: [],
      grants: {},
      audit: [],
    }
  }
  if (!options.relay && !cfg.relay) throw new Error('Specify --relay for the first start')
  cfg.relay = relayUrl(options.relay || cfg.relay)
  if (options.name) cfg.name = options.name.slice(0, 64)
  saveConfig(directory, cfg)
  return cfg
}

function networkConfig(directory) {
  const path = join(directory, 'network.json')
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0)
      throw new Error('Unsafe network configuration permissions')
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return {
      GODBOT_COMPUTER_STUN_URL: data.stun,
      GODBOT_COMPUTER_TURN_ISSUER: data.turnIssuer,
      GODBOT_COMPUTER_TURN_CREDENTIAL: data.turnCredential,
      ...process.env,
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return process.env
  }
}

function iceProvider(env) {
  const stun = env.GODBOT_COMPUTER_STUN_URL
  if (stun && !/^stuns?:[^\s/@?#]+(?::\d+)?$/.test(stun)) throw new Error('Invalid STUN URL')
  const issuer = env.GODBOT_COMPUTER_TURN_ISSUER
  const credential = env.GODBOT_COMPUTER_TURN_CREDENTIAL
  if (issuer && !credential) throw new Error('Configure the host enrollment credential for TURN')
  let url
  if (issuer) {
    url = new URL(issuer)
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
      )
    )
      throw new Error('Invalid TURN issuer')
    if (url.pathname === '/') url.pathname = '/v1/turn/credentials'
  }
  const base = stun ? [{ urls: [stun] }] : []
  const direct = () => ({ host: [...base], viewer: [...base] })
  return async (sessionId) => {
    if (!url) return direct()
    try {
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(2500),
        headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (!response.ok) return { ...direct(), retry: true }
      const result = await response.json()
      const servers = (value) => {
        if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid ICE server list')
        return value.map((server) => {
          const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
          if (
            !Array.isArray(urls) ||
            urls.length > 8 ||
            !urls.every((u) => typeof u === 'string' && /^turns?:/.test(u) && u.length < 512)
          )
            throw new Error('Invalid TURN URL')
          if (typeof server.username !== 'string' || typeof server.credential !== 'string')
            throw new Error('Invalid TURN credential')
          return { urls, username: server.username, credential: server.credential }
        })
      }
      if (!Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now())
        throw new Error('Expired TURN credential')
      return {
        host: [...base, ...servers(result.host)],
        viewer: [...base, ...servers(result.viewer)],
        expiresAt: result.expiresAt,
      }
    } catch {
      return { ...direct(), retry: true }
    }
  }
}

function describePeer(d) {
  return {
    deviceId: d.deviceId,
    name: (d.name || '').replace(/[\p{C}]/gu, '').trim() || d.deviceId,
    fingerprint: identityFingerprint(d.identityKey),
    pairedAt: d.pairedAt,
  }
}

function createManagementSocket(handle) {
  return createServer((socket) => {
    socket.setTimeout(10000, () => socket.destroy())
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    let bytes = '',
      done = false
    socket.on('data', async (chunk) => {
      if (done) return
      bytes += chunk
      if (Buffer.byteLength(bytes) > 8192) return socket.destroy()
      if (!bytes.includes('\n')) return
      done = true
      try {
        const { method, args } = JSON.parse(bytes)
        if (
          typeof method !== 'string' ||
          !Array.isArray(args) ||
          args.length > 8 ||
          !args.every((arg) => typeof arg === 'string' && arg.length <= 256)
        )
          throw new Error('Invalid local request')
        const result = await handle(method, args)
        socket.end(JSON.stringify({ ok: true, result }) + '\n')
      } catch (err) {
        socket.end(JSON.stringify({ ok: false, message: err.message }) + '\n')
      }
    })
  })
}

async function listen(server, path) {
  await new Promise((resolve, reject) => {
    const fail = (err) => {
      server.off('listening', success)
      reject(err)
    }
    const success = () => {
      server.off('error', fail)
      resolve()
    }
    server.once('error', fail)
    server.once('listening', success)
    server.listen(path)
  })
  chmodSync(path, 0o600)
}

export async function startComputerHost(options = {}) {
  const directory = options.home || defaultHome()
  privateDir(directory)
  const path = socketPath(directory)
  let cfg,
    link,
    registry,
    desktop,
    portalMemory,
    sessions,
    stopping = false
  const device = (id) => {
    const d = registry.list().find((d) => d.deviceId === id)
    if (!d) throw new Error('Unknown paired controller')
    return d
  }
  const claimInput = options.claimInput ?? claimComputerInput
  const grants = (id) => cfg.grants[id] ?? []
  const managers = new Map()
  let changing = 0
  let releasePrivateInput
  const privateActive = () => {
    for (const [token, expires] of managers) if (expires <= Date.now()) managers.delete(token)
    const blocked = changing > 0 || managers.size > 0 || (registry?.pairingOpen() ?? false)
    if (!blocked && releasePrivateInput) {
      releasePrivateInput()
      releasePrivateInput = null
    }
    return blocked
  }
  const protectedChange = async (fn) => {
    changing++
    try {
      await sessions.protectLocal()
      releasePrivateInput ??= claimInput('private')
      return fn()
    } finally {
      changing--
      privateActive()
    }
  }
  const seen = (id) => {
    cfg.lastSeen ??= {}
    if (Date.now() - (cfg.lastSeen[id] || 0) >= 60000) {
      cfg.lastSeen[id] = Date.now()
      saveConfig(directory, cfg)
    }
  }
  const management = createManagementSocket(async (method, args) => {
    if (!link || stopping) throw new Error('Host is starting or shutting down')
    const [id, scope] = args
    if (method === 'status')
      return {
        version: 1,
        deviceId: cfg.identity.deviceId,
        name: cfg.name,
        fingerprint: identityFingerprint(cfg.identity.publicKey),
        relay: cfg.relay,
        status: link.status,
        ...(await sessions.hello()),
      }
    if (method === 'manage-start' || method === 'manage-end') {
      if (!id || !/^[a-zA-Z0-9_-]{32,128}$/.test(id)) throw new Error('Invalid local management lease')
      privateActive()
      if (method === 'manage-end') {
        managers.delete(id)
        privateActive()
        return { ok: true }
      }
      const renew = () => {
        const expiresAt = Date.now() + 6000
        managers.set(id, expiresAt)
        return { ok: true, expiresAt }
      }
      if (managers.has(id)) return renew()
      if (managers.size >= 4) throw new Error('Too many settings windows')
      return protectedChange(renew)
    }
    if (method === 'cancel-pair') {
      registry.closePairing()
      privateActive()
      return { ok: true }
    }
    if (method === 'pair') {
      const { code, expiresAt } = await protectedChange(() => registry.openPairing())
      return {
        uri: machinePairingUri({
          server: cfg.relay,
          hostDeviceId: cfg.identity.deviceId,
          hostKey: cfg.identity.publicKey,
          name: cfg.name,
          code,
        }),
        expiresAt,
      }
    }
    if (method === 'controllers') {
      const supported = (await desktop.portalSupport?.()) ?? []
      return registry.list().map((d) => {
        const remembered = portalMemory.scopes(d.deviceId)
        return {
          ...describePeer(d),
          lastSeen: cfg.lastSeen?.[d.deviceId] ?? d.pairedAt,
          grants: grants(d.deviceId),
          ...((supported.length || remembered.length) && { portalScopes: remembered }),
          ...(supported.length && { portalSupportedScopes: supported }),
        }
      })
    }
    if (method === 'remember-portal' || method === 'forget-portal') {
      device(id)
      if (!desktopScopes.includes(scope)) throw new Error('Choose desktop.view or desktop.control')
      if (method === 'forget-portal') {
        portalMemory.disable(id, scope)
        return { deviceId: id, portalScopes: portalMemory.scopes(id) }
      }
      const supported = (await desktop.portalSupport?.()) ?? []
      if (!supported.includes(scope)) throw new Error('The current Wayland session cannot remember this permission')
      return protectedChange(() => {
        device(id)
        if (!grants(id).includes(scope) || !grants(id).includes('desktop.view'))
          throw new Error('Remember the corresponding NativeCrew desktop grant before remembering a Wayland screen')
        portalMemory.enable(id, scope)
        return { deviceId: id, portalScopes: portalMemory.scopes(id) }
      })
    }
    if (method === 'grant' || method === 'ungrant') {
      device(id)
      if (!scopes.includes(scope)) throw new Error('Choose desktop.view, desktop.control or terminal')
      const update = async () => {
        const next = new Set(grants(id))
        if (method === 'grant') {
          next.add(scope)
          if (scope === 'desktop.control') next.add('desktop.view')
        } else {
          next.delete(scope)
          if (scope === 'desktop.view') next.delete('desktop.control')
          portalMemory.invalidate(id, scope)
        }
        cfg.grants[id] = [...next]
        saveConfig(directory, cfg)
        if (method === 'ungrant') await sessions.revoke(id, scope)
        return { deviceId: id, grants: grants(id) }
      }
      return method === 'grant' ? protectedChange(update) : update()
    }
    if (method === 'revoke') {
      device(id)
      portalMemory.invalidate(id)
      const closing = sessions.revoke(id)
      delete cfg.grants[id]
      if (cfg.lastSeen) delete cfg.lastSeen[id]
      registry.revoke(id)
      link.disconnect(id)
      await closing
      return { ok: true }
    }
    if (method === 'sessions')
      return [...sessions.records.values()]
        .filter((s) => s.state === 'approved' || s.state === 'pending')
        .map((s) => ({
          sessionId: s.id,
          mode: s.mode,
          state: s.state,
          control: s.control,
          controlPending: Boolean(s.controlPending),
          controller: describePeer(device(s.peerId)).name,
          deviceId: s.peerId,
          account: sessions.account,
          expiresAt: s.expiresAt,
        }))
    if (method === 'approve' || method === 'deny') {
      const result = await sessions.decide(id, method === 'approve')
      return { sessionId: result.sessionId, mode: result.mode, state: result.state, control: result.control }
    }
    if (method === 'stop') {
      const s = sessions.records.get(id)
      if (!s) throw new Error('Unknown session')
      sessions.end(s, 'owner_stopped')
      await s.closing
      return { ok: true }
    }
    if (method === 'history') return cfg.audit
    throw new Error('Unknown local operation')
  })
  try {
    await listen(management, path)
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    const before = lstatSync(path)
    if (!before.isSocket() || before.uid !== process.getuid()) throw err
    try {
      await localRequest(directory, 'status')
      throw new Error('The computer host is already running in this directory')
    } catch (probe) {
      if (probe.code !== 'ECONNREFUSED') throw probe
    }
    const after = lstatSync(path)
    if (before.ino !== after.ino || before.dev !== after.dev) throw err
    unlinkSync(path)
    await listen(management, path)
  }
  try {
    cfg = loadConfig(directory, options)
    desktop =
      options.desktop ??
      (options.headless
        ? headlessDesktop
        : (await import('./native/desktop.js')).createDesktopAdapter({ directory }))
    portalMemory = createPortalMemory(cfg, grants, () => saveConfig(directory, cfg))
    registry = new DeviceRegistry(cfg.devices, (devices) => {
      cfg.devices = devices
      saveConfig(directory, cfg)
    })
    sessions = new MachineSessions({
      desktop,
      name: cfg.name,
      grants,
      portalMemory,
      localPrivate: privateActive,
      claimInput,
      peerName: (id) => describePeer(device(id)).name,
      issueIce: iceProvider(networkConfig(directory)),
      ask: options.noPrompts
        ? undefined
        : (s, scope, signal) => {
            const controller = describePeer(device(s.peerId))
            return askLocal(
              { name: controller.name + ' (' + controller.fingerprint + ')', account: sessions.account },
              scope,
              signal,
            )
          },
      audit: (event, s) => {
        cfg.audit.push({ time: Date.now(), deviceId: s.peerId, mode: s.mode, event })
        cfg.audit = cfg.audit.slice(-256)
        saveConfig(directory, cfg)
      },
    })
    link = new HostLink({
      url: cfg.relay,
      identity: cfg.identity,
      accessToken: cfg.token,
      name: cfg.name,
      admits: (id, key) => registry.admits(id, key),
      authorize: (id, key, hello) => {
        const accepted = registry.authorize(id, key, hello)
        privateActive()
        if (accepted) seen(id)
        return accepted
      },
      handle: (method, params, peer) => {
        seen(peer.deviceId)
        return sessions.call(method, params, peer)
      },
      onTunnelClosed: (id, tunnel) => sessions.drop(id, tunnel),
    })
    link.start()
    return {
      link,
      sessions,
      deviceId: cfg.identity.deviceId,
      directory,
      async close() {
        if (stopping) return
        stopping = true
        registry.closePairing()
        managers.clear()
        privateActive()
        await sessions.stop()
        await link.stop()
        await new Promise((resolve) => management.close(resolve))
      },
    }
  } catch (err) {
    await sessions?.stop()
    await new Promise((resolve) => management.close(resolve))
    throw err
  }
}

// Modified for Godbot. See THIRD_PARTY_NOTICES.
// Phone link: the computer's end of the NativeCrew phone app. A paired phone calls the same
// api/godbot/team endpoints as this window, end to end encrypted through a Relay Server that only
// forwards (link/). The computer only connects out, so it needs no open port.
//
// phone.json keeps this computer's identity key, its Server token, the paired phones and the
// push key each phone gave this computer. Only the dsh that owns the team runs the link: two
// would push each other off the Server.
//
// Push: a phone that is not connected still hears about what needs it. Every notice that
// matters (core/mobile.js addNotice) is sealed with that phone's push key and handed to the
// Server, which forwards the ciphertext through FCM (godbot-server docs/protocol.md §9).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DeviceRegistry, HostLink, LINK_PATH, PUSH_KEY_METHOD, deviceIdFor, encryptPush, generateKeyPair, isPushKey, pairingUri, randomToken } from '../mobile-link.js'

const FILE = 'phone.json'
const SERVER = /^wss?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i
// Notices worth waking a phone for: what waits on the user, a Bot's own reply and finished
// group work. A member's every group line would be noise.
const PUSH_KINDS = new Set(['approval', 'question', 'view', 'message', 'done'])
const PUSH_TTL_SECONDS = 6 * 60 * 60

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

export function install(rt) {
  const path = join(rt.home, FILE)
  let data
  let registry
  let link = null
  let feedUntap = null
  let linkServer
  let serve = null
  let pairing = null
  let blocked

  const read = () => {
    if (data !== undefined) return data
    try { data = JSON.parse(readFileSync(path, 'utf8')) } catch { data = {} }
    if (!Array.isArray(data.devices)) data.devices = []
    if (data.pushKeys === null || typeof data.pushKeys !== 'object' || Array.isArray(data.pushKeys)) data.pushKeys = {}
    // Original clients that paired with the then-default public relay omitted
    // its address on disk. Only those existing pairings inherit that address.
    if (data.version === undefined && !data.server && data.devices.length) {
      data.server = 'wss://relay.dsbot.app' + LINK_PATH
    }
    data.version = 2
    registry = new DeviceRegistry(data.devices, (devices) => { data.devices = devices; write() })
    return data
  }
  const write = () => {
    mkdirSync(rt.home, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, path)
  }
  const serverUrl = () => data.server || rt.config.phoneRelay || ''
  const identity = () => {
    const keys = data.identity
    try {
      if (keys && deviceIdFor(keys.publicKey) === keys.deviceId && typeof keys.privateKey === 'string' && typeof data.accessToken === 'string') return keys
    } catch { /* a broken key is made again */ }
    const fresh = generateKeyPair()
    data.identity = { deviceId: deviceIdFor(fresh.publicKey), ...fresh }
    data.accessToken = randomToken()
    data.devices = []
    data.pushKeys = {}
    registry = new DeviceRegistry([], (devices) => { data.devices = devices; write() })
    write()
    return data.identity
  }

  // The last push result per phone, for the settings page; kept in memory only.
  const lastPush = new Map()
  const createLink = rt.createPhoneLink ?? (options => new HostLink(options))

  // A paired phone hands this computer the key its notifications are sealed with.
  const setPushKey = (deviceId, params) => {
    const key = params?.key
    if (!isPushKey(key)) throw Object.assign(new Error('The push key is invalid'), { code: 'INVALID_PARAMS' })
    if (!registry.list().some(device => device.deviceId === deviceId)) throw Object.assign(new Error('This phone is not paired'), { code: 'NOT_PAIRED' })
    if (data.pushKeys[deviceId]?.key !== key) {
      data.pushKeys[deviceId] = { key, at: Date.now() }
      write()
    }
    return { ok: true }
  }

  // Seals one notice for every paired phone that has a push key and no open link.
  rt.phonePush = (notice) => {
    const running = link
    if (running === null || !running.pushAvailable || !PUSH_KINDS.has(notice?.kind)) return
    const connected = new Set(running.connectedDevices())
    const title = notice.title ? `${notice.name} · ${notice.title}` : String(notice.name ?? '')
    const message = {
      v: 1, kind: notice.kind, title, body: String(notice.text ?? ''), time: notice.time ?? Date.now(),
      ...(notice.seq === undefined ? {} : { seq: notice.seq }),
      ...(notice.botId === undefined ? {} : { botId: notice.botId }),
      ...(notice.sessionId === undefined ? {} : { sessionId: notice.sessionId }),
      ...(notice.roomId === undefined ? {} : { roomId: notice.roomId }),
    }
    const collapseKey = `${notice.kind}:${notice.sessionId ?? notice.roomId ?? notice.botId ?? ''}`.slice(0, 64)
    for (const { deviceId } of registry.list()) {
      const entry = data.pushKeys[deviceId]
      if (entry === undefined || connected.has(deviceId)) continue
      let ciphertext
      try { ciphertext = encryptPush(entry.key, data.identity.deviceId, message) } catch { continue }
      void running.sendPush(deviceId, ciphertext, { collapseKey, ttlSeconds: PUSH_TTL_SECONDS })
        .then(result => { lastPush.set(deviceId, { at: Date.now(), ok: result.ok, ...(result.code ? { code: result.code } : {}) }) })
    }
  }

  // A phone may call every endpoint but these: pairing stays on the computer.
  // When the call carries `state` (the payload the phone would send `state`) and
  // it moved the team, the reply carries the new state too — one round trip
  // through the relay instead of waiting for the revision event and a read.
  const callBot = async (params, signal) => {
    const endpoint = String(params?.endpoint ?? '')
    if (endpoint.startsWith('phone-')) return { ok: false, error: { code: 'bot/refused', message: 'Phones are paired and removed on the computer', details: {} } }
    const wanted = params?.state !== null && typeof params?.state === 'object' && !Array.isArray(params.state) ? params.state : undefined
    const before = rt.state.revision
    const result = await serve(endpoint, params?.payload ?? null, signal)
    if (wanted === undefined || result?.ok !== true || rt.state.revision === before) return result
    const state = await serve('state', wanted, signal).then(answer => (answer?.ok === true ? answer.value : undefined), () => undefined)
    return state === undefined ? result : { ...result, state }
  }

  const stop = () => {
    const running = link
    link = null
    feedUntap?.()
    feedUntap = null
    return running?.stop()
  }
  const reconcile = () => {
    read()
    blocked = !data.on ? undefined
      : !serverUrl() ? 'Enter a relay server address to connect a phone'
      : rt.readOnly() !== undefined ? 'Another dsh has this Bot team open, so phones connect to that one'
        : typeof WebSocket !== 'function' ? 'This dsh runs on a Node without WebSocket'
          : undefined
    const want = data.on === true && serve !== null && blocked === undefined
    if (link !== null && (!want || linkServer !== serverUrl())) void stop()
    if (!want || link !== null) return
    link = createLink({
      url: serverUrl(),
      identity: identity(),
      accessToken: data.accessToken,
      name: hostname(),
      admits: (deviceId, key) => registry.admits(deviceId, key),
      authorize: (deviceId, key, hello) => registry.authorize(deviceId, key, hello),
      handle: async (method, params, request) => {
        if (method === 'bot') return callBot(params, request.signal)
        if (method === PUSH_KEY_METHOD) return setPushKey(request.deviceId, params)
        throw Object.assign(new Error(`Unknown method ${method}`), { code: 'METHOD_NOT_FOUND' })
      },
      push: data.push !== false,
      // Feed events ride the link instead of SSE, but only while a phone is
      // actually ready to hear them — no tunnel, no feed work on the host.
      onReadyCount: count => {
        if (count > 0 && feedUntap === null) {
          const running = link
          feedUntap = rt.feedTap((event, data) => running.emit(event, data))
        } else if (count === 0 && feedUntap !== null) {
          feedUntap()
          feedUntap = null
        }
      },
    })
    linkServer = serverUrl()
    link.start()
  }

  rt.phoneView = () => {
    reconcile()
    if (pairing !== null && !registry.pairingOpen()) pairing = null
    const connected = new Set(link?.connectedDevices() ?? [])
    const reason = blocked ?? link?.error
    return {
      server: serverUrl(),
      on: data.on === true,
      status: link?.status ?? 'off',
      ...(reason === undefined ? {} : { error: reason }),
      phones: registry.list().map(({ deviceId, name, pairedAt }) => ({
        id: deviceId, name, pairedAt, connected: connected.has(deviceId),
        push: data.pushKeys[deviceId] !== undefined,
        ...(lastPush.has(deviceId) ? { lastPush: lastPush.get(deviceId) } : {}),
      })),
      pushEnabled: data.push !== false,
      pushAvailable: link?.pushAvailable === true,
      pairing,
    }
  }

  rt.phoneEndpoint = async (endpoint, body) => {
    read()
    switch (endpoint) {
      case 'phone-set': {
        if (body.server !== undefined) {
          const entered = String(body.server).trim().replace(/\/+$/, '')
          if (entered !== '' && !SERVER.test(entered)) throw invalid('The Server address must start with ws:// or wss://')
          // A bare host means this relay; the Server only serves LINK_PATH.
          const server = entered !== '' && new URL(entered).pathname === '/' ? entered + LINK_PATH : entered
          data.server = server
          pairing = null
          registry?.closePairing()
        }
        if (body.on !== undefined) data.on = body.on === true
        // The push offer is part of hello, so a change takes a new connection.
        if (body.push !== undefined && (body.push === true) !== (data.push !== false)) {
          data.push = body.push === true
          void stop()
        }
        identity()
        write()
        break
      }
      case 'phone-pair': {
        reconcile()
        if (link === null) throw invalid(blocked ?? 'Turn on phone access first')
        const { code, expiresAt } = registry.openPairing()
        pairing = { uri: pairingUri({ server: serverUrl(), hostDeviceId: data.identity.deviceId, hostKey: data.identity.publicKey, code, name: hostname() }), expiresAt }
        break
      }
      case 'phone-pair-cancel':
        registry.closePairing()
        pairing = null
        break
      case 'phone-remove': {
        const id = String(body.id ?? '')
        if (!registry.revoke(id)) throw invalid('This phone is not paired')
        link?.disconnect(id)
        if (data.pushKeys[id] !== undefined) {
          delete data.pushKeys[id]
          write()
        }
        lastPush.delete(id)
        break
      }
      default:
        throw invalid(`Unknown endpoint ${endpoint}`)
    }
    return rt.phoneView()
  }

  // channel.js hands over its endpoint handler once it has one.
  rt.phoneServe = (handle) => {
    serve = handle
    rt.ctx.effect(() => {
      void rt.load().then(reconcile, () => {})
      return () => stop()
    }, 'godbot: phone link')
  }
}

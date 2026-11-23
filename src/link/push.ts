// NativeCrew's push extension: the end-to-end encrypted notification a computer sends a phone
// that is not connected. The phone gives each computer its own key through the encrypted
// link (RPC `push.key`); the Server and FCM only ever carry the ciphertext.
// See godbot-server docs/protocol.md §9.
import { chacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { MAX_PUSH_CIPHERTEXT } from './frames.ts'
import { fromBase64Url, toBase64Url } from './keys.ts'

export const PUSH_KEY_METHOD = 'push.key'
export const PUSH_KEY_BYTES = 32
const NONCE_BYTES = 12
// Longest notification body; the whole message has to fit FCM's 4 KB data payload.
export const MAX_PUSH_BODY = 1000

export interface PushNotification {
  v: 1
  kind: string
  title: string
  body: string
  botId?: string
  sessionId?: string
  roomId?: string
  seq?: number
  time: number
}

/** A fresh push key, base64url. */
export function generatePushKey(): string {
  return toBase64Url(randomBytes(PUSH_KEY_BYTES))
}

/** Whether a value is a push key: 32 bytes as unpadded base64url. */
export function isPushKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false
  try { return fromBase64Url(value).byteLength === PUSH_KEY_BYTES } catch { return false }
}

function aad(hostDeviceId: string): Uint8Array {
  return new TextEncoder().encode(hostDeviceId)
}

/** Encrypts one notification for the phone that owns `key`. */
export function encryptPush(key: string, hostDeviceId: string, notification: PushNotification): string {
  if (!isPushKey(key)) throw new Error('The push key is invalid.')
  const body = notification.body.length > MAX_PUSH_BODY ? `${notification.body.slice(0, MAX_PUSH_BODY - 1)}…` : notification.body
  const plain = new TextEncoder().encode(JSON.stringify({ ...notification, body }))
  const nonce = randomBytes(NONCE_BYTES)
  const sealed = chacha20poly1305(fromBase64Url(key), nonce, aad(hostDeviceId)).encrypt(plain)
  const out = new Uint8Array(NONCE_BYTES + sealed.byteLength)
  out.set(nonce)
  out.set(sealed, NONCE_BYTES)
  const ciphertext = toBase64Url(out)
  if (ciphertext.length > MAX_PUSH_CIPHERTEXT) throw new Error('The notification is too long to push.')
  return ciphertext
}

/** Opens a notification; throws when it was not sealed with `key` for this computer. */
export function decryptPush(key: string, hostDeviceId: string, ciphertext: string): PushNotification {
  if (!isPushKey(key)) throw new Error('The push key is invalid.')
  const data = fromBase64Url(ciphertext)
  if (data.byteLength <= NONCE_BYTES + 16) throw new Error('The notification is too short.')
  const plain = chacha20poly1305(fromBase64Url(key), data.subarray(0, NONCE_BYTES), aad(hostDeviceId)).decrypt(data.subarray(NONCE_BYTES))
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as Partial<PushNotification>
  if (value.v !== 1 || typeof value.kind !== 'string' || typeof value.title !== 'string' || typeof value.body !== 'string' || typeof value.time !== 'number') {
    throw new Error('The notification is invalid.')
  }
  return value as PushNotification
}

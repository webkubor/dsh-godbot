import { lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const nativeSessionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const callId = /^call_\d{1,24}$/u
const maxDatabase = 64 * 1024 * 1024
const maxRecord = 4 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

// Antigravity 1.5.13 stores generic tool calls as protobuf messages in its
// conversation DB. Only the fields needed to identify a call and read its
// recorded text are used. An unfamiliar format leaves the ACP receipt intact.
function messageField(bytes, number) {
  if (!(bytes instanceof Uint8Array)) return
  let offset = 0
  function readVarint() {
    let value = 0
    for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]
      value += (byte & 127) * 2 ** shift
      if (byte < 128) return value
    }
    throw new Error('Invalid Antigravity protobuf varint')
  }
  while (offset < bytes.length) {
    const tag = readVarint()
    const wireType = tag % 8
    if (wireType === 0) readVarint()
    else if (wireType === 1 || wireType === 5) offset += wireType === 1 ? 8 : 4
    else if (wireType === 2) {
      const length = readVarint()
      const end = offset + length
      if (end > bytes.length) throw new Error('Truncated Antigravity protobuf field')
      if (Math.floor(tag / 8) === number) return bytes.subarray(offset, end)
      offset = end
    } else throw new Error('Unsupported Antigravity protobuf wire type')
  }
}

function textField(bytes, field) {
  const value = messageField(bytes, field)
  return value === undefined ? undefined : decoder.decode(value)
}

// Match the ACP tool ID from NativeCrew's owned session, never a filename from the
// tool's arguments. Re-reading that file would lose the actual historical result.
export function readAntigravityToolResult(binding, tool, configDir = join(homedir(), '.gemini', 'antigravity-cli')) {
  const nativeId = binding?.cliSessionId
  if (binding?.route !== 'local-antigravity' || !nativeSessionId.test(nativeId ?? '') ||
      !callId.test(tool.id ?? '') || !['completed', 'failed'].includes(tool.status) ||
      !tool.name || /(?:^|_)request_secret$/u.test(tool.name)) return
  let db
  try {
    const path = join(configDir, 'conversations', nativeId + '.db')
    const file = lstatSync(path)
    if (!file.isFile() || file.size > maxDatabase) return
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA trusted_schema = OFF')
    const conversation = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 2').all()
    if (conversation.length !== 1 || conversation[0].cascade_id !== nativeId) return
    const rows = db.prepare(`SELECT metadata, error_details AS error, step_payload AS payload FROM steps
      WHERE step_type=132 AND step_format=0 AND status IN (3, 7) AND instr(metadata, ?) > 0
      AND length(metadata) <= ? AND length(step_payload) <= ? AND coalesce(length(error_details), 0) <= ? LIMIT 12`)
      .all(Buffer.from(tool.id), maxRecord, maxRecord, maxRecord)
    if (rows.length === 12) return
    const matches = rows.filter(row => {
      const call = messageField(row.metadata, 4)
      const trajectory = messageField(row.metadata, 20)
      return textField(call, 1) === tool.id && textField(call, 2) === tool.name && textField(trajectory, 4) === nativeId
    })
    if (matches.length !== 1) return
    const [row] = matches
    const output = textField(messageField(messageField(row.payload, 140), 2), 1)
    const error = textField(row.error, 2)
    if (output !== undefined || error !== undefined) return { output, error }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

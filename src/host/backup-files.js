import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { constants, gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const magic = Buffer.from('GODBOT1\n')
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export function seal(value, password) {
  const salt = randomBytes(16), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv)
  cipher.setAAD(magic)
  const body = Buffer.concat([cipher.update(gzipSync(JSON.stringify(value))), cipher.final()])
  return Buffer.concat([magic, salt, iv, cipher.getAuthTag(), body])
}
export function unseal(input, password) {
  if (!input.subarray(0, 8).equals(magic) || input.length < 53) throw new Error('Invalid NativeCrew backup')
  const dec = createDecipheriv('aes-256-gcm', scryptSync(password, input.subarray(8, 24), 32), input.subarray(24, 36))
  dec.setAAD(magic); dec.setAuthTag(input.subarray(36, 52))
  let bytes
  try { bytes = Buffer.concat([dec.update(input.subarray(52)), dec.final()]) }
  catch { throw new Error('Backup password or authentication tag is invalid') }
  return JSON.parse(gunzipSync(bytes))
}

export const inside = (root, path) => path === root || (!isAbsolute(relative(root, path)) && !relative(root, path).split(sep).includes('..'))
export function child(root, rel) {
  if (typeof rel !== 'string' || isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || rel.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('Invalid relative backup path')
  return join(root, rel)
}
export function fileData(bytes) {
  return { data: bytes.toString('base64'), sha256: sha(bytes) }
}
export function decode(file) {
  const data = Buffer.from(file.data, 'base64')
  if (sha(data) !== file.sha256) throw new Error('Backup object digest mismatch')
  return data
}
export function tree(root, allow) {
  const files = []
  const visit = rel => {
    const p = rel ? child(root, rel) : root
    const stat = lstatSync(p)
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(p)
      if (!rel || isAbsolute(link) || !inside(root,join(dirname(p),link)) || !inside(realpathSync(root),realpathSync(p))) throw new Error('Managed workspace link points outside the archive: ' + p)
      files.push({ path: rel, link })
    } else if (stat.isDirectory()) {
      files.push({ path: rel, directory: true })
      for (const name of readdirSync(p)) if (rel || !allow || allow.has(name)) visit(rel ? rel + '/' + name : name)
    } else if (stat.isFile()) {
      files.push({ path: rel, ...fileData(readFileSync(p)), executable: Boolean(stat.mode & 0o100) })
    } else throw new Error('Unsupported file in managed workspace: ' + p)
  }
  if (existsSync(root)) visit('')
  return files
}
export function unpackTree(staging, files, allow) {
  mkdirSync(staging, { recursive: true, mode: 0o700 })
  for (const f of files) {
    if (f.path === '' && f.directory) continue
    if (allow && !allow.has(f.path.split('/')[0])) throw new Error('Invalid workspace member')
    const path = child(staging, f.path)
    if (f.link !== undefined) continue
    if (f.directory) mkdirSync(path, { recursive: true, mode: 0o700 })
    else { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, decode(f), { mode: f.executable ? 0o700 : 0o600, flag: 'wx' }) }
  }
  // Create links last. No regular archive entry may ever write through a link.
  for (const f of files) if (f.link !== undefined) {
    const path = child(staging,f.path)
    if (typeof f.link !== 'string' || isAbsolute(f.link) || !inside(staging,join(dirname(path),f.link)))
      throw new Error('Invalid managed workspace link')
    let parent = dirname(path)
    while (parent !== staging) {
      if (!lstatSync(parent).isDirectory()) throw new Error('A symlink cannot be an archive entry parent')
      parent = dirname(parent)
    }
    symlinkSync(f.link,path)
  }
  for (const f of files) if (f.link !== undefined && !inside(realpathSync(staging),realpathSync(child(staging,f.path))))
    throw new Error('The restored symbolic link escapes the managed directory')
}

// Inspect the v4 header without reading unrelated conversations. The first
// checksummed Zstd frame is a single independently decodable header line.
export function sessionHeader(file, compressed) {
  const fd = openSync(file,'r')
  try {
    const size = fstatSync(fd).size
    for (let n = Math.min(size,2048); n > 0 && n <= 1024*1024; n = Math.min(size,n*2)) {
      const buf = Buffer.alloc(n)
      const count = readSync(fd,buf,0,n,0)
      try {
        const data = compressed ? zstdDecompressSync(buf.subarray(0,count)) : buf.subarray(0,count)
        const end = data.indexOf(10)
        if (end !== -1) return JSON.parse(data.subarray(0,end))
      } catch (error) { if (n === size) throw error }
      if (n === size) break
    }
    throw new Error('Unreadable or unsupported DSH Session header')
  } finally { closeSync(fd) }
}

export function includeDescendants(roots,headers) {
  const children = new Map()
  for (const {id,parentSession} of headers) if (parentSession) {
    const list = children.get(parentSession) ?? []
    list.push(id)
    children.set(parentSession,list)
  }
  const queue = [...roots]
  for (let i=0; i<queue.length; i++) for (const id of children.get(queue[i]) ?? [])
    if (!roots.has(id)) { roots.add(id); queue.push(id) }
  return roots
}

// DSH v4 logs contain independent Zstd frames. Node's sync decoder stops at
// the first frame; bytesWritten identifies precisely the next frame boundary.
export function logLines(bytes, compressed) {
  const chunks = []
  if (compressed) {
    for (let offset = 0; offset < bytes.length;) {
      const res = zstdDecompressSync(bytes.subarray(offset), { info: true })
      if (!res.engine.bytesWritten) throw new Error('Incomplete DSH session frame')
      chunks.push(res.buffer)
      offset += res.engine.bytesWritten
    }
  } else chunks.push(bytes)
  const lines = Buffer.concat(chunks).toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  if (lines[0]?.type !== 'session' || lines[0].version !== 4) throw new Error('Unsupported DSH Session format')
  return lines
}
export function relocateLog(bytes, compressed, header) {
  const first = Buffer.from(JSON.stringify(header) + '\n')
  if (compressed) {
    const head = zstdDecompressSync(bytes, { info: true })
    if (head.buffer.indexOf(10) !== head.buffer.length - 1 || !head.engine.bytesWritten)
      throw new Error('DSH Session has no independent Zstandard header frame')
    const moved = zstdCompressSync(first, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
    return Buffer.concat([moved, bytes.subarray(head.engine.bytesWritten)])
  }
  return Buffer.concat([first, bytes.subarray(bytes.indexOf(10) + 1)])
}

function projectKey(cwd) {
  if (!cwd) return '_no-cwd'
  const src = cwd.replace(/[/\\:]+/g, '-').replace(/[^A-Za-z0-9._-]/g, c => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
  return '--' + (src.replace(/^-+/, '') || 'root').slice(0, 251) + '--'
}
export function logRelative(header, file) {
  if (typeof header.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(header.id) || !['session.v4.jsonl','session.v4.jsonl.zstd'].includes(file)) throw new Error('Invalid owned Session identity or filename')
  return [projectKey(header.cwd), header.id, file].join('/')
}
export function sessionRefs(state) {
  const known = new Set()
  for (const [id, bot] of Object.entries(state.bots ?? {})) {
    known.add(id)
    for (const parts of [[bot], bot.segments, bot.openParts, ...(bot.openParts ?? []).map(p => p.segments)]) {
      for (const p of parts ?? []) if (p.sessionId) known.add(p.sessionId)
    }
  }
  for (const [id, room] of Object.entries(state.rooms ?? {})) {
    known.add(id); if (room.sessionId) known.add(room.sessionId)
    for (const s of Object.values(room.sessions ?? {})) if (typeof s === 'string') known.add(s)
    for (const p of [...(room.parts ?? []), ...Object.values(room.segments ?? {}).flat()]) if (p.sessionId) known.add(p.sessionId)
  }
  for (const entry of state.privateArchives ?? []) {
    if (entry.id) known.add(entry.id)
    for (const session of entry.sessionIds ?? []) if (typeof session === 'string') known.add(session)
  }
  for (const agent of Object.values(state.agents ?? {})) for (const id of agent.sessions ?? []) known.add(id)
  return known
}

export function remapper(pairs) {
  const sorted = pairs.filter(([a,b]) => isAbsolute(a) && isAbsolute(b)).sort((a,b) => b[0].length - a[0].length)
  return path => {
    if (typeof path !== 'string' || !isAbsolute(path)) return path
    for (const [a,b] of sorted) if (inside(a,path)) return join(b,relative(a,path))
    // A Session can record a system alias (/var on macOS) while the archive
    // records the profile's real path. Resolve the nearest surviving parent.
    let parent = normalize(path)
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
    if (existsSync(parent)) {
      const canonical = join(realpathSync(parent), relative(parent, path))
      for (const [a,b] of sorted) if (inside(a,canonical)) return join(b,relative(a,canonical))
    }
    return normalize(path)
  }
}
export function mapFields(value, mapper, key) {
  if (typeof value === 'string') return /^(?:cwd|path|root|workDir|workspaceRoot|sourceRoot|sourceCwd|sourceGitDir|realRoot|folder|workspace)$/u.test(key ?? '') ? mapper(value) : value
  if (Array.isArray(value)) return value.map(i => mapFields(i, mapper, key))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, mapFields(v, mapper, k)]))
}

export function collectAttachments(value, objects) {
  if (!value || typeof value !== 'object') return
  if (typeof value.attachmentId === 'string' && /^sha256:[a-f\d]{64}$/.test(value.attachmentId)) {
    const id = value.attachmentId.slice(7)
    const parts = value.mediaType ? ['objects/' + id.slice(0, 2) + '/' + id] : [
      'file-objects/' + id.slice(0, 2) + '/' + id,
      'files/' + id.slice(0, 2) + '/' + id + '/' + value.name,
    ]
    for (const path of parts) objects.set(path, id)
  }
  for (const v of Object.values(value)) collectAttachments(v, objects)
}

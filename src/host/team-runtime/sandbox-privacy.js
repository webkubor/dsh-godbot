import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Background readers can outlive a turn, an account selection, or room membership.
// Remember only the DSH IDs that held sandbox content; keep the transcript itself
// in the existing Session store.
const sandboxRef = ref => typeof ref === 'string' && ref.startsWith('local-sandbox-')
const accountBound = row => Boolean(row?.accountProfileId || sandboxRef(row?.route) || sandboxRef(row?.model) || sandboxRef(row?.appliedModel))

function savedPart(rt, id) {
  const local = rt.state?.localAgents
  return local?.sandboxHistory?.[id] === true || accountBound(local?.sessions?.[id])
}

export function rememberSandboxSource(rt, part, roomId) {
  if (!part || !rt.state) return
  const local = rt.state.localAgents ??= { custom: [], sessions: {} }
  const marked = local.sandboxHistory ??= {}
  if (marked[part] === true && (!roomId || marked[roomId] === true)) return
  marked[part] = true
  if (roomId) marked[roomId] = true
  void rt.save?.()?.catch?.(() => {})
}

function protectedRoom(rt, room) {
  if (!room) return false
  if (savedPart(rt, room.id) || room.members?.some(id => accountBound(rt.botOf?.(id)))) return true
  // Includes state created before sandboxHistory was added.
  return Object.values(room.sessions ?? {}).some(id => savedPart(rt, id)) ||
    room.parts?.some(p => savedPart(rt, p?.sessionId)) ||
    Object.values(room.segments ?? {}).some(parts => Array.isArray(parts) && parts.some(p => savedPart(rt, p?.sessionId))) ||
    room.log?.some(line => line.botId && sandboxAuthor(rt, line.botId)) === true
}

// Unversioned learning and group logs identify the author, but omit the source
// part. An account switch must not make that author's old work eligible again.
function sandboxAuthor(rt, id) {
  const bot = rt.botOf?.(id)
  if (accountBound(bot) || savedPart(rt, id) || savedPart(rt, bot?.sessionId)) return true
  return [bot, ...bot?.openParts ?? []].some(part =>
    savedPart(rt, part?.sessionId) || part?.segments?.some(p => savedPart(rt, p?.sessionId)))
}

export function sandboxConversation(rt, id) {
  if (typeof id !== 'string' || !id) return false
  if (savedPart(rt, id)) return true
  const owner = rt.groupOwners?.get(id) ?? rt.pastOwners?.get(id)
  const roomId = owner?.roomId ?? rt.roomOwners?.get(id)
  const botId = owner?.botId ?? rt.chatOwners?.get(id) ?? rt.selfOf?.(id)
  if (accountBound(rt.botOf?.(botId ?? id))) return true
  return (roomId && savedPart(rt, roomId)) || protectedRoom(rt, rt.roomOf?.(roomId ?? id))
}

// The workspace runtime can restart with raw project-learning text already queued under
// a host keeper. Remember only the contributing IDs. New work passes partLines.
function existingProjectWork(home) {
  if (!home) return []
  try {
    const queues = JSON.parse(readFileSync(join(home, 'learning', 'state.json'), 'utf8')).agentsPending ?? {}
    return Object.entries(queues).map(([folder, group]) => ({
      folder, authors: [...new Set((group.records ?? []).map(row => row.botId ?? group.botId))],
    }))
  } catch { return [] }
}

// NativeCrew installs manual memory tools alongside the review listeners. Filter only
// those modules' background status events and transcript readers; UI/history/tools
// across the rest of the runtime keep their original view.
export function sandboxAwareObserver(module) {
  return { install(rt) {
    const projects = module.agentsSystem ? existingProjectWork(rt.home) : []
    const ctx = new Proxy(rt.ctx, { get(target, key) {
      if (key !== 'on') return Reflect.get(target, key, target)
      return (event, fn, ...args) => {
        if (event !== 'agent/status') return target.on(event, fn, ...args)
        return target.on(event, function (payload, ...rest) {
          const id = payload.agent?.id
          if (sandboxConversation(rt, id)) {
            const roomId = rt.groupOwners?.get(id)?.roomId ?? rt.pastOwners?.get(id)?.roomId ?? rt.roomOwners?.get(id)
            rememberSandboxSource(rt, id, roomId)
            return
          }
          return fn.call(this, payload, ...rest)
        }, ...args)
      }
    } })
    const scoped = new Proxy(rt, { get(target, key) {
      if (key === 'ctx') return ctx
      if (key === 'botShot' && projects.length) return (bot, system, text, tag) => {
        if (system === module.agentsSystem()) {
          const index = projects.findIndex(job => text.startsWith('Project folder: ' + job.folder + '\n\n'))
          if (index >= 0 && projects[index].authors.some(id => sandboxAuthor(rt, id))) {
            projects.splice(index, 1)
            // NativeCrew consumes the legacy queue through its own persistence path.
            return Promise.resolve('{"action":"none"}')
          }
        }
        return rt.botShot(bot, system, text, tag)
      }
      if (key === 'groupLinesAfter') return async (roomId, ...args) => {
        const lines = await rt.groupLinesAfter(roomId, ...args)
        if (lines.some(line => line.botId && sandboxAuthor(rt, line.botId))) rememberSandboxSource(rt, roomId)
        return sandboxConversation(rt, roomId) ? [] : lines
      }
      // Persisted learning queues and reviews queued before a binding change
      // may name an old part but tag their final request with today's part.
      if (key === 'partLines') return async function* (id, ...args) {
        if (sandboxConversation(rt, id)) return
        for await (const row of rt.partLines(id, ...args)) {
          if (sandboxConversation(rt, id)) return
          yield row
        }
      }
      return Reflect.get(target, key, target)
    } })
    module.install(scoped)
  } }
}

export function install(rt) {
  const assemble = rt.assembleLlm
  const denied = () => new Error('沙箱会话的后台分析不能发送到其他模型。')
  // Pinned workspace helpers use this for memory, learning, OCR, handoffs, etc.
  // Ordinary foreground agent messages go directly through the DSH adapter.
  rt.assembleLlm = options => {
    if (sandboxConversation(rt, options.sessionId)) throw denied()
    return assemble(options)
  }
  rt.ctx.on('llm/stream', (options, next) => {
    // Includes DSH title/compaction calls and a retry that outlives the original
    // call's account binding. Allow local title formatting in the sandbox adapter.
    if ((options.purpose != null || rt.ownRequest?.(options)) && sandboxConversation(rt, options.sessionId)) {
      const owner = rt.botOf?.(rt.selfOf?.(options.sessionId))
      if (!sandboxRef(options.provider) || options.provider !== owner?.model?.split('/')[0]) throw denied()
    }
    return next()
  }, { prepend: true })
}

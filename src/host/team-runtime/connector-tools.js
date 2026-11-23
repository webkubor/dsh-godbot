// NativeCrew mounts each connector as a DSH MCP client. Capture its actual registrations so
// a similarly named tool from another plugin or a scoped override is never bridged.
import * as connectorModule from './core/connectors/index.js'

function overlay(object, fields) {
  return Object.create(object, Object.getOwnPropertyDescriptors(fields))
}

// The upstream team bridge drops refs and selects the first union branch. For third-party
// tools preserve the complete contract; reject constructs the shared CLI transport cannot
// express, rather than silently advertising a different set of accepted arguments.
export function connectorSchema(root) {
  if (root?.type !== 'object') throw new Error('参数的根类型须为对象')
  const definitions = new Set(['$defs', 'definitions'])
  const maps = new Set(['properties', 'patternProperties', 'dependentSchemas'])
  const singles = new Set(['items', 'additionalProperties', 'contains', 'propertyNames',
    'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'additionalItems'])
  let nodes = 0
  function expand(schema, ancestors) {
    if (++nodes > 8192) throw new Error('展开的参数结构过大')
    if (typeof schema === 'boolean') return schema
    if (!schema || Array.isArray(schema) || typeof schema !== 'object') throw new Error('参数声明无效')
    if (Object.hasOwn(schema, '$ref')) {
      const ref = schema.$ref
      if (typeof ref !== 'string' || !ref.startsWith('#/') || ancestors.has(ref)) throw new Error('无法展开外部或递归参数引用')
      if (Object.keys(schema).some(key => !['$ref', 'description', 'title', '$defs', 'definitions'].includes(key))) {
        throw new Error('无法完整展开带附加约束的参数引用')
      }
      let target = root
      for (const part of ref.slice(2).split('/')) {
        const key = part.replaceAll('~1', '/').replaceAll('~0', '~')
        if (!target || !Object.hasOwn(target, key)) throw new Error('参数引用不存在')
        target = target[key]
      }
      const resolved = expand(target, new Set([...ancestors, ref]))
      if (typeof resolved === 'object' && schema.description) return { ...resolved, description: schema.description }
      return resolved
    }
    const out = Object.create(null)
    for (const [key, value] of Object.entries(schema)) {
      if (definitions.has(key)) continue
      if (['oneOf', 'anyOf', 'allOf', '$dynamicRef', '$recursiveRef', '$id'].includes(key)) {
        throw new Error('当前 CLI 桥无法完整表示参数约束 ' + key)
      }
      if (maps.has(key)) out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, expand(sub, ancestors)]))
      else if (key === 'dependencies') out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) =>
        [name, Array.isArray(sub) ? sub : expand(sub, ancestors)]))
      else if (key === 'prefixItems' || (key === 'items' && Array.isArray(value))) out[key] = value.map(item => expand(item, ancestors))
      else if (singles.has(key)) out[key] = expand(value, ancestors)
      else if (key !== 'const') out[key] = value
    }
    if (Object.hasOwn(schema, 'const')) {
      if (schema.enum) throw new Error('无法完整表示同时使用 const 和 enum 的参数')
      out.enum = [schema.const]
    }
    return out
  }
  return expand(root, new Set())
}

export class ConnectorTools {
  constructor(rt) {
    this.rt = rt
    this.entries = new Map()
    this.observed = new Map()
    this.calls = new Map()
  }

  register(id, registry, definition, options) {
    const entry = { id, name: definition.name }
    try { entry.input = connectorSchema(definition.parameters) }
    catch (error) { entry.unsupported = error.message }
    const catalog = this
    entry.definition = {
      ...definition,
      async execute(args, exec) {
        const sessionId = exec.agent?.session?.id
        // A pending approval can outlive a connector grant or registration.
        if (catalog.denyPending(exec) || (catalog.rt.selfOf(sessionId) && !catalog.allowed(entry, sessionId, exec.agent))) {
          throw new Error('此会话的连接器授权或挂载已变更，请重新检查成员工具。')
        }
        return definition.execute(args, exec)
      },
    }
    const dispose = registry.register(entry.definition, options)
    this.entries.set(entry.name, entry)
    return () => {
      if (this.entries.get(entry.name) === entry) this.entries.delete(entry.name)
      return dispose()
    }
  }

  allowed(entry, sessionId, agent) {
    const rt = this.rt
    const botId = rt.selfOf(sessionId)
    const saved = rt.state.connectors?.[entry.id]
    const mounts = rt.connectorsInternals
    if (!rt.isBotSession(sessionId) || !rt.botOf(botId) || this.entries.get(entry.name) !== entry ||
        !mounts?.mounts.get(entry.id)?.fiber || mounts.statuses.has(entry.id) && mounts.statuses.get(entry.id)?.state !== 'ready' ||
        saved?.offFor?.includes(botId) || (saved?.readOnly && saved.custom?.command)) return false
    const caller = agent ?? rt.ctx.get('agents')?.get(sessionId)
    return !!caller && rt.ctx.tools.get(entry.name, caller) === entry.definition
  }

  forStep(options, teamNames) {
    const result = []
    for (const tool of options.tools ?? []) {
      if (teamNames.has(tool.name)) result.push(tool)
      else {
        const entry = this.entries.get(tool.name)
        if (entry?.input && this.allowed(entry, options.sessionId)) {
          const saved = this.rt.state.connectors?.[entry.id]
          result.push({ ...tool, bridgeInput: entry.input, connector: entry,
            account: saved?.account ?? saved?.login, connectedAt: saved?.connectedAt })
        }
      }
    }
    return result
  }

  denyPending(exec) {
    const pending = this.calls.get(exec.callId)
    if (!pending) return
    if (exec.agent?.session?.id !== pending.sessionId || exec.name !== pending.tool.name ||
        this.rt.selfOf(pending.sessionId) !== pending.botId || !this.current([pending.tool], pending.sessionId).length) {
      return '此会话的连接器授权或挂载已变更，请重新检查成员工具。'
    }
  }

  current(tools, sessionId) {
    return tools.filter(tool => {
      if (!tool.connector) return true
      const saved = this.rt.state.connectors?.[tool.connector.id]
      return tool.account === (saved?.account ?? saved?.login) && tool.connectedAt === saved?.connectedAt &&
        this.allowed(tool.connector, sessionId)
    })
  }

  observation(sessionId, route) {
    let item = this.observed.get(sessionId)
    if (!item || item.route !== route) {
      item = { route, names: [], pending: new Map(), results: new Map() }
      this.observed.set(sessionId, item)
    }
    return item
  }

  listed(sessionId, route, tools) {
    const item = this.observation(sessionId, route)
    item.names = tools.map(tool => tool.name).filter(name => this.entries.has(name))
    item.listedAt = Date.now()
  }

  // A Bot's own DSH round shows the tools it was offered. NativeCrew's own requests
  // for that Session, such as the memory keeper after each turn, name the
  // Session but carry a usage tag; they must not replace the round's catalog or
  // its call receipts. CLI rounds are observed through their MCP bridge instead.
  step(options) {
    const rt = this.rt
    if (options.purpose !== undefined || !options.sessionId || !rt.isBotSession(options.sessionId) ||
        rt.ownRequest?.(options) || rt.isLocalAgentRoute?.(options.provider)) return
    this.listed(options.sessionId, options.provider, options.tools ?? [])
  }

  event(sessionId, event) {
    const observed = this.observed.get(sessionId)
    if (!observed || !this.rt.isBotSession(sessionId)) return
    if (event.type === 'turn/end') observed.pending.clear()
    if (event.type === 'tool/call' && this.entries.has(event.data?.name)) observed.pending.set(event.data.callId, event.data.name)
    if (event.type !== 'tool/result') return
    const message = event.data?.message
    const name = observed.pending.get(message?.toolCallId)
    if (!name) return
    observed.pending.delete(message.toolCallId)
    observed.results.set(name, { at: event.time ?? Date.now(), error: message.isError === true, callId: message.toolCallId })
  }

  view(botId, sessionId) {
    const rt = this.rt
    const bot = rt.botOf(botId)
    if (!bot || !rt.isBotSession(sessionId) || rt.selfOf(sessionId) !== botId || rt.groupOwners.has(sessionId)) throw new Error('请选择当前成员的私聊。')
    const configuredRoute = (bot.model ?? bot.appliedModel ?? '').split('/')[0]
    const history = this.observed.get(sessionId)
    const last = history && (!configuredRoute || history.route === configuredRoute) ? history : undefined
    const route = configuredRoute || last?.route || ''
    const cli = rt.isLocalAgentRoute(route)
    const agent = rt.ctx.get('agents')?.get(sessionId)
    const rows = rt.connectorsView().connectors.filter(row => row.state !== 'off').map(row => {
      const enabled = !row.offFor.includes(botId)
      const tools = [...this.entries.values()].filter(entry => entry.id === row.id).map(entry => {
        const available = this.allowed(entry, sessionId, agent)
        const reason = !enabled ? '该成员已停用' : cli && entry.unsupported ? entry.unsupported :
          row.state !== 'ready' ? '连接器尚未就绪' : !agent ? '等待会话启动' : !available ? '当前会话未获准' : undefined
        return { name: entry.name, listed: !!last?.names.includes(entry.name), ...(reason ? { reason } : {}),
          ...(last?.results.has(entry.name) ? { result: last.results.get(entry.name) } : {}) }
      })
      return { id: row.id, name: row.name, state: row.state, enabled, readOnly: row.readOnly === true, tools }
    })
    return { botId, sessionId, route, listedAt: last?.listedAt ?? null, rows }
  }
}

export function install(rt) {
  const catalog = new ConnectorTools(rt)
  rt.connectorTools = catalog
  const ctx = rt.ctx
  const connectorRuntime = Object.create(rt)
  connectorRuntime.ctx = overlay(ctx, {
    plugin(plugin, config) {
      return ctx.plugin({
        ...plugin,
        async apply(inner, current) {
          const registry = inner.tools
          const tools = overlay(registry, {
            register: (definition, options) => catalog.register(current.serverName, registry, definition, options),
          })
          return plugin.apply(inner.extend({ tools }), current)
        },
      }, config)
    },
  })
  connectorModule.install(connectorRuntime)
  const { ctx: _ctx, ...installed } = connectorRuntime
  Object.assign(rt, installed)
  ctx.on('llm/stream', (options, next) => {
    catalog.step(options)
    return next()
  })
  ctx.on('session/event', (session, event) => {
    catalog.event(session.id, event)
  })
  ctx.tools.guard(exec => catalog.denyPending(exec))
  ctx.on('agent/disposed', ({ agent }) => catalog.observed.delete(agent?.session?.id ?? agent?.id))
}

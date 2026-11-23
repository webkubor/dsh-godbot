import { hostSetting } from './host-environment.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openEnvironment, recoverContainers, removeVolume, viewport } from './browser-environments.js'

import * as upstream from './core/browser-plugins.js'
import { createSession } from './core/browser/session.js'
import { BrowserTeaching, teachingTarget } from './browser-teaching.js'
const validKeys = new Set(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])
const enableBrowser = '请在该 Bot 私聊打开「网页浏览器」，点击「打开执行环境」。'
const browserLogin = '该 Bot 使用独立浏览器登录状态。如果网站要求登录，请接管网页完成登录，然后交还给 Bot。'
const browserTaken = 'The user has taken over this browser. Wait for them to give it back.'

function pageUrl(raw) {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入 HTTP 或 HTTPS 网页地址')
  return url.href
}

function ordered(entry, work) {
  const running = entry.tail.then(work)
  entry.tail = running.catch(() => {})
  return running
}

class BrowserViews {
  entries = new Map()
  closed = false
  recoveries = new Map()
  constructor(rt, config) {
    this.rt = rt
    this.config = config
    this.teaching = new BrowserTeaching(rt)
    this.leaseMs = Math.max(1500, Math.min(Number(config.leaseMs) || 20_000, 120_000))
  }
  targets() {
    return ['local', ...(this.config.containerImage ? ['container'] : []),
      ...(this.config.cloudContext && (this.config.cloudImage || this.config.containerImage) ? ['cloud'] : [])]
  }
  entry(bot) {
    let entry = this.entries.get(bot.id)
    if (!entry) {
      entry = { botId: bot.id, target: bot.godbotBrowserTarget ?? 'local', tail: Promise.resolve(), epoch: randomUUID() }
      this.entries.set(bot.id, entry)
    }
    return entry
  }
  lease(entry) {
    if (entry.lease?.expires <= Date.now()) {
      const { token } = entry.lease
      entry.lease = undefined
      entry.expired = true
      void ordered(entry, () => this.teaching.stop(entry.botId, token))
        .catch(error => this.rt.warn('godbot: browser demonstration could not be saved: %s', error.message))
    }
    return entry.lease
  }
  enabled(bot) {
    return Boolean(bot.godbotBrowserEnabled || this.rt.config.browserPlugin)
  }
  status(bot) {
    if (!this.enabled(bot)) return `BROWSER_NOT_ENABLED: ${enableBrowser} ${browserLogin}`
    const entry = this.entry(bot)
    if (this.lease(entry)) return `BROWSER_TAKEN_OVER: ${browserTaken}`
    const status = entry.resource ? 'BROWSER_READY' : 'BROWSER_CAN_START'
    return `${status}: 执行环境 ${entry.target}。${browserLogin}`
  }
  async resource(entry) {
    if (entry.closed || this.closed) throw new Error('浏览器会话已关闭')
    if (!entry.opening) {
      const opening = this.launch(entry)
      entry.opening = opening
      opening.then(session => { entry.resource = session }, () => { if (entry.opening === opening) entry.opening = undefined })
    }
    return entry.opening
  }
  async recover(target) {
    if (target === 'local') return
    if (!this.recoveries.has(target)) {
      const attempt = recoverContainers(this.rt.home, target, this.config)
      this.recoveries.set(target, attempt)
      attempt.catch(() => { if (this.recoveries.get(target) === attempt) this.recoveries.delete(target) })
    }
    await this.recoveries.get(target)
  }
  async launch(entry) {
    const { rt, config } = this
    const botId = entry.botId
    const profileDir = join(rt.home, 'browser-profiles', botId)
    await mkdir(profileDir, { recursive: true, mode: 0o700 })
    await this.recover(entry.target)
    const env = await openEnvironment({ home: rt.home, botId, target: entry.target, config, profileDir })
    try {
      const context = env.context
      // Restrict this remotely operated browser to web content, including subresource navigations.
      await context.route('**/*', route => {
        const url = route.request().url()
        return /^(https?:|data:|blob:|about:)/iu.test(url) ? route.continue() : route.abort('blockedbyclient')
      })
      const pages = context.pages()
      const current = pages[0] ?? await context.newPage()
      await current.setViewportSize(viewport)
      const cookieFile = join(profileDir, 'cookies.json')
      if (entry.target === 'local') {
        try { const kept = JSON.parse(await readFile(cookieFile, 'utf8')); if (Array.isArray(kept)) await context.addCookies(kept) }
        catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      const roots = async () => {
        const team = rt.teamFolder()
        const folder = rt.workDirOf({ botId })
        return [...new Set([folder && await rt.isFolder(folder) ? folder : team, team].filter(Boolean))]
      }
      const session = createSession({
        browser: env.browser, context, page: current, botId, userDataDir: profileDir, cookieFile, actionTimeout: 5000, downloadGraceMs: 300,
        downloadDir: async () => (await roots())[0], uploadRoots: roots,
        getHold: () => entry.handoff ?? null, onHold: hold => { entry.handoff = hold },
      })
      const navigate = session.open.bind(session)
      session.open = async value => {
        const url = pageUrl(value)
        try { return await navigate(url) }
        catch (error) {
          const networkError = /net::(ERR_[A-Z_]+)/u.exec(error.message)?.[1]
          if (!networkError) throw error
          throw new Error(`BROWSER_NAVIGATION_FAILED (${networkError}): 执行环境 ${entry.target} 未能打开 ${new URL(url).hostname}。`)
        }
      }
      const resource = { context, page: current, env, session, ids: new WeakMap(), closed: false }
      const track = page => {
        const invalidate = () => resource.ids.set(page, randomUUID())
        invalidate()
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) invalidate() })
      }
      for (const page of context.pages()) track(page)
      context.on('page', page => { track(page); resource.page = page })
      context.on('close', () => {
        resource.closed = true
        if (entry.resource !== resource) return
        const token = entry.lease?.token
        entry.lease = undefined
        if (token) void ordered(entry, () => this.teaching.stop(entry.botId, token))
          .catch(error => this.rt.warn('godbot: browser demonstration could not be saved: %s', error.message))
        entry.epoch = randomUUID()
        entry.expired = true
        entry.resource = undefined
        // Finish provider cleanup before another open can allocate this Bot's environment.
        const cleanup = env.close().catch(() => {})
        entry.opening = cleanup.then(() => { throw new Error('浏览器连接已断开，请重新打开') })
        entry.opening.catch(() => { if (!entry.resource) entry.opening = undefined })
      })
      return resource
    } catch (error) { await env.close(); throw error }
  }
  async agent(spec, args, ctx) {
    const bot = this.rt.botOf(ctx.botId)
    if (!bot) throw new Error('未找到此工具调用所属的 Bot。')
    if (spec.name === 'browser_status') return this.status(bot)
    if (!this.enabled(bot)) throw new Error(`BROWSER_NOT_ENABLED: 尚未向目标网站发起请求。${enableBrowser} ${browserLogin}`)
    const entry = this.entry(bot)
    if (this.lease(entry)) throw new Error(`BROWSER_TAKEN_OVER: ${browserTaken}`)
    if (spec.name === 'browser_open') pageUrl(args.url)
    return ordered(entry, async () => {
      if (this.lease(entry)) throw new Error(`BROWSER_TAKEN_OVER: ${browserTaken}`)
      entry.agentBusy = true
      try {
        let res = entry.resource
        if (spec.needsBrowser) {
          try { res = await this.resource(entry) }
          catch (error) {
            const detail = String(error.message).split('\n', 1)[0]
            throw new Error(`BROWSER_ENVIRONMENT_START_FAILED: 执行环境 ${entry.target} 启动失败。${detail}`)
          }
        }
        return await spec.execute(args, { ...ctx, session: res?.session })
      } finally {
        const res = entry.resource
        if (res) {
          const tabs = await res.session.tabs().catch(() => [])
          const active = tabs.find(row => row.current)
          if (active) res.page = res.context.pages()[active.index] ?? res.page
        }
        entry.agentBusy = false
      }
    })
  }
  async stop(entry, forget = false) {
    entry.closed = true
    const token = entry.lease?.token
    entry.lease = undefined
    await entry.tail
    if (token) await this.teaching.stop(entry.botId, token)
    const resource = await entry.opening?.catch(() => undefined)
    if (resource) {
      entry.resource = undefined
      // Close the NativeCrew session while the context is still available for its cookie checkpoint.
      try { await resource.session.close() } finally { await resource.env.close() }
    }
    if (forget && entry.target !== 'local') await removeVolume(this.rt.home, entry.botId, entry.target, this.config)
    if (this.entries.get(entry.botId) === entry) this.entries.delete(entry.botId)
  }
  executionOrigin(botId) {
    const resource = this.entries.get(botId)?.resource
    if (!resource) return undefined
    try { return new URL(this.page(resource).url()).origin } catch { return undefined }
  }
  async invoke(req) {
    await this.rt.load()
    const bot = this.rt.botOf(req.botId)
    if (this.closed || !bot || typeof req.sessionId !== 'string' || this.rt.chatOf(bot.id) !== req.sessionId) throw new Error('请从该 Bot 的当前私聊打开浏览器')
    const entry = this.entry(bot)
    const lease = this.lease(entry)
    if (req.action === 'browser.status') return { targets: this.targets(), target: entry.target, open: !!entry.resource }
    if (req.action === 'browser.teaching.list') return { version: 1, records: this.teaching.saved(bot.id) }
    if (req.action === 'browser.teaching.remove') return ordered(entry, () => this.teaching.remove(bot.id, req.id))
    if (req.action === 'browser.teaching.draft') return this.teaching.draft(bot.id, req.id)
    if (req.action === 'browser.open') {
      const target = req.target ?? entry.target
      if (!this.targets().includes(target)) throw new Error('该执行环境未配置')
      return ordered(entry, async () => {
        if (entry.closed || this.closed) throw new Error('浏览器会话已关闭')
        if (entry.target !== target && entry.opening) throw new Error('请先关闭当前执行环境')
        entry.target = target
        if (target !== 'local' && !bot.godbotBrowserVolumes?.includes(target)) {
          bot.godbotBrowserVolumes = [...(bot.godbotBrowserVolumes ?? []), target]
          await this.rt.save()
        }
        await this.resource(entry)
        bot.godbotBrowserEnabled = true
        bot.godbotBrowserTarget = target
        await this.rt.save()
        return { target, open: true, resourceId: entry.resource.env.resourceId }
      })
    }
    if (!entry.resource || entry.closed) throw new Error('浏览器连接已断开，请重新打开')
    if (req.action === 'browser.take') {
      if (lease && lease.token !== req.lease) throw new Error('另一个页面正在接管浏览器')
      entry.expired = false
      entry.lease = { token: lease?.token ?? randomUUID(), expires: Date.now() + this.leaseMs }
      return { lease: entry.lease.token, pending: !!entry.agentBusy }
    }
    const mine = !!lease && lease.token === req.lease
    if (req.action === 'browser.frame') {
      if (mine) lease.expires = Date.now() + this.leaseMs
      const resource = entry.resource
      const page = this.page(resource)
      const recording = mine && this.teaching.active(bot.id, req.lease)
      const ownership = { epoch: entry.epoch, target: entry.target,
        recording: recording ? { id: recording.id, count: recording.steps.length } : null,
        control: mine ? entry.agentBusy ? 'pending' : 'mine' : lease ? 'other' : entry.handoff ? 'handoff' : 'agent', expired: !!entry.expired }
      if (req.surface === 'desktop') {
        if (!resource.env.desktop) throw new Error('所选环境只提供浏览器视图')
        const frame = await resource.env.desktop.frame()
        return { ...frame, ...ownership, surface: 'desktop', frameId: entry.epoch + '/' + frame.window }
      }
      const frameId = resource.ids.get(page)
      const bytes = await page.screenshot({ type: 'jpeg', quality: 38, timeout: 5000 })
      if (resource.closed || resource.ids.get(page) !== frameId) throw new Error('页面正在切换')
      return { data: bytes.toString('base64'), frameId, viewport: page.viewportSize() ?? viewport,
        url: page.url(), title: await page.title(), surface: 'browser', ...ownership }
    }
    if (req.action === 'browser.close') {
      if (entry.agentBusy || (lease && !mine)) throw new Error('执行环境正在使用')
      await this.stop(entry)
      return { open: false }
    }
    if (!mine) throw new Error('此页面的接管权已失效')
    if (req.action === 'browser.release') return ordered(entry, async () => {
      if (this.lease(entry)?.token !== req.lease) throw new Error('此页面的接管权已失效')
      await this.teaching.stop(bot.id, req.lease)
      entry.lease = undefined
      entry.handoff = undefined
      return { released: true }
    })
    if (req.action === 'browser.teaching.start' || req.action === 'browser.teaching.stop') return ordered(entry, async () => {
      if (this.lease(entry)?.token !== req.lease || entry.closed || entry.agentBusy) throw new Error('请先接管 Bot 网页')
      if (req.action === 'browser.teaching.start') return this.teaching.start(bot.id, req.lease, req.goal)
      return this.teaching.stop(bot.id, req.lease)
    })
    if (req.action !== 'browser.input') throw new Error('未知浏览器操作')
    return ordered(entry, async () => {
      if (this.lease(entry)?.token !== req.lease || entry.closed) throw new Error('此页面的接管权已失效')
      const resource = entry.resource
      if (req.surface === 'desktop') {
        if (!resource.env.desktop || typeof req.frameId !== 'string' || !req.frameId.startsWith(entry.epoch + '/')) throw new Error('桌面画面已过期')
        entry.lease.expires = Date.now() + this.leaseMs
        await resource.env.desktop.input(req, req.frameId.slice(entry.epoch.length + 1))
        return { delivered: true }
      }
      const page = this.page(resource)
      if (resource.ids.get(page) !== req.frameId) throw new Error('页面已改变，请在最新画面上重试')
      entry.lease.expires = Date.now() + this.leaseMs
      const recording = this.teaching.active(bot.id, req.lease)
      const before = recording ? page.url() : undefined
      let element
      if (req.kind === 'navigate') await page.goto(pageUrl(req.url), { waitUntil: 'domcontentloaded', timeout: 15_000 })
      else if (req.kind === 'click' && Number.isFinite(req.x) && Number.isFinite(req.y) && req.x >= 0 && req.y >= 0 && req.x < 1 && req.y < 1) {
        const size = page.viewportSize() ?? viewport
        const x = Math.floor(req.x * size.width)
        const y = Math.floor(req.y * size.height)
        if (recording) element = await teachingTarget(page, x, y)
        await page.mouse.click(x, y)
      } else if (req.kind === 'text' && typeof req.text === 'string' && req.text.length <= 8192) await page.keyboard.insertText(req.text)
      else if (req.kind === 'key' && validKeys.has(req.key)) await page.keyboard.press(req.key)
      else if (req.kind === 'scroll' && Number.isFinite(req.delta) && Math.abs(req.delta) <= 2000) await page.mouse.wheel(0, req.delta)
      else throw new Error('未知的浏览器输入')
      if (recording) {
        const after = page.isClosed() ? resource.context.pages().at(-1)?.url() : page.url()
        this.teaching.note(bot.id, req.lease, req, before, after, element)
      }
      return { delivered: true }
    })
  }
  page(resource) {
    const page = resource.page.isClosed() ? resource.context.pages().at(-1) : resource.page
    if (!page) throw new Error('浏览器没有可用标签页')
    return page
  }
}

function desktopTools(views) {
  const screen = { name: 'godbot_desktop_view', needsBrowser: true, parameters: {},
    description: 'Read the current screen of your assigned container or cloud desktop, including its focused window and frame ID.' }
  const input = { name: 'godbot_desktop_input', needsBrowser: true,
    description: 'Request one action on your assigned desktop. Use the frame ID from godbot_desktop_view. The owner can approve or deny the action.',
    parameters: {
      frameId: { type: 'string', required: true }, kind: { type: 'string', required: true, enum: ['click','text','key','scroll'] },
      x: { type: 'number', description: 'Horizontal fraction of the screen, from 0 to below 1' },
      y: { type: 'number', description: 'Vertical fraction of the screen, from 0 to below 1' },
      text: { type: 'string' }, key: { type: 'string' }, delta: { type: 'number' },
    } }
  for (const spec of [screen, input]) spec.execute = async (args, ctx) => {
    const entry = views.entries.get(ctx.botId)
    const desktop = entry?.resource?.env.desktop
    if (!desktop) throw new Error('先为此 Bot 配置并打开容器或云桌面')
    if (spec === screen) {
      const frame = await desktop.frame()
      return { text: 'Focused window: ' + frame.title + '\nDesktop frame: ' + entry.epoch + '/' + frame.window + '\nWorkspace: /profile/work', image: frame.data }
    }
    if (typeof args.frameId !== 'string' || !args.frameId.startsWith(entry.epoch + '/')) throw new Error('桌面画面已过期')
    await desktop.input(args, args.frameId.slice(entry.epoch.length + 1))
    return 'Desktop input delivered.'
  }
  return [screen, input]
}

export function install(rt) {
  const settings = rt.config.serverBrowser
  const plugin = upstream.browserPlugins[rt.config.browserPlugin ?? 'refs']
  if (settings === false || !plugin || rt.config.browserPluginApi || hostSetting('APP') === '1' || rt.ctx.get?.('profileContext')?.name !== 'web') {
    upstream.install(rt)
    return
  }
  const config = { executablePath: rt.config.browserExecutablePath, ...(settings || {}) }
  const views = new BrowserViews(rt, config)
  const status = { name: 'browser_status', parameters: {},
    description: 'Check whether the owner enabled this Bot’s separate NativeCrew browser, and whether it is available. Does not launch the browser or access a website.' }
  const desktop = views.targets().some(target => target !== 'local') ? desktopTools(views) : []
  const tools = [...(plugin.tools ?? plugin.toolDefs), ...desktop].map(def => ({ ...def, needsBrowser: false,
    description: `${def.description} This uses the Bot’s separate NativeCrew browser. If it is unavailable, call browser_status and follow the setup or takeover instructions.`,
    execute: (args, ctx) => views.agent(def, args, ctx) }))
  const spec = { ...plugin, tools: [...tools, { ...status, execute: (args, ctx) => views.agent(status, args, ctx) }] }
  const shim = Object.create(rt)
  shim.config = { ...rt.config, browserPluginApi: spec }
  upstream.install(shim)
  rt.ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'godbot_desktop_input') return next()
    const bot = rt.botOf(rt.selfOf(exec.agent?.session?.header?.id ?? exec.agent?.id))
    const entry = bot && views.entries.get(bot.id)
    if (!entry?.resource?.env.desktop || views.lease(entry)) throw new Error('当前没有允许 Bot 操作的独立桌面')
    const approval = rt.ctx.get?.('approval')
    if (!approval || !exec.agent?.session) throw new Error('需要所有者批准桌面输入')
    const args = exec.arguments ?? {}
    const action = args.kind === 'text' ? String(args.text ?? '').slice(0, 512) : args.kind === 'key' ? args.key
      : args.kind === 'click' ? [args.x, args.y].join(', ') : String(args.delta)
    const decision = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
      reason: bot.name + ' requests desktop ' + args.kind + ': ' + action })
    if (decision !== 'allowed-once') throw new Error('桌面操作未获批准')
    exec.signal?.throwIfAborted()
    return next()
  }, { prepend: true })
  void rt.load().then(async () => {
    const used = new Set(Object.values(rt.state.bots ?? {}).flatMap(bot => bot.godbotBrowserVolumes ?? []))
    await Promise.all([...used].filter(target => views.targets().includes(target)).map(target => views.recover(target)))
  }).catch(error => rt.warn?.('Browser resource recovery: %s', error.message))
  rt.godbotBrowser = views
  rt.browserPlugin = shim.browserPlugin
  const originalDelete = rt.deleteBot?.bind(rt)
  if (originalDelete) rt.deleteBot = async (id, ...args) => {
    const bot = rt.botOf(id)
    const result = await originalDelete(id, ...args)
    const entry = views.entries.get(id)
    if (entry) await views.stop(entry)
    if (rt.state.browserDemonstrations?.[id]) {
      delete rt.state.browserDemonstrations[id]
      await rt.save()
    }
    for (const target of bot?.godbotBrowserVolumes ?? []) await removeVolume(rt.home, id, target, config)
    await rm(join(rt.home, 'browser-profiles', id), { recursive: true, force: true })
    return result
  }
  rt.ctx.effect(() => async () => {
    views.closed = true
    await Promise.all([...views.entries.values()].map(entry => views.stop(entry)))
  }, 'NativeCrew web browsers')
}

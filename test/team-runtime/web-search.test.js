import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { apply as managed } from '../../src/host/workspace-search.js'

const page = '<ol id="b_results"><li class="b_algo"><h2><a href="https://fixture.example/bing">Fixture</a></h2><div class="b_caption"><p>From the public result page</p></div></li></ol>'
function context(origin) {
  const registry = new Map()
  const state = { selection: 'auto', hasKey: true, pages: 0 }
  const services = {
    agents: { currentInitiator: () => ({ session: { id: 'fixture', requestContext: () => ({ provider: 'deepseek-official', model: 'fixture-model' }) } }) },
    launchEnvironment: { get(name) { return name === 'DEEPSEEK_BASE_URL' ? { value: origin } : undefined } },
    credentials: { resolve() { return state.hasKey ? { value: 'test-only' } : undefined } },
  }
  return {
    state, registry, get: name => services[name],
    web: {
      config: { searchProvider: { get: () => state.selection } },
      registerSearchProvider(provider) {
        if (registry.has(provider.id)) throw Object.assign(new Error('Duplicate'), { code: 'WEB_DUPLICATE_PROVIDER' })
        registry.set(provider.id, provider)
      },
      fetch: async ({ url }) => {
        state.pages++
        assert.equal(new URL(url).hostname, 'www.bing.com')
        return { url, statusCode: 200, body: { kind: 'html', content: page }, truncated: false }
      },
    },
  }
}

test('the workspace search provider uses the session credential and falls back to keyless public search', async t => {
  let calls = 0
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    assert.equal(body.model, 'fixture-model')
    assert.equal(req.headers['x-api-key'], 'test-only')
    assert.ok(body.tools.some(tool => tool.type.startsWith('web_search')))
    calls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [
      { type: 'server_tool_use', name: 'web_search' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://fixture.example/native', title: 'Native' }] },
    ] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = 'http://127.0.0.1:' + server.address().port
  const ctx = context(origin)
  managed(ctx)
  const request = { query: 'source parity', maxResults: 3 }
  const search = () => ctx.registry.get('auto').search(request)
  const native = await search()
  assert.match(native.content, /Search backend: native search/)
  assert.equal(native.sources[0].url, 'https://fixture.example/native')
  ctx.state.hasKey = false
  const fallback = await search()
  assert.match(fallback.content, /keyless fallback.*Bing/)
  assert.equal(fallback.sources[0].url, 'https://fixture.example/bing')
  assert.equal(ctx.state.pages, 1)
  assert.equal(calls, 1)
})

test('an explicit other provider stays selected and NativeCrew reuses an existing auto owner', () => {
  const ctx = context()
  ctx.state.selection = 'custom'
  managed(ctx)
  const first = ctx.registry.get('auto')
  assert.equal(first.available(), false)
  ctx.state.selection = 'auto'
  assert.equal(first.available(), true)
  managed(ctx)
  assert.equal(ctx.registry.get('auto'), first)
  const prior = context()
  const existing = { id: 'auto' }
  prior.web.registerSearchProvider(existing)
  managed(prior)
  assert.equal(prior.registry.get('auto'), existing)
})

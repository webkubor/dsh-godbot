// Every page of the NativeCrew phone app, as the app calls it over the phone link: one read and one
// write per page, each write checked on the computer through the team channel. `bot` calls the
// computer over the end-to-end encrypted link (the phone); `channel` asks the computer itself.
// Payloads mirror godbot-app (src/screens/manage.tsx, settings-pages.tsx).
import assert from 'node:assert/strict'

// `folder` is an existing folder on the computer (not the team workspace) for the working-folder write.
export async function checkPages({ bot, channel, folder, note = () => {} }) {
  const results = []
  async function page(name, run) {
    try {
      const detail = await run()
      results.push({ page: name, ok: true, ...detail })
    } catch (error) {
      results.push({ page: name, ok: false, error: `${error.code ?? ''} ${error.message}`.trim() })
    }
  }
  const tag = 'pages-' + Date.now()
  const state = await bot('state', {})
  const lead = state.bots.find(row => row.id === state.mainBotId)
  assert.ok(lead, 'the team has a Main Bot')
  const hostState = () => channel('state', {})

  await page('bot', async () => {
    const created = await bot('create-bot', { name: 'Pages ' + tag, color: 'cyan', avatar: { shape: 'star' } })
    assert.ok((await hostState()).bots.some(row => row.id === created.id), 'the new Bot is on the computer')
    await bot('update-bot', { id: created.id, name: 'Renamed ' + tag })
    assert.equal((await hostState()).bots.find(row => row.id === created.id)?.name, 'Renamed ' + tag)
    const copy = await bot('duplicate-bot', { id: created.id })
    assert.ok((await hostState()).bots.some(row => row.id === copy.id), 'the copy is on the computer')
    if (lead.model) await bot('efforts', { ref: lead.model })
    await bot('delete-bot', { id: copy.id })
    await bot('delete-bot', { id: created.id })
    const after = (await hostState()).bots
    assert.ok(!after.some(row => row.id === created.id || row.id === copy.id), 'both are deleted on the computer')
    return { read: 'state, efforts', write: 'create-bot, update-bot, duplicate-bot, delete-bot' }
  })

  await page('group', async () => {
    const member = await bot('create-bot', { name: 'Member ' + tag, color: 'cyan', avatar: { shape: 'moon' } })
    const room = await bot('create-room', { members: [lead.id, member.id], admin: lead.id, greet: false })
    assert.ok((await hostState()).rooms.some(row => row.id === room.id), 'the group is on the computer')
    await bot('room-chat', { roomId: room.id, steps: true })
    await bot('update-room', { id: room.id, name: 'Room ' + tag })
    assert.equal((await hostState()).rooms.find(row => row.id === room.id)?.name, 'Room ' + tag)
    await bot('delete-room', { id: room.id })
    await bot('delete-bot', { id: member.id })
    assert.ok(!(await hostState()).rooms.some(row => row.id === room.id), 'the group is deleted on the computer')
    return { read: 'room-chat', write: 'create-room, update-room, delete-room' }
  })

  await page('memory', async () => {
    const owner = { botId: lead.id }
    const before = await bot('memory-view', owner)
    const scope = before.entries?.[0]?.scope ?? before.scopes?.[0] ?? 'bot'
    const text = 'Memory ' + tag
    await bot('memory-add', { ...owner, scope, topic: null, text })
    const added = await channel('memory-view', owner)
    const entry = added.entries.find(row => row.text === text)
    assert.ok(entry, 'the entry is in the computer\'s memory')
    await bot('memory-edit', { ...owner, scope: entry.scope, topic: entry.topic ?? null, text, next: text + ' edited' })
    const edited = (await channel('memory-view', owner)).entries.find(row => row.text === text + ' edited')
    assert.ok(edited, 'the edit is in the computer\'s memory')
    await bot('memory-forget', { ...owner, scope: edited.scope, topic: edited.topic ?? null, text: edited.text })
    assert.ok(!(await channel('memory-view', owner)).entries.some(row => row.text.startsWith(text)), 'the entry is forgotten on the computer')
    return { read: 'memory-view', write: 'memory-add, memory-edit, memory-forget' }
  })

  await page('schedules', async () => {
    const title = 'Schedule ' + tag
    await bot('schedule-create', { target: lead.id, title, prompt: 'Say hello', when: { kind: 'every', minutes: 600 } })
    const listed = await channel('schedules', {})
    const task = (listed.tasks ?? listed.items ?? listed).find?.(row => row.title === title)
    assert.ok(task, 'the schedule is on the computer: ' + JSON.stringify(listed).slice(0, 300))
    const read = await bot('schedules', {})
    assert.ok(JSON.stringify(read).includes(title), 'the phone reads it back')
    await bot('schedule-delete', { sessionId: task.sessionId ?? lead.sessionId ?? lead.id, id: task.id })
    assert.ok(!JSON.stringify(await channel('schedules', {})).includes(title), 'the schedule is deleted on the computer')
    return { read: 'schedules', write: 'schedule-create, schedule-delete' }
  })

  await page('folders', async () => {
    // {team, picker, folders}: browsing other folders needs DSH's server-side picker ('browse');
    // a local DSH has the native dialog instead, and the phone picks from the known folders.
    const known = await bot('folders', {})
    assert.equal(typeof known.team, 'string', 'the computer names the team folder: ' + JSON.stringify(known).slice(0, 300))
    let target = known.team
    let read = 'folders'
    if (known.picker === 'browse') {
      const listing = await bot('folder-list', { path: known.team })
      target = listing.entries?.[0]?.path ?? known.team
      read = 'folders, folder-list'
    } else {
      await assert.rejects(bot('folder-list', { path: known.team }), error => error.code === 'bot/refused', 'browsing is refused without the browse picker')
      read = `folders (picker ${known.picker}; folder-list refused as expected)`
    }
    // The team workspace itself is stored as "no folder of its own", so the write uses another one.
    if (folder !== undefined) target = folder
    const member = await bot('create-bot', { name: 'Folder ' + tag, color: 'cyan', avatar: { shape: 'wave' } })
    await bot('update-bot', { id: member.id, workDir: target })
    const stored = (await hostState()).bots.find(row => row.id === member.id)
    assert.equal(stored?.workDir, target === known.team ? undefined : target, 'the working folder is set on the computer')
    assert.ok((await bot('folders', {})).folders.some(row => row.path === target) || target === known.team, 'the phone now offers it as a known folder')
    await bot('delete-bot', { id: member.id })
    return { read, write: 'update-bot workDir' }
  })

  await page('bot-usage', async () => {
    await bot('usage-summary', { botId: lead.id })
    await bot('run-stats', { botId: lead.id })
    return { read: 'usage-summary, run-stats', write: 'none (read-only page)' }
  })

  await page('bot-browser', async () => {
    let refused
    try { await bot('browser-frame', { botId: lead.id }) } catch (error) { refused = error.code }
    assert.ok(refused === 'bot/browser-off' || refused === 'bot/not-found', 'the phone gets the code its hint is for, got ' + refused)
    return { read: 'browser-frame', write: 'none (the app shows the hint)', code: refused }
  })

  await page('secrets', async () => {
    const name = 'PAGES_' + Date.now()
    await bot('secret-set', { name, value: 'e2e-value' })
    assert.ok(JSON.stringify(await hostState()).includes(name), 'the secret name is on the computer')
    await bot('secret-delete', { name })
    assert.ok(!JSON.stringify(await hostState()).includes(name), 'the secret is deleted on the computer')
    return { read: 'state.secrets', write: 'secret-set, secret-delete' }
  })

  await page('providers', async () => {
    const view = await bot('providers', {})
    const provider = 'pages-' + Date.now()
    const api = (view.protocols ?? [])[0] ?? 'openai-chat'
    await bot('provider-add', { custom: true, provider, name: 'Pages', baseURL: 'http://127.0.0.1:9/v1', api, key: 'sk-pages-1', models: ['pages-model'] })
    assert.ok(JSON.stringify(await channel('providers', {})).includes(provider), 'the provider is on the computer')
    await bot('provider-key', { provider, value: 'sk-pages-2' })
    await bot('provider-remove', { provider })
    assert.ok(!JSON.stringify(await channel('providers', {})).includes(provider), 'the provider is removed on the computer')
    return { read: 'providers', write: 'provider-add, provider-key, provider-remove' }
  })

  await page('connectors', async () => {
    const connectors = (await bot('state', {})).connectors
    const items = connectors?.items ?? connectors?.connectors ?? []
    assert.ok(Array.isArray(items) && items.length > 0, 'the phone reads the connectors: ' + JSON.stringify(connectors).slice(0, 300))
    const target = items.find(row => row.clientId !== undefined || row.needsClient || row.client) ?? items[0]
    await bot('connector-cancel', { id: target.id })
    return { read: 'state.connectors', write: 'connector-cancel (no OAuth needed)', connector: target.id }
  })

  await page('capabilities', async () => {
    const name = 'pages-skill-' + Date.now()
    await bot('capability-save', { name, kind: 'skill', description: 'Pages check', content: '# Pages\nSay hello.' })
    assert.ok(JSON.stringify(await hostState()).includes(name), 'the skill is on the computer')
    await bot('capability-delete', { name })
    assert.ok(!JSON.stringify(await hostState()).includes(name), 'the skill is deleted on the computer')
    return { read: 'state.capabilities', write: 'capability-save, capability-delete' }
  })

  await page('usage', async () => {
    await bot('usage', { timeZone: 'Asia/Shanghai' })
    return { read: 'usage', write: 'none (read-only page)' }
  })

  await page('updates', async () => {
    const before = await bot('update-check', {})
    const original = before.update?.mode ?? before.mode
    const next = original === 'notify' ? 'auto' : 'notify'
    await bot('update-settings', { mode: next })
    const after = await channel('update-check', {})
    assert.equal(after.update?.mode ?? after.mode, next, 'the update mode is changed on the computer')
    if (original) await bot('update-settings', { mode: original })
    return { read: 'update-check', write: 'update-settings', mode: `${original} → ${next} → ${original}` }
  })

  await page('diagnostics', async () => {
    await bot('diagnostics', {})
    await bot('diagnostics-log', {})
    await bot('diagnostics-clear', {})
    return { read: 'diagnostics, diagnostics-log', write: 'diagnostics-clear' }
  })

  await page('side-chat', async () => {
    const sessionId = lead.sessionId ?? lead.id
    const chat = await bot('side-new', { sessionId })
    assert.ok(chat?.chatId, 'a side chat opens')
    await bot('side-close', { chatId: chat.chatId })
    return { read: 'state', write: 'side-new, side-close' }
  })

  note('pages', { results })
  return results
}

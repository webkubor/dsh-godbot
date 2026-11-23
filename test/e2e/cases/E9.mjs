import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import { PNG } from 'pngjs'
import { openFullTeam, verifyModalTheme } from '../native-ui.mjs'
import { until } from '../host.mjs'

async function checkInboxDialog(host, note) {
  const { page } = host
  const navigation = page.getByRole('navigation', { name: 'NativeCrew 工作区' })
  const opener = navigation.getByRole('button', { name: '工作台收件箱', exact: true })
  const dialog = page.getByRole('dialog', { name: '工作台收件箱', exact: true })
  const close = dialog.getByRole('button', { name: '关闭', exact: true })

  await page.emulateMedia({ colorScheme: 'light' })
  await host.bot('set-prefs', { theme: 'paper' })
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--bt-ink').trim() === '#1f1e1b')
  await opener.click()
  await dialog.waitFor()
  assert.ok(await close.evaluate(button => button === document.activeElement), 'the inbox moves focus into the modal')
  const botLight = await verifyModalTheme(dialog)
  assert.equal(botLight.scheme, 'light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
  const botDark = await verifyModalTheme(dialog)
  assert.equal(botDark.scheme, 'dark')
  assert.notEqual(botDark.surface, botLight.surface)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.ok(await opener.evaluate(button => button === document.activeElement), 'Escape restores focus to the Bot inbox opener')

  await opener.click()
  await close.click()
  await dialog.waitFor({ state: 'hidden' })
  assert.ok(await opener.evaluate(button => button === document.activeElement), 'Close restores focus to the Bot inbox opener')

  note('inbox-modal-theme-and-focus', { botLight, botDark })
}

export default async function E9({ makeHost, candidate, note }) {
  const host = await makeHost()
  host.model.models = ['deepseek-flash', 'deepseek-v4-pro']
  await host.install(candidate)
  await host.start()
  await openFullTeam(host)
  await checkInboxDialog(host, note)
  const call = (action, fields = {}) => host.rpc('godbot/dispatch', { request: { action, ...fields } })
  const inbox = () => call('team-workspace.inbox')
  const model = 'deepseek-official/deepseek-flash'
  const lead = await host.bot('create-bot', { name: 'Director', role: 'Triage', model })
  const worker = await host.bot('create-bot', { name: 'Publisher', role: 'Publish release notes', model })
  const questions = [
    { bot: lead, text: 'director-card-' + randomUUID(), answer: 'Ship now' },
    { bot: worker, text: 'publisher-card-' + randomUUID(), answer: 'Wait' },
  ]
  const asked = new Set()
  host.model.reply = body => {
    const messages = JSON.stringify(body.messages)
    const question = questions.find(({ text }) => !asked.has(text) && messages.includes(text))
    if (question && body.tools?.some(tool => tool.name === 'ask_user')) {
      asked.add(question.text)
      return [{ type: 'tool_use', name: 'ask_user', input: {
        question: question.text, options: [{ label: 'Ship now' }, { label: 'Wait' }],
      } }]
    }
    return 'Fixture received the answer'
  }
  for (const { bot, text } of questions) await host.bot('send', { sessionId: bot.id, text })
  const [directorCard, publisherCard] = await until(async () => {
    const { rows } = await inbox()
    const cards = questions.map(({ text }) => rows.find(row => row.source === 'bot-question' && row.text === text))
    if (cards.every(Boolean)) return cards
  }, 'two pending questions from separate Bot chats')
  assert.equal(directorCard.label, lead.name)
  assert.equal(publisherCard.label, worker.name)
  assert.notEqual(directorCard.sessionId, publisherCard.sessionId)

  await host.page.getByRole('button', { name: '工作台收件箱' }).click()
  const dialog = host.page.getByRole('dialog', { name: '工作台收件箱' })
  const first = dialog.getByRole('article').filter({ hasText: directorCard.text })
  const second = dialog.getByRole('article').filter({ hasText: publisherCard.text })
  await second.getByText(worker.name, { exact: true }).waitFor()
  await first.getByRole('radio', { name: questions[0].answer, exact: true }).check()
  await first.getByRole('button', { name: '提交回答', exact: true }).click()
  await first.waitFor({ state: 'hidden' })
  const remaining = (await inbox()).rows.filter(row => row.source === 'bot-question')
  assert.deepEqual(remaining.map(row => row.id), [publisherCard.id])

  const { source, sessionId, id } = publisherCard
  const answer = { source, sessionId, id, decision: 'answer', answer: { answer: [questions[1].answer] } }
  const results = await Promise.allSettled([call('team-workspace.answer', answer), call('team-workspace.answer', answer)])
  const accepted = results.filter(result => result.status === 'fulfilled').length
  assert.equal(accepted, 1, 'only one answer can claim an open question')
  assert.match(results.find(result => result.status === 'rejected').reason.message, /已结束|no longer open/u)
  await dialog.getByText('当前没有待处理的审批或提问。', { exact: true }).waitFor()
  for (const [index, card] of [directorCard, publisherCard].entries()) {
    await until(() => host.model.calls.some(call => call.sessionId === card.sessionId &&
      call.body.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => {
        if (!part.text?.includes('answer_to_pending_question')) return false
        try {
          const receipt = JSON.parse(part.text)
          return receipt.questions?.[0]?.id === card.id && receipt.answers?.[0]?.selected?.[0] === questions[index].answer
        } catch { return false }
      }))), 'the model received the selected answer in ' + card.label + '\'s original chat')
  }

  const teamDefault = 'deepseek-official/deepseek-v4-pro'
  const { models } = await host.bot('state')
  assert.deepEqual(models.find(row => row.ref === teamDefault)?.input, ['text'])
  assert.ok(models.every(row => row.provider !== 'godbot-group-relay'))
  await host.bot('set-prefs', { defaultBotModel: teamDefault })
  const room = await host.bot('create-room', { name: 'E9 editorial', members: [lead.id, worker.id], admin: lead.id })
  assert.equal(room.mode, 'admin')
  assert.equal(room.admin, lead.id)

  const imagePrompt = 'room-image-' + randomUUID()
  const imageReply = 'The group member received the image'
  const png = new PNG({ width: 24, height: 16 })
  png.data.fill(255)
  png.data.set([0, 155, 90, 255])
  host.model.reply = body => {
    const blocks = body.messages.flatMap(message => message.content)
    return blocks.some(block => block?.type === 'text' && block.text.includes(imagePrompt))
      && blocks.some(block => block?.type === 'image') ? imageReply : 'acknowledged'
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await host.page.locator(`[data-room-id="${room.id}"]`).click()
  const composer = host.page.locator('[data-composer-card]')
  const input = composer.locator('[role="textbox"]')
  await input.fill('@Publisher ' + imagePrompt)
  await input.evaluate((element, data) => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'room.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, PNG.sync.write(png).toString('base64'))
  await composer.locator('img').first().waitFor()
  await composer.getByRole('button', { name: /^(发送消息|Send message)$/u }).click()
  const imageRow = await until(async () => {
    const { rows } = await host.bot('group-rows', { roomId: room.id, from: 0, to: 2_000_000_000 })
    return rows.find(row => row.text === imageReply)
  }, 'image delivered to a vision-capable group member with a text-only team default')
  assert.equal(imageRow.botId, worker.id)
  note('room-image', { roomId: room.id, responder: worker.id, teamDefault })

  await host.page.getByRole('button', { name: '工作台收件箱' }).click()
  await dialog.getByText('群聊自动分派', { exact: true }).click()
  await dialog.getByRole('checkbox', { name: room.name }).click()
  await until(async () => (await inbox()).rooms.find(r => r.id === room.id)?.enabled, 'room routing enabled from owner UI')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  const outcomes = []
  for (const [mode, chosen] of [['explicit', worker], ['automatic', worker], ['low', lead], ['timeout', lead]]) {
    const marker = 'decision-' + randomUUID().slice(0, 8)
    const reply = 'done-' + randomUUID().slice(0, 8)
    let choices = 0
    host.model.reply = async body => {
      if (JSON.stringify(body.system).includes('NativeCrew room routing.')) {
        choices++
        if (mode === 'timeout') await wait(2300)
        return JSON.stringify({ id: worker.id, confidence: mode === 'low' ? 0.23 : 0.99 })
      }
      return JSON.stringify(body.messages).includes(marker) ? reply : 'acknowledged'
    }
    const text = (mode === 'explicit' ? '@Publisher ' : '') + marker + ' publish the report'
    await host.bot('send', { sessionId: room.id, text })
    const rows = await until(async () => {
      const state = await host.bot('group-rows', { roomId: room.id, from: 0, to: 2_000_000_000 })
      const received = state.rows.filter(r => r.text === reply)
      if (!received.length) return
      const live = await host.bot('state')
      if (!(live.work.rooms?.[room.id]?.length)) return received
    }, 'completed group route ' + mode)
    assert.equal(rows.length, 1, 'only one member should have answered for ' + mode)
    assert.equal(rows[0].botId, chosen.id, mode)
    assert.equal(choices, mode === 'explicit' ? 0 : 1, 'classification calls for ' + mode)
    outcomes.push({ mode, responder: chosen.id, message: marker, choices })
  }
  note('owner-inbox-and-room-routing', { questionIds: [directorCard.id, publisherCard.id], answered: questions.length,
    concurrentAnswersAccepted: accepted, roomId: room.id, outcomes })
}

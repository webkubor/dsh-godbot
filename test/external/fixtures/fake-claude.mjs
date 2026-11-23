// Modified for NativeCrew to handle native metadata controls. See THIRD_PARTY_NOTICES.
// A fake Claude Code for tests: stream-json both ways. Prints the init system
// line, then answers each user message with thinking + text + result events.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const sessionId = process.argv.includes('--resume') ? process.argv[process.argv.indexOf('--resume') + 1] : randomUUID()
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

send({ type: 'system', subtype: 'init', session_id: sessionId })

let activeModel=process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model')+1] : 'sonnet'
let effortOverlay=null
let previousTeamTurn
let cleared=false
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  rest += chunk
  let at
  while ((at = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, at).trim()
    rest = rest.slice(at + 1)
    if (line === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if(message.type==='control_request' && ['initialize','set_model','apply_flag_settings','get_settings'].includes(message.request.subtype)){
      const req=message.request
      let response={}
      if(req.subtype==='initialize') response={
        models:[{value:'sonnet',displayName:'Sonnet',supportsEffort:true,supportedEffortLevels:['low','high','max']},{value:'unreasoned',displayName:'Basic',supportsEffort:false}],
        commands:[{name:'inspect',description:'Inspect workspace'}],current_permission_mode:'default',account:{privateValue:'must-not-escape'},
      }
      if(req.subtype==='set_model') {activeModel=req.model ?? 'sonnet';response={model:activeModel}}
      if(req.subtype==='apply_flag_settings') {effortOverlay=req.settings.effortLevel;cleared=effortOverlay===null}
      if(req.subtype==='get_settings') response={applied:{model:activeModel,effort:activeModel==='unreasoned'?null:effortOverlay ?? (cleared?'medium':'high'),ultracodeRequested:false},effective:{effortLevel:effortOverlay ?? 'high'},sources:[{privateValue:'must-not-escape'}]}
      send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response}})
      continue
    }
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'interrupted', usage: { input_tokens: 1, output_tokens: 1 } })
      continue
    }
    if (message.type === 'control_response') {
      const res = message.response?.response
      const textOut = `perm:${JSON.stringify(res)}`
      send({ type: 'assistant', message: { content: [{ type: 'text', text: textOut }] } })
      send({ type: 'result', subtype: 'success', session_id: sessionId, result: textOut, usage: { input_tokens: 10, output_tokens: 5 } })
      continue
    }
    if (message.type !== 'user') continue
    const blocks = message.message?.content ?? []
    if (!Array.isArray(blocks) || blocks.length === 0) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'empty user message content' })
      continue
    }
    if (blocks.length > 1 && blocks.some(block => block.type === 'text' && block.text === '')) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'text content blocks must be non-empty' })
      continue
    }
    const badImage = blocks.find(block => block.type === 'image' && (block.source?.type !== 'base64' || typeof block.source?.media_type !== 'string' || typeof block.source?.data !== 'string' || block.source.data.startsWith('data:')))
    if (badImage !== undefined) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, result: 'invalid anthropic image block' })
      continue
    }
    const images = blocks.filter(block => block.type === 'image').map(block => ({ mediaType: block.source.media_type, data: block.source.data }))
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    if (text.includes('raw-shell-receipts')) {
      const id = 'raw-bash-receipt'
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'fixture shell command' } }] } })
      send({ type: 'user', tool_use_result: { stdout: 'fixture standard output', stderr: 'fixture standard error', exitCode: 9 },
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'fixture shell report' }] } })
      send({ type: 'result', subtype: 'success', session_id: sessionId, result: 'receipt complete' })
      continue
    }
    const trace = /GODBOT-CLAUDE-EXECUTION-TRACE ([a-z0-9-]+)/i.exec(text)
    if (trace) {
      const run = async () => {
        const dir = process.env.GODBOT_E2E_GATE_DIR
        if (dir && !process.env.CLAUDE_CODE_CHILD_SESSION) {
          const cwd = process.cwd()
          const folder = join(homedir(), '.claude', 'projects', cwd.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-'))
          const historical = [
            ['user', [{ type: 'text', text: 'Native terminal task from the earlier session' }]],
            ['assistant', [{ type: 'tool_use', id: 'only-in-transcript', name: 'Bash', input: { command: 'printf earlier-fixture' } }]],
            ['user', [{ type: 'tool_result', tool_use_id: 'only-in-transcript', content: 'The historical native command ran.' }]],
            ['assistant', [{ type: 'text', text: 'Historical Claude report from native conversation.' }]],
          ].map(([type, content], index) => ({
            uuid: randomUUID(), cwd, sessionId, type, timestamp: new Date(1700000000000 + index * 1000).toISOString(),
            message: { role: type, content, ...(index === 3 ? { stop_reason: 'end_turn' } : {}) },
          }))
          await mkdir(folder, { recursive: true })
          await writeFile(join(folder, sessionId + '.jsonl'), historical.map(row => JSON.stringify(row)).join('\n') + '\n')
        }
        // Two calls can arrive in the same message and finish out of order.
        const readId = randomUUID(), grepId = randomUUID()
        const bashId = randomUUID()
        const read = { type: 'tool_use', id: readId, name: 'Read', input: { file_path: 'fixture-trace.txt' } }
        const grep = { type: 'tool_use', id: grepId, name: 'Grep', input: { path: 'fixture-trace.txt', pattern: 'test' } }
        const progress = { type: 'text', text: 'Claude fixture progress before the report.' }
        const middle = { type: 'text', text: 'Claude fixture progress after both tool starts.' }
        if (dir) {
          const id = 'native-progress'
          const partial = event => send({ type: 'stream_event', event })
          partial({ type: 'message_start', message: { id } })
          partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: progress.text } })
          partial({ type: 'content_block_start', index: 1, content_block: { ...read, input: {} } })
          while (!existsSync(join(dir, 'claude-execution-trace-start'))) await delay(60)
          partial({ type: 'content_block_start', index: 2, content_block: { ...grep, input: {} } })
          partial({ type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: middle.text } })
          send({ type: 'assistant', message: { id, content: [progress, read, grep, middle] } })
        }
        if (!dir) send({ type: 'assistant', message: { content: [read, grep] } })
        send({ type: 'user', message: { content: [
          { type: 'tool_result', tool_use_id: grepId, is_error: true, content: 'Claude fixture grep error' },
          { type: 'tool_result', tool_use_id: readId, content: dir ? 'Claude fixture file content' : 'RAW_TRACE_OUTPUT' },
        ] } })
        if (dir) send({ type: 'assistant', message: { content: [
          { type: 'tool_use', id: bashId, name: 'Bash', input: { command: 'node --version', description: 'Read fixture version' } },
        ] } })
        while (dir && !existsSync(join(dir, 'claude-execution-trace-continue'))) await delay(60)
        const finishBash = id => send({ type: 'user', message: { content: [
          { type: 'tool_result', tool_use_id: id, content: 'Checked fixture routing.' },
        ] } })
        let lateId
        if (dir) {
          // Claude sends a separate assistant frame for each tool-use block.
          // Let a long run keep adding calls before and after a later text block.
          for (let i = 1; i <= 72; i++) {
            const id = randomUUID()
            send({ type: 'assistant', message: { id: 'routing-' + i, content: [
              { type: 'tool_use', id, name: 'Bash', input: { command: 'printf route', description: 'Check fixture route ' + i } },
            ] } })
            finishBash(id)
          }
          const id = 'native-rewire'
          const text = 'Now rewire the fixture routing.'
          send({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
          send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
          send({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
          for (const [index, description] of ['Read the new fixture route', 'Verify the new fixture route'].entries()) {
            lateId = randomUUID()
            const call = { type: 'tool_use', id: lateId, name: 'Bash' }
            send({ type: 'stream_event', event: { type: 'content_block_start', index: index + 1, content_block: { ...call, input: {} } } })
            send({ type: 'assistant', message: { id, content: [
              { ...call, input: { command: 'printf new-route', description } },
            ] } })
            if (index === 0) finishBash(lateId)
          }
        }
        while (dir && !existsSync(join(dir, 'claude-execution-trace-release'))) await delay(60)
        if (dir) {
          finishBash(lateId)
          send({ type: 'user', tool_use_result: { stdout: 'Claude fixture standard output', stderr: 'Claude fixture standard error', exitCode: 7 },
            message: { content: [{ type: 'tool_result', tool_use_id: bashId, is_error: false, content: 'Claude fixture command failed' }] } })
        }
        const reply = 'TRACE_COMPLETE ' + trace[1] + '\n\n## Fixture verification report\n\nTool results and final checks are included.'
        send({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
        send({ type: 'result', subtype: 'success', session_id: sessionId, result: reply })
      }
      void run()
      continue
    }
    if (text.includes('GODBOT-MEMBER-MCP ')) {
      const turnContext = text.match(/turnContext=(gbturn_[a-f0-9]{48})/)?.[1]
      const phase = text.match(/GODBOT-MEMBER-MCP (first|second)/)?.[1]
      const previous = previousTeamTurn
      previousTeamTurn = turnContext
      const bridge = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.godbot
      void import('../../e2e/fixtures/ticket-client.mjs').then(async ({rpc}) => {
        const call = (context, message) => rpc(bridge,'tools/call',{ name:'send_message',
          arguments:{ to:'user',text:message,turnContext:context,requestId:'fixture-'+message } })
        const catalog = await rpc(bridge,'tools/list',{})
        if (!catalog.tools.find(row=>row.name==='send_message').inputSchema.required.includes('turnContext'))
          throw new Error('Missing advertised turn context')
        if (previous && !(await call(previous,'stale')).isError) throw new Error('Accepted stale turn')
        if (!(await call(undefined,'unbound')).isError) throw new Error('Accepted unbound write')
        const current = await call(turnContext,phase)
        if (current.isError) throw new Error(current.content[0].text)
        // An exact retry in the same turn receives the original business receipt.
        if ((await call(turnContext,phase)).content[0].text!==current.content[0].text) throw new Error('Duplicate delivery')
        return 'TEAM SENT '+phase
      }).catch(err=>'TEAM ERROR '+err.message).then(reply=>{
        send({type:'assistant',message:{content:[{type:'text',text:reply}]}})
        send({type:'result',subtype:'success',session_id:sessionId,result:reply})
      })
      continue
    }
    if (process.env.GODBOT_E2E_GATE_DIR && text.includes('GODBOT-TICKET ')) {
      const bridge = JSON.parse(process.argv[process.argv.indexOf('--mcp-config') + 1]).mcpServers.godbot
      void import('../../e2e/fixtures/ticket-client.mjs').then(helper => helper.exerciseTicket(bridge, text))
        .catch(err => 'FIXTURE_ERROR ' + err.message).then(reply => {
          send({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
          send({ type: 'result', subtype: 'success', session_id: sessionId, result: reply, usage: { input_tokens: 5, output_tokens: 1 } })
        })
      continue
    }
    if (text.includes('ask-claude-perm')) {
      send({ type: 'control_request', request_id: 'cr-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/test' } } })
      continue
    }
    const suffix = images.length > 0 ? ` images=${JSON.stringify(images)}` : ''
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: `thought about: ${text.slice(0, 40)}` }, { type: 'tool_use', name: 'Read' }, { type: 'text', text: `ok: ${text.slice(0, 60)}${suffix}` }] } })
    send({ type: 'result', subtype: 'success', session_id: sessionId, result: `ok: ${text.slice(0, 60)}${suffix}`, usage: { input_tokens: 10, output_tokens: 5 } })
  }
})

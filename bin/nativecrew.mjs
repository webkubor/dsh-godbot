#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'

const help = `nativecrew run --title TEXT --criteria TEXT [--bot NAME_OR_ID] [--request-id ID] [--wait]
nativecrew run --workflow WORKFLOW_ID --revision N [--request-id ID] [--wait]
nativecrew wait RUN_ID [--timeout SECONDS]
nativecrew inspect RUN_ID
nativecrew export RUN_ID [--output FILE]
nativecrew mcp
nativecrew sandbox list
nativecrew sandbox login ACCOUNT_ID antigravity|claude|codex
nativecrew workspace backup|restore|recover|rollback --home PATH [--file ARCHIVE --password-file FILE --map FROM=TO]

Use GODBOT_URL and GODBOT_TOKEN_FILE (or GODBOT_TOKEN) from the team's CI access settings.
Commands print JSON. Exit codes: 0 success, 1 failed/stopped, 2 request error,
3 needs input, 4 wait timed out, 5 result unknown. Waiting never cancels the task.`
const string = { type: 'string' }
const codes = { failed: 1, stopped: 1, needs_input: 3, timeout: 4, unknown: 5 }
const definitions = {
  run: {
    description: 'Assign a task to a Bot in the authorized workspace. Reuse the same requestId when retrying.',
    properties: {
      title: string,
      criteria: string,
      ownerId: string,
      requestId: string,
    },
    required: ['title', 'criteria', 'requestId'],
  },
  run_workflow: {
    description: 'Run a saved Bot workspace workflow at its selected revision. Reuse the requestId on retries.',
    properties: { workflowId: string, revision: { type: 'integer', minimum: 1 }, requestId: string },
    required: ['workflowId', 'revision', 'requestId'],
  },
  wait: {
    description:
      'Wait for a run and its delegated tasks, or return when input, reconciliation or a timeout is reached.',
    properties: { runId: string, timeout: { type: 'number', minimum: 0 } },
    required: ['runId'],
  },
  inspect: {
    description: 'Read the tasks, revisions and pending interactions for a run.',
    properties: { runId: string },
    required: ['runId'],
  },
  export: {
    description: 'Export the evidence and review receipts of one run.',
    properties: { runId: string },
    required: ['runId'],
  },
}

async function request(path, body, timeout = 15000) {
  const base = new URL((process.env.NATIVECREW_URL ?? process.env.GODBOT_URL) || '')
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/' ||
    !(
      base.protocol === 'https:' ||
      (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
    )
  )
    throw new Error('Use an HTTPS service URL or a loopback HTTP address')
  const token = (process.env.NATIVECREW_TOKEN_FILE ?? process.env.GODBOT_TOKEN_FILE)
    ? (await readFile((process.env.NATIVECREW_TOKEN_FILE ?? process.env.GODBOT_TOKEN_FILE), 'utf8')).trim()
    : (process.env.NATIVECREW_TOKEN ?? process.env.GODBOT_TOKEN)
  if (!token) throw new Error('Set GODBOT_TOKEN_FILE or GODBOT_TOKEN')
  const response = await fetch(new URL(path, base), {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
  })
  const data = await response.json()
  if (!response.ok)
    throw Object.assign(new Error(data.error || 'Host request failed: ' + response.status), {
      status: response.status,
    })
  return data
}

async function execute(name, args) {
  if (name === 'run_workflow') {
    if (typeof args.workflowId !== 'string' || !args.workflowId.trim() || !Number.isSafeInteger(args.revision) || args.revision < 1)
      throw new Error('A workflow ID and a positive integer revision are required')
    return request('/runs', args)
  }
  if (name === 'run') {
    if (Object.hasOwn(args, 'workflowId') || Object.hasOwn(args, 'revision')) throw new Error('Use run_workflow for a saved workflow')
    return request('/runs', args)
  }
  if (!Object.hasOwn(definitions, name) || !/^[a-f0-9-]{36}$/.test(args.runId || ''))
    throw new Error('Choose a command and a valid run ID')
  const resource = '/runs/' + args.runId
  if (name !== 'wait') return request(resource + (name === 'export' ? '/export' : ''))
  const seconds = Number(args.timeout ?? 300)
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400)
    throw new Error('Timeout must be between 0 and 86400 seconds')
  const deadline = Date.now() + seconds * 1000
  let view = { runId: args.runId }
  for (;;) {
    const remainingBeforeRead = deadline - Date.now()
    const timeout = seconds === 0 ? 15000 : Math.min(15000, Math.max(1, remainingBeforeRead))
    try {
      view = await request(resource, undefined, timeout)
      if (view.state !== 'running') return view
    } catch (error) {
      const transient =
        ['TimeoutError', 'AbortError'].includes(error.name) ||
        (error instanceof TypeError && error.cause != null) ||
        [502, 503, 504].includes(error.status)
      if (!transient) throw error
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      return { ...view, state: 'timeout', reason: 'Wait timed out. Resume using this run ID.' }
    await sleep(Math.min(remaining, 300))
  }
}

async function serveMcp() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const respond = (value) => process.stdout.write(JSON.stringify(value) + '\n')
  const handle = async (line) => {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } })
    }
    if (msg == null || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return respond({
        jsonrpc: '2.0',
        id: msg?.id ?? null,
        error: { code: -32600, message: 'Invalid request' },
      })
    if (msg.id == null) return
    const message = { jsonrpc: '2.0', id: msg.id }
    try {
      if (msg.method === 'initialize')
        message.result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'nativecrew', version: '1' },
        }
      else if (msg.method === 'ping') message.result = {}
      else if (msg.method === 'tools/list')
        message.result = {
          tools: Object.entries(definitions).map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: {
              type: 'object',
              properties: def.properties,
              required: def.required,
              additionalProperties: false,
            },
          })),
        }
      else if (msg.method === 'tools/call') {
        const name = msg.params?.name
        const args = msg.params?.arguments ?? {}
        if (!Object.hasOwn(definitions, name)) throw new Error('Unknown tool')
        const result = await execute(name, args)
        message.result = { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } else message.error = { code: -32601, message: 'Unknown method' }
    } catch (error) {
      message.result = { isError: true, content: [{ type: 'text', text: error.message }] }
    }
    respond(message)
  }
  const pending = new Set()
  for await (const line of lines) {
    const work = handle(line)
    pending.add(work)
    work.finally(() => pending.delete(work))
  }
  await Promise.all(pending)
}

async function main() {
  const [verb, ...args] = process.argv.slice(2)
  if (!verb || verb === '--help' || verb === 'help') {
    console.log(help)
    return
  }
  if (verb === 'sandbox') {
    if (args.length === 1 && args[0] === 'list') {
      const { listSandboxAccounts } = await import('../src/host/sandbox-accounts.js')
      console.log(JSON.stringify(listSandboxAccounts(), null, 2))
      return
    }
    if (args.length === 3 && args[0] === 'login') {
      const { loginSandboxAccount } = await import('../src/host/sandbox-login.mjs')
      return loginSandboxAccount(args[1], args[2])
    }
    throw new Error('Usage: nativecrew sandbox list | nativecrew sandbox login ACCOUNT_ID antigravity|claude|codex')
  }
  if (verb === 'workspace') {
    const { workspaceCommand } = await import('../src/host/workspace-archive.js')
    console.log(JSON.stringify(await workspaceCommand(args), null, 2))
    return
  }
  if (verb === 'mcp') return serveMcp()
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: string,
      criteria: string,
      bot: string,
      member: string,
      workflow: string,
      revision: string,
      'request-id': string,
      output: string,
      timeout: string,
      wait: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  })
  let result
  if (verb === 'run') {
    if (positionals.length) throw new Error('Unexpected positional argument to run')
    if (values.bot !== undefined && values.member !== undefined && values.bot !== values.member)
      throw new Error('--bot and --member must identify the same Bot')
    const ownerId = values.bot ?? values.member
    const workflow = values.workflow !== undefined || values.revision !== undefined
    if (workflow && (values.title !== undefined || values.criteria !== undefined || ownerId !== undefined))
      throw new Error('Choose a saved workflow or an individual task')
    if (!workflow && (!values.title || !values.criteria)) throw new Error('run requires --title and --criteria')
    const requestId = values['request-id'] ?? randomUUID()
    if (!values['request-id']) process.stderr.write('Request ID: ' + requestId + '\n')
    result = workflow
      ? await execute('run_workflow', { requestId, workflowId: values.workflow, revision: Number(values.revision) })
      : await execute('run', { requestId, title: values.title, criteria: values.criteria, ownerId })
    if (values.wait) {
      process.stderr.write('Run ID: ' + result.runId + '\n')
      result = await execute('wait', { runId: result.runId, timeout: values.timeout })
    }
  } else {
    if (!['inspect', 'wait', 'export'].includes(verb) || positionals.length !== 1 ||
        values.workflow !== undefined || values.revision !== undefined)
      throw new Error('Expected inspect, wait or export and one run ID')
    result = await execute(verb, { runId: positionals[0], timeout: values.timeout })
  }
  const json = JSON.stringify(result, null, 2) + '\n'
  if (verb === 'export' && values.output) await writeFile(values.output, json, { flag: 'wx', mode: 0o600 })
  process.stdout.write(json)
  if (verb === 'wait' || values.wait) process.exitCode = codes[result.state] ?? 0
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ error: error.message }) + '\n')
  process.exitCode = 2
})

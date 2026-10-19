#!/usr/bin/env node
// JSON-RPC app-server 替身：逐行处理握手、只读线程、回合、项目列表。
import fs from 'node:fs'
import readline from 'node:readline'
const mode = process.env.FAKE_MODE || 'ok'
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const THREAD_ID = '00000000-0000-4000-8000-000000000001'
const notify = (method, params) => emit({ method, params: { threadId: THREAD_ID, ...params } })
let thread
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (process.env.FAKE_REQUESTS_OUT) fs.appendFileSync(process.env.FAKE_REQUESTS_OUT, line + '\n')
  const reply = (result) => emit({ id, result })
  if (method === 'initialize') return reply({})
  if (method === 'initialized') return
  if (method === 'project/list') {
    if (mode === 'old-cli') return emit({ id, error: { code: -32601, message: 'Method not found' } })
    if (mode === 'old-cli-serde') return emit({ id, error: { code: -32600, message: 'Invalid request: unknown variant `project/list`' } })
    const project = { id: 'fake-project', name: 'Fake project', roots: [{ path: process.cwd() }] }
    const data = mode === 'no-project' ? [] : mode === 'ambiguous-project' ? [project, { ...project, id: 'another-project' }] : [project]
    if (mode === 'project-pages' && !params.cursor) return reply({ data: [], nextCursor: 'page-2' })
    return reply({ data, nextCursor: null })
  }
  if (method === 'thread/start') {
    if (params.projectId !== 'fake-project') throw Error('Missing canonical projectId')
    thread = { id: THREAD_ID, cwd: params.cwd, source: 'vscode', historyMode: 'paginated', ephemeral: false, projectId: mode === 'wrong-project' ? null : params.projectId }
    return reply({ thread, model: mode === 'wrong-model' ? 'other-model' : params.model, approvalPolicy: 'never',
      sandbox: { type: mode === 'unsafe' ? 'dangerFullAccess' : 'readOnly', networkAccess: false } })
  }
  if (method === 'thread/name/set') return reply({})
  if (method === 'thread/list') {
    if (params.projectId !== 'fake-project') throw Error('Missing project filter')
    return reply({ data: mode === 'missing-list' ? [] : [mode === 'wrong-list-project' ? { ...thread, projectId: 'other' } : thread], nextCursor: null })
  }
  if (method !== 'turn/start' && method !== 'review/start') throw Error('Unexpected method ' + method)
  const prompt = params.input?.[0]?.text || ''
  if (process.env.FAKE_PROMPT_OUT) fs.writeFileSync(process.env.FAKE_PROMPT_OUT, prompt, 'utf8')
  if (mode === 'rpc-error') return emit({ id, error: { code: -32000, message: 'fake RPC failure' } })
  if (mode === 'early-exit') return process.exit(0)
  reply({ turn: { id: 'turn-1', status: 'inProgress' } })
  if (mode === 'sleep') return setTimeout(() => process.exit(0), 30000)
  notify('error', { error: { message: 'Model metadata not found (benign)' } })
  // 其他线程的终态不得结束本轮。
  notify('turn/completed', { threadId: 'unrelated', turn: { status: 'failed', error: { message: 'wrong thread' } } })
  if (mode !== 'fail') {
    const item = method === 'review/start'
      ? { type: 'exitedReviewMode', review: 'FAKE_REVIEW' }
      : { type: 'agentMessage', text: `FAKE_ADVICE prompt_chars=${prompt.length}` }
    notify('item/completed', { item })
  }
  notify('thread/tokenUsage/updated', { tokenUsage: { total: {
    inputTokens: 1234, cachedInputTokens: 56, outputTokens: 78, reasoningOutputTokens: 9,
  } } })
  notify('turn/completed', { turn: { id: 'turn-1', status: ['fail', 'partial-fail'].includes(mode) ? 'failed' : 'completed',
    error: ['fail', 'partial-fail'].includes(mode) ? { message: 'fake failure' } : null } })
})

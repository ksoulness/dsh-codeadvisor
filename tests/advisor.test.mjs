import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveCodex, runAdvisor } from '../src/advisor.mjs'
import { collectContext } from '../src/context.mjs'
import { readRecords } from '../src/ledger.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FAKE = path.join(HERE, 'fake-codex.mjs')

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-'))
  return dir
}

/** 用假 codex 跑一轮；不改全局环境，跑完恢复。 */
async function withFake({ mode = 'ok', promptOut = null }, fn) {
  const saved = {
    bin: process.env.CODEX_ADVISOR_CODEX_BIN,
    prefix: process.env.CODEX_ADVISOR_CODEX_PREFIX,
    mode: process.env.FAKE_MODE,
    promptOut: process.env.FAKE_PROMPT_OUT,
  }
  process.env.CODEX_ADVISOR_CODEX_BIN = process.execPath
  process.env.CODEX_ADVISOR_CODEX_PREFIX = FAKE
  process.env.FAKE_MODE = mode
  if (promptOut) process.env.FAKE_PROMPT_OUT = promptOut
  try {
    return await fn()
  } finally {
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    restore('CODEX_ADVISOR_CODEX_BIN', saved.bin)
    restore('CODEX_ADVISOR_CODEX_PREFIX', saved.prefix)
    restore('FAKE_MODE', saved.mode)
    restore('FAKE_PROMPT_OUT', saved.promptOut)
  }
}

test('dry-run 组出的命令恒定只读，且解析模型预设', async () => {
  const home = makeHome()
  const result = await runAdvisor({
    kind: 'plan',
    task: '做个计划',
    workspace: ROOT,
    model: 'sol',
    dryRun: true,
    ledgerHome: home,
  })

  assert.equal(result.ok, true)
  assert.equal(result.model, 'gpt-6.1-sol')
  const cmd = result.command
  assert.equal(cmd.at(-1), 'app-server')
  assert.equal(result.requests.thread.sandbox, 'read-only')
  assert.equal(result.requests.thread.approvalPolicy, 'never')
  assert.equal(result.requests.thread.cwd, ROOT)
  assert.equal(result.requests.thread.historyMode, 'paginated')
  assert.equal(result.requests.thread.ephemeral, false)
  assert.ok(!cmd.some((a) => String(a).includes('bypass')), '不得出现任何 bypass 参数')
  assert.ok(result.prompt.includes('只读'), '提示词必须写死只读契约')
})

test('--model terra 映射到 gpt-5.6-terra 并带 effort', async () => {
  const result = await runAdvisor({
    kind: 'ask',
    task: 'x',
    workspace: ROOT,
    model: 'terra',
    effort: 'medium',
    dryRun: true,
    ledgerHome: makeHome(),
  })
  assert.equal(result.model, 'gpt-5.6-terra')
  assert.equal(result.requests.thread.config.model_reasoning_effort, 'medium')
  assert.equal(result.requests.turn.effort, 'medium')
})

test('不写模型时默认 terra；口语写法能解析成规范模型名', async () => {
  const cases = [
    [undefined, 'gpt-5.6-terra'],
    ['', 'gpt-5.6-terra'],
    ['6.1sol', 'gpt-6.1-sol'],
    ['6.1-sol', 'gpt-6.1-sol'],
    ['sol', 'gpt-6.1-sol'],
    ['5.6sol', 'gpt-5.6-sol'],
    ['luna', 'gpt-5.6-luna'],
    ['gpt-reserve', 'gpt-reserve'],
    ['codex-auto-review', 'codex-auto-review'],
  ]
  for (const [input, expected] of cases) {
    const result = await runAdvisor({
      kind: 'ask',
      task: 'x',
      workspace: ROOT,
      model: input,
      dryRun: true,
      ledgerHome: makeHome(),
    })
    assert.equal(result.model, expected, `model=${JSON.stringify(input)}`)
  }
})

test('默认不指定推理强度，沿用 Codex 自身配置', async () => {
  const result = await runAdvisor({
    kind: 'plan',
    task: 'x',
    workspace: ROOT,
    dryRun: true,
    ledgerHome: makeHome(),
  })
  assert.equal(result.requests.thread.config, undefined)
  assert.equal(result.requests.turn.effort, undefined)
})

test('成功调用：解析线程 id 与用量，落盘正文与台账', async () => {
  const home = makeHome()
  const promptOut = path.join(home, 'prompt.txt')

  const result = await withFake({ promptOut }, () =>
    runAdvisor({
      kind: 'plan',
      task: '重构目标队列',
      workspace: ROOT,
      model: 'sol',
      conversation: 'topic-a',
      ledgerHome: home,
    }),
  )

  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(result.threadId, '00000000-0000-4000-8000-000000000001')
  assert.equal(result.sidebar.visibleInDefaultList, true)
  assert.equal(result.sidebar.cwd, ROOT)
  assert.equal(result.sidebar.projectId, 'fake-project')
  assert.equal(result.sidebar.visibleInProject, true)
  assert.equal(result.usage.inputTokens, 1234)
  assert.equal(result.usage.outputTokens, 78)
  assert.match(result.text, /FAKE_ADVICE/)
  assert.ok(fs.existsSync(result.textFile), '正文必须落盘')
  assert.ok(result.warnings.some((w) => w.includes('benign')), '警告要被收集')

  const records = readRecords(home)
  assert.equal(records.length, 1)
  assert.equal(records[0].conversation, 'topic-a')
  assert.equal(records[0].threadId, '00000000-0000-4000-8000-000000000001')

  const sentPrompt = fs.readFileSync(promptOut, 'utf8')
  assert.ok(sentPrompt.includes('重构目标队列'))
})

test('桌面运行时的成功问询会请求 Codex 原生协议打开同一线程', async () => {
  let opened = null
  const result = await withFake({}, () => runAdvisor({
    kind: 'ask', task: 'x', workspace: ROOT, ledgerHome: makeHome(), openInCodex: true,
    desktopOpen: async (threadId) => {
      opened = threadId
      return { requested: true, url: `codex://threads/${threadId}?hostId=local` }
    },
  }))

  assert.equal(result.ok, true)
  assert.equal(opened, result.threadId)
  assert.equal(result.desktop.requested, true)
})

test('同一 conversation 的第二轮会带上上一轮正文', async () => {
  const home = makeHome()
  const promptOut = path.join(home, 'prompt2.txt')

  await withFake({}, () =>
    runAdvisor({
      kind: 'plan',
      task: '第一轮任务',
      workspace: ROOT,
      conversation: 'topic-b',
      ledgerHome: home,
    }),
  )

  const second = await withFake({ promptOut }, () =>
    runAdvisor({
      kind: 'review',
      task: '第二轮复核',
      workspace: ROOT,
      conversation: 'topic-b',
      ledgerHome: home,
    }),
  )

  assert.equal(second.ok, true)
  assert.equal(second.historyIds.length, 1)
  const sentPrompt = fs.readFileSync(promptOut, 'utf8')
  assert.ok(sentPrompt.includes('之前的会话'), '必须包含历史段')
  assert.ok(sentPrompt.includes('FAKE_ADVICE'), '必须回放上一轮正文')
  assert.ok(sentPrompt.includes('第二轮复核'))
})

test('不同 conversation 之间不串上下文', async () => {
  const home = makeHome()
  const promptOut = path.join(home, 'prompt3.txt')

  await withFake({}, () =>
    runAdvisor({ kind: 'plan', task: 'A', workspace: ROOT, conversation: 'topic-c', ledgerHome: home }),
  )
  const other = await withFake({ promptOut }, () =>
    runAdvisor({ kind: 'ask', task: 'B', workspace: ROOT, conversation: 'topic-d', ledgerHome: home }),
  )

  assert.equal(other.historyIds.length, 0)
  assert.ok(!fs.readFileSync(promptOut, 'utf8').includes('之前的会话'))
})

test('Codex 失败时 ok=false 且不编造正文', async () => {
  const home = makeHome()
  const result = await withFake({ mode: 'fail' }, () =>
    runAdvisor({ kind: 'review', task: '看下这个改动', workspace: ROOT, ledgerHome: home }),
  )

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CODEX_EXIT')
  assert.match(result.error.message, /fake failure/)
  assert.equal(readRecords(home).length, 1, '失败也要留台账')
})

test('超时会杀进程并返回 TIMEOUT', async () => {
  const home = makeHome()
  const started = Date.now()
  const result = await withFake({ mode: 'sleep' }, () =>
    runAdvisor({ kind: 'ask', task: '慢查询', workspace: ROOT, timeoutSec: 2, ledgerHome: home }),
  )
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'TIMEOUT')
  assert.ok(['confirmed', 'unconfirmed'].includes(result.cleanup), '必须如实报告清理状态')
  assert.ok(elapsed < 20000, `应该在超时后很快返回，实际 ${elapsed}ms`)
})

test('参数校验：未知类型、坏模型名、坏 effort、不存在的工作区', async () => {
  const home = makeHome()
  const bad = [
    { kind: 'explode', task: 'x' },
    { kind: 'plan', task: 'x', model: 'gpt 6; rm -rf /' },
    { kind: 'plan', task: 'x', effort: 'ultra' },
    { kind: 'plan', task: 'x', workspace: path.join(home, 'nope') },
    { kind: 'plan', task: '   ' },
  ]
  for (const input of bad) {
    const result = await runAdvisor({ workspace: ROOT, ledgerHome: home, ...input })
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(result.error.code, 'BAD_ARGS', JSON.stringify(input))
  }
})

test('上下文注入：--paths 指向的文件内容真的进了提示词', async () => {
  const home = makeHome()
  const promptOut = path.join(home, 'prompt-ctx.txt')
  const target = path.join(ROOT, 'src', 'prompts.mjs')

  const result = await withFake({ promptOut }, () =>
    runAdvisor({
      kind: 'review',
      task: '审核这个文件',
      workspace: ROOT,
      paths: ['src/prompts.mjs'],
      ledgerHome: home,
    }),
  )

  assert.equal(result.ok, true)
  assert.equal(result.context.files, 1)
  const sentPrompt = fs.readFileSync(promptOut, 'utf8')
  assert.ok(sentPrompt.includes('参考资料'), '必须有参考资料段')
  assert.ok(sentPrompt.includes('src/prompts.mjs'), '必须标出文件路径')
  assert.ok(sentPrompt.includes('ROLE_CONTRACT'), '必须含文件真实内容')
  assert.ok(fs.readFileSync(target, 'utf8').length > 0)
})

test('--no-context 时不注入文件内容', async () => {
  const home = makeHome()
  const promptOut = path.join(home, 'prompt-noctx.txt')

  const result = await withFake({ promptOut }, () =>
    runAdvisor({
      kind: 'ask',
      task: '只看描述',
      workspace: ROOT,
      paths: ['src/prompts.mjs'],
      noContext: true,
      ledgerHome: home,
    }),
  )

  assert.equal(result.context.files, 0)
  assert.ok(!fs.readFileSync(promptOut, 'utf8').includes('## 参考资料'))
})

test('上下文不接受工作区之外的路径', async () => {
  const home = makeHome()
  const result = await withFake({}, () =>
    runAdvisor({
      kind: 'ask',
      task: 'x',
      workspace: ROOT,
      context: ['C:/Windows/win.ini'],
      ledgerHome: home,
    }),
  )
  assert.equal(result.context.files, 0)
  assert.ok(result.context.skipped.some((s) => s.reason === 'outside-workspace'))
})

test('上下文不接受经符号链接/junction 逃出工作区的路径', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE_SECRET', 'utf8')
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-ws-'))
  fs.writeFileSync(path.join(workspace, 'inside.txt'), 'INSIDE_OK', 'utf8')

  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'leak.txt'), 'file')
  } catch {
    t.skip('本机没有创建符号链接的权限，跳过')
    return
  }

  const ctx = collectContext(workspace, ['leak.txt', 'inside.txt'])
  assert.equal(ctx.files.length, 1, '只应注入工作区内的真实文件')
  assert.ok(!ctx.text.includes('OUTSIDE_SECRET'), '外部内容绝不能进提示词')
  assert.ok(ctx.text.includes('INSIDE_OK'))
  assert.ok(ctx.skipped.some((s) => s.reason === 'outside-workspace'))
})

test('只有 .cmd 垫片而没有 js 入口时失败关闭，不退回 shell 拼接', async () => {
  const savedPath = process.env.PATH
  const savedBin = process.env.CODEX_ADVISOR_CODEX_BIN
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-shim-'))
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '@echo off\n', 'utf8')
  delete process.env.CODEX_ADVISOR_CODEX_BIN
  process.env.PATH = dir
  try {
    const resolved = resolveCodex({ preferDesktop: false })
    assert.ok(resolved.error, '必须返回明确错误而不是启动 shell')
    assert.notEqual(resolved.shell, true)
  } finally {
    process.env.PATH = savedPath
    if (savedBin !== undefined) process.env.CODEX_ADVISOR_CODEX_BIN = savedBin
  }
})

test('codex 可执行文件解析出真实存在的入口（Windows 垫片要绕开 .cmd）', async (t) => {
  const saved = process.env.CODEX_ADVISOR_CODEX_BIN
  delete process.env.CODEX_ADVISOR_CODEX_BIN
  try {
    const resolved = resolveCodex()
    if (resolved.bin === 'codex') {
      t.skip('本机 PATH 上没有 codex，跳过')
      return
    }
    assert.equal(resolved.error, undefined, resolved.error)
    assert.ok(fs.existsSync(resolved.bin), `解析出的入口不存在：${resolved.bin}`)
    assert.notEqual(resolved.shell, true, '绝不能走 shell 拼接')
  } finally {
    if (saved !== undefined) process.env.CODEX_ADVISOR_CODEX_BIN = saved
  }
})

test('MCP 包装能完成握手并列出三个工具', async () => {  const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => lines.push(d))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')

  await new Promise((resolve) => setTimeout(resolve, 800))
  child.kill()

  const messages = lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
  const init = messages.find((m) => m.id === 1)
  const list = messages.find((m) => m.id === 2)

  assert.equal(init.result.serverInfo.name, 'codex-advisor')
  const names = list.result.tools.map((t) => t.name)
  assert.deepEqual(names, ['codex_plan', 'codex_review', 'codex_ask'])
})


test('RPC 错误、提前退出、部分正文后失败、项目列表缺失均不能误报成功', async () => {
  for (const mode of ['rpc-error', 'early-exit', 'partial-fail', 'missing-list']) {
    const result = await withFake({ mode }, () => runAdvisor({
      kind: 'ask', task: 'x', workspace: ROOT, ledgerHome: makeHome(), timeoutSec: 5,
    }))
    assert.equal(result.ok, false, mode)
    assert.equal(result.error.code, mode === 'missing-list' ? 'SIDEBAR_NOT_VISIBLE' : 'CODEX_EXIT', mode)
    if (mode === 'partial-fail') assert.match(result.text, /FAKE_ADVICE/)
  }
})

test('服务端返回错误模型或非只读权限时，不发送用户任务', async () => {
  for (const mode of ['unsafe', 'wrong-model', 'wrong-project']) {
    const home = makeHome(), promptOut = path.join(home, 'prompt.txt')
    const result = await withFake({ mode, promptOut }, () => runAdvisor({
      kind: 'ask', task: 'PRIVATE_TASK', workspace: ROOT, ledgerHome: home,
    }))
    assert.equal(result.ok, false)
    assert.match(result.error.message, /unexpected model, sandbox/)
    assert.equal(fs.existsSync(promptOut), false)
  }
})

test('Git review 使用同一只读线程的 inline review/start，保留三类 target', async () => {
  for (const [options, target] of [
    [{}, { type: 'uncommittedChanges' }],
    [{ diffBase: 'main' }, { type: 'baseBranch', branch: 'main' }],
    [{ diffCommit: 'abc123' }, { type: 'commit', sha: 'abc123', title: null }],
  ]) {
    const input = { kind: 'review', diff: true, workspace: ROOT, ledgerHome: makeHome(), ...options }
    const dry = await runAdvisor({ ...input, dryRun: true })
    assert.equal(dry.requests.method, 'review/start')
    assert.equal(dry.requests.turn.delivery, 'inline')
    assert.deepEqual(dry.requests.turn.target, target)
    const result = await withFake({}, () => runAdvisor(input))
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.text, 'FAKE_REVIEW')
  }
})


test('旧 CLI、不存在或歧义项目在创建线程前失败，不能默默退成 cwd 归属', async () => {
  for (const [mode, code] of [['old-cli', 'APP_SERVER_UNSUPPORTED'], ['old-cli-serde', 'APP_SERVER_UNSUPPORTED'], ['no-project', 'PROJECT_NOT_FOUND'], ['ambiguous-project', 'PROJECT_AMBIGUOUS']]) {
    const home = makeHome(), promptOut = path.join(home, 'task.txt')
    const result = await withFake({ mode, promptOut }, () => runAdvisor({ kind: 'ask', task: 'PRIVATE_TASK', workspace: ROOT, ledgerHome: home }))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, code)
    assert.equal(result.threadId, null)
    assert.equal(fs.existsSync(promptOut), false)
  }
})

test('项目分页可找到目录；最终列表必须回读同一 projectId', async () => {
  const result = await withFake({ mode: 'project-pages' }, () => runAdvisor({ kind: 'ask', task: 'x', workspace: ROOT, ledgerHome: makeHome() }))
  assert.equal(result.ok, true)
  assert.equal(result.sidebar.projectId, 'fake-project')
  const wrong = await withFake({ mode: 'wrong-list-project' }, () => runAdvisor({ kind: 'ask', task: 'x', workspace: ROOT, ledgerHome: makeHome() }))
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'SIDEBAR_NOT_VISIBLE')
  assert.equal(wrong.sidebar.visibleInProject, false)
})

test('CLI --version 跟随 package.json，无子命令也能命中', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'advisor.mjs'), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })

  const version = await run(['--version'])
  assert.equal(version.out.trim(), `codex-advisor ${pkg.version}`)

  const help = await run(['--help'])
  assert.match(help.out, /codex-advisor — DSH 主执行/)
})

test('参数值以 -- 开头不会被当成标志吞掉', async () => {
  const child = spawn(process.execPath, [
    path.join(ROOT, 'src', 'advisor.mjs'), 'ask',
    '--workspace', ROOT,
    '--task', '--dry-run 是什么意思',
    '--dry-run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => { out += d })
  const code = await new Promise((resolve) => child.on('close', resolve))

  assert.equal(code, 0, out)
  const result = JSON.parse(out)
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.match(result.prompt, /--dry-run 是什么意思/)
})

test('非交互环境下没给任务会快速失败，不会挂死', async () => {
  const started = Date.now()
  const child = spawn(process.execPath, [
    path.join(ROOT, 'src', 'advisor.mjs'), 'ask', '--workspace', ROOT,
  ], { stdio: ['pipe', 'pipe', 'pipe'] }) // stdin 一直开着且不写，模拟计划任务
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { err += d })
  const code = await new Promise((resolve) => child.on('close', resolve))
  const elapsed = Date.now() - started

  assert.equal(code, 4, `期望参数错误退出码 4，实际 ${code}：${err}`)
  assert.match(err, /缺少任务内容/)
  assert.ok(elapsed < 8000, `1.5 秒上限失效，实际等了 ${elapsed}ms`)
})

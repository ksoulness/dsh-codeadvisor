#!/usr/bin/env node
/**
 * dsh-codeadvisor — DSH 主执行，Codex 只读顾问。
 *
 * 三个动作：plan（出计划）、review（做审核）、ask（咨询）。
 * 每次都开一个全新的 Codex 线程；多轮延续走本地台账回放，不依赖 resume。
 * 沙箱恒定 read-only，Codex 无法落地任何改动。
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { EFFORTS, KINDS, buildPrompt, normalizeModel } from './prompts.mjs'
import { collectContext } from './context.mjs'
import { buildRequests, runAppServer } from './app-server.mjs'
import { requestDesktopOpen } from './desktop.mjs'
import { appendRecord, readRecords, resolveHome, storePaths } from './ledger.mjs'

function badArg(message) {
  return { ok: false, error: { code: 'BAD_ARGS', message } }
}

/** 版本以 package.json 为唯一来源，避免 --version 与实际包版本漂移。 */
const VERSION = (() => {
  try {
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function resolveModel(value) {
  return normalizeModel(value)
}

/** 终止整棵进程树；返回 Promise<boolean>，true 表示终止命令本身执行成功（不代表已确认退出）。 */
function terminateTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false)
    if (process.platform === 'win32') {
      let killer
      try {
        killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        return resolve(false)
      }
      killer.on('error', () => resolve(false))
      killer.on('close', (code) => resolve(code === 0))
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return resolve(false)
    }
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已经退出 */
      }
    }, 3000)
    resolve(true)
  })
}

function findOnPath(names) {
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 该目录下没有 */
      }
    }
  }
  return null
}

/**
 * 定位 pwsh：显式环境变量 → PATH → WindowsApps 安装位置。
 * 不写死用户名，避免仓库随机器漂移。
 */
function resolvePwsh() {
  const explicit = process.env.CODEX_ADVISOR_PWSH
  if (explicit && fs.existsSync(explicit)) return explicit
  const onPath = findOnPath(['pwsh.exe'])
  if (onPath) return onPath
  if (process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    if (fs.existsSync(local)) return local
  }
  return null
}

/**
 * 定位 codex 可执行文件。
 *
 * Windows 优先使用当前桌面进程拥有的运行时，保证具备同一版本的项目协议。
 * PATH 上 `codex` 通常是 npm 的 .cmd 垫片，Node 的 spawn 不能直接起 .cmd（会 ENOENT）。
 * 该垫片本质是转发到 `node <npm>/node_modules/@openai/codex/bin/codex.js`，
 * 直接起那个 js 可以完全绕开 cmd.exe 的引号规则。
 */
export function resolveCodex({ preferDesktop = true } = {}) {
  const explicit = process.env.CODEX_ADVISOR_CODEX_BIN
  if (explicit) return { bin: explicit, prefixArgs: [], shell: false }

  if (process.platform !== 'win32') return { bin: 'codex', prefixArgs: [], shell: false }

  if (preferDesktop && process.env.LOCALAPPDATA) {
    // npm CLI 可能早于桌面项目协议。只读取桌面所拥有的实际运行路径，不按缓存年龄猜版本。
    const script = String.raw`
      $taskApps = @(Get-CimInstance Win32_Process -Filter "Name = 'ChatGPT.exe'" | Where-Object { $_.ExecutablePath -like '*\WindowsApps\OpenAI.Codex_*\app\ChatGPT.exe' } | Select-Object -ExpandProperty ProcessId)
      @(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $_.ParentProcessId -in $taskApps } | Select-Object -ExpandProperty ExecutablePath -Unique) | ConvertTo-Json -Compress
    `
    try {
      const pwsh = resolvePwsh()
      const output = pwsh
        ? execFileSync(pwsh, ['-NoProfile', '-Command', script],
          { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        : ''
      const value = output ? JSON.parse(output) : []
      const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin').toLowerCase()
      const candidates = [...new Set((Array.isArray(value) ? value : [value]).filter((file) =>
        typeof file === 'string' && path.basename(file).toLowerCase() === 'codex.exe'
        && path.dirname(path.dirname(file)).toLowerCase() === root && fs.existsSync(file)))]
      if (candidates.length === 1) return { bin: candidates[0], prefixArgs: [], shell: false, desktopRuntime: true }
      if (candidates.length > 1) return { error: '检测到多个桌面 Codex 运行时，请用 CODEX_ADVISOR_CODEX_BIN 指定本次运行时。' }
    } catch { /* 无法识别桌面运行时时，仍须通过后续 project/list 能力检查。 */ }
  }

  const exe = findOnPath(['codex.exe'])
  if (exe) return { bin: exe, prefixArgs: [], shell: false }

  const shim = findOnPath(['codex.cmd', 'codex.bat'])
  if (shim) {
    const entry = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if (fs.existsSync(entry)) return { bin: process.execPath, prefixArgs: [entry], shell: false }
    // 宁可失败也不经 cmd.exe 拼参数：shell 拼接会让 --base 之类的值变成命令注入面。
    return {
      error:
        `找到 ${shim}，但没有对应的 codex.js 入口。为避免经 cmd.exe 拼接参数，已拒绝启动。` +
        ' 请把 CODEX_ADVISOR_CODEX_BIN 指向真实的 codex 可执行文件。',
    }
  }

  return { bin: 'codex', prefixArgs: [], shell: false }
}

function normalizeUsage(usage) {
  if (!usage) return null
  return {
    inputTokens: usage.inputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? null,
  }
}

function firstErrorLine(stderr) {
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const hit = lines.find((l) => /^error[: ]/i.test(l)) || lines.find((l) => /error/i.test(l))
  return hit || ''
}

function collectHistory(home, conversation, workspace, limit, maxChars) {
  const records = readRecords(home).filter(
    (r) =>
      r &&
      r.ok &&
      r.conversation === conversation &&
      r.workspace === workspace &&
      typeof r.textFile === 'string',
  )
  const picked = records.slice(-Math.max(1, limit))
  const turns = []
  let budget = Math.max(1000, maxChars)

  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const record = picked[i]
    let text = ''
    try {
      text = fs.readFileSync(record.textFile, 'utf8')
    } catch {
      continue
    }
    if (text.length > budget) text = text.slice(0, budget) + '\n…（历史已按预算截断）'
    budget -= text.length
    turns.unshift({
      id: record.id,
      kind: record.kind,
      ts: record.ts,
      model: record.model,
      text,
    })
    if (budget <= 0) break
  }

  return turns
}

/**
 * 执行一次顾问调用。
 *
 * @returns {Promise<object>} 结构化结果；失败时 ok=false 并带 error.code。
 */
export async function runAdvisor(input = {}) {
  const kind = input.kind
  if (!KINDS.includes(kind)) return badArg(`未知任务类型：${kind}`)

  const workspace = path.resolve(input.workspace || process.cwd())
  if (!isDir(workspace)) return badArg(`工作区不存在或不是目录：${workspace}`)

  const diffMode = kind === 'review' && Boolean(input.diff)
  const task = String(input.task || '').trim()
  if (!diffMode && !task) return badArg('缺少任务内容：用 --task / --task-file / stdin 提供')

  const model = resolveModel(input.model)
  if (!model) return badArg(`模型名不合法：${input.model}`)

  const effort = String(input.effort || '').trim()
  if (effort && !EFFORTS.includes(effort)) return badArg(`reasoning effort 不合法：${effort}`)

  const home = resolveHome(input.ledgerHome)
  const paths = storePaths(home)
  const conversation = String(input.conversation || '').trim()

  const history =
    conversation && !diffMode
      ? collectHistory(
          home,
          conversation,
          workspace,
          toInt(input.history, 3),
          toInt(input.historyChars, 12000),
        )
      : []

  const scopePaths = Array.isArray(input.paths) ? input.paths : String(input.paths || '').split(',')

  // 本机 Codex 的只读沙箱起不了子进程，顾问读不到文件 → 由 DSH 侧读好注入。
  // 默认把 --paths 指到的文件/目录一起带上，--context 在其之上追加；--no-context 全关。
  const explicitContext = (Array.isArray(input.context) ? input.context : String(input.context || '').split(','))
    .map((p) => String(p || '').trim())
    .filter(Boolean)
  const contextEntries = input.noContext
    ? []
    : [...new Set([...scopePaths.map((p) => String(p || '').trim()).filter(Boolean), ...explicitContext])]
  const context = diffMode
    ? { text: '', chars: 0, files: [], skipped: [] }
    : collectContext(workspace, contextEntries, {
        perFileChars: toInt(input.perFileChars, 20000),
        totalChars: toInt(input.contextBudget, 80000),
      })

  const prompt = diffMode
    ? ''
    : buildPrompt({ kind, task, paths: scopePaths, history, context: context.text })

  const id = `adv_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
  const requests = buildRequests({
    kind, task, prompt,
    diffMode,
    diffBase: input.diffBase,
    diffCommit: input.diffCommit,
    model,
    effort,
    workspace,
  })

  const resolved = resolveCodex()
  if (resolved.error) {
    return { id, kind, model, workspace, conversation: conversation || null, ok: false, error: { code: 'CODEX_UNRESOLVED', message: resolved.error } }
  }
  const bin = resolved.bin
  const extraPrefix = process.env.CODEX_ADVISOR_CODEX_PREFIX ? [process.env.CODEX_ADVISOR_CODEX_PREFIX] : []
  const prefix = [...resolved.prefixArgs, ...extraPrefix]
  const base = {
    id,
    kind,
    model,
    workspace,
    conversation: conversation || null,
    ledger: paths.ledger,
    context: {
      files: context.files.length,
      chars: context.chars,
      truncated: context.files.filter((f) => f.truncated).map((f) => f.path),
      skipped: context.skipped,
    },
    command: [bin, ...prefix, 'app-server'],
  }

  if (input.dryRun) return { ok: true, dryRun: true, prompt, requests, ...base }

  const timeoutSec = toInt(input.timeoutSec, 900)
  const run = await runAppServer({
    bin,
    prefixArgs: prefix,
    requests,
    cwd: workspace,
    terminateTree,
    timeoutMs: timeoutSec > 0 ? timeoutSec * 1000 : 0,
  })

  if (run.spawnError) {
    const err = run.spawnError
    return {
      ...base,
      ok: false,
      elapsedMs: run.elapsedMs,
      error: {
        code: err.code === 'ENOENT' ? 'CODEX_MISSING' : 'SPAWN_FAILED',
        message: `无法启动 ${bin}：${err.message}`,
      },
    }
  }

  if (run.timedOut) {
    return {
      ...base,
      ok: false,
      elapsedMs: run.elapsedMs,
      threadId: run.threadId,
      cleanup: run.cleanupUnconfirmed ? 'unconfirmed' : 'confirmed',
      error: {
        code: 'TIMEOUT',
        message: run.cleanupUnconfirmed
          ? `超过 ${timeoutSec}s 未完成，已发出终止但宽限期内未确认子进程退出`
          : `超过 ${timeoutSec}s 未完成，Codex 进程已终止`,
      },
      stderrTail: String(run.stderr).slice(-2000),
    }
  }

  const text = String(run.agentText || '').trim()

  let textFile = null
  if (text) {
    fs.mkdirSync(paths.texts, { recursive: true })
    textFile = path.join(paths.texts, `${id}.md`)
    fs.writeFileSync(textFile, text.endsWith('\n') ? text : text + '\n', 'utf8')
  }

  const ok = run.code === 0 && !run.failed && text.length > 0
  const error = ok
    ? null
    : {
        code: run.errorCode || (run.code === 0 && !run.failed ? 'EMPTY_RESULT' : 'CODEX_EXIT'),
        message:
          run.failed ||
          firstErrorLine(run.stderr) ||
          `codex 退出码 ${run.code}${text ? '' : '，且没有产出正文'}`,
      }

  let desktop = { requested: false, reason: 'not-requested' }
  if (ok && input.openInCodex !== false && (input.openInCodex === true || resolved.desktopRuntime) && run.sidebar?.visibleInProject && run.threadId) {
    try {
      desktop = await (input.desktopOpen || requestDesktopOpen)(run.threadId)
    } catch (err) {
      desktop = { requested: false, error: String(err?.message || err) }
    }
  }

  const record = {
    id,
    ts: new Date().toISOString(),
    ok,
    kind,
    model,
    workspace,
    conversation: conversation || null,
    threadId: run.threadId,
    sidebar: run.sidebar,
    desktop,
    exitCode: run.code,
    elapsedMs: run.elapsedMs,
    usage: normalizeUsage(run.usage),
    promptChars: prompt.length,
    promptSha256: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    textChars: text.length,
    textFile,
    historyIds: history.map((h) => h.id),
    contextFiles: context.files.map((f) => f.path),
    contextChars: context.chars,
    error: error ? error.code : null,
  }
  appendRecord(home, record)

  return {
    ...base,
    ok,
    elapsedMs: run.elapsedMs,
    cleanup: run.cleanupUnconfirmed ? 'unconfirmed' : 'confirmed',
    exitCode: run.code,
    threadId: run.threadId,
    sidebar: run.sidebar,
    desktop,
    usage: normalizeUsage(run.usage),
    warnings: run.warnings,
    error,
    text,
    textFile,
    historyIds: record.historyIds,
  }
}

const USAGE = `dsh-codeadvisor — DSH 主执行，Codex 只读顾问

用法：
  node src/advisor.mjs plan   --task "<任务>" [选项]      出实施计划
  node src/advisor.mjs review --task "<任务>" [选项]      审核（提示词模式）
  node src/advisor.mjs review --diff [--base <分支>|--commit <sha>]   审核 git 变更
  node src/advisor.mjs ask    --task "<问题>" [选项]      咨询
  node src/advisor.mjs sessions [--json]                  查看本机台账

选项：
  --workspace <目录>      Codex 的工作根，默认当前目录
  --model <模型>          terra（默认）/ sol / 6.1sol / sol56 / luna / 目录里的其他模型名
  --effort <级别>         minimal|low|medium|high|xhigh；默认不指定，沿用 Codex 自身配置
  --paths <a,b>           重点范围；指向的文件/目录默认也会被读进上下文
  --context <a,b>         额外注入上下文的文件/目录（默认由 DSH 读取后放进提示词）
  --no-context            不注入任何文件内容
  --context-budget <n>    上下文总字符预算，默认 80000
  --per-file-chars <n>    单文件字符预算，默认 20000
  --conversation <名字>   同一话题的多轮延续（本地台账回放）
  --history <n>           回放最近 n 轮，默认 3
  --task-file <文件>      从文件读任务
  --task -                从 stdin 读任务（非 TTY 未给任务时最多等 1.5 秒，不会挂死）
  --text                  只打印正文，不打印 JSON
  --timeout <秒>          默认 900，0 表示不限
  --out <文件>            把正文另存一份
  --no-open-in-codex      成功后不请求桌面端打开该会话
  --dry-run               只打印将要执行的命令，不真的调用 Codex
  --ledger <目录>         台账目录，默认 %LOCALAPPDATA%\\\\dsh-codeadvisor

环境变量：
  CODEX_ADVISOR_HOME             台账目录（覆盖 --ledger 之外的默认值）
  CODEX_ADVISOR_CODEX_BIN        显式指定 Codex；Windows 默认识别当前桌面运行时，随后检查项目协议
  CODEX_ADVISOR_CODEX_PREFIX     插在子命令前的额外参数（测试用）

退出码：0 成功 / 2 失败 / 3 超时 / 4 参数错误
`

/** 必须有值的键：即使下一个 token 长得像标志，也当作它的值（例如 `--task "--dry-run 是什么"`）。 */
const VALUE_FLAGS = new Set([
  'workspace', 'model', 'effort', 'paths', 'context', 'context-budget', 'per-file-chars',
  'conversation', 'history', 'history-chars', 'task', 'task-file', 'timeout', 'out',
  'ledger', 'base', 'commit',
])

function parseArgv(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq > -1) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      const next = argv[i + 1]
      const takesValue = VALUE_FLAGS.has(key) ? next !== undefined : (next !== undefined && !next.startsWith('--'))
      if (takesValue) {
        out[key] = next
        i += 1
      } else {
        out[key] = true
      }
      continue
    }
    out._.push(arg)
  }
  return out
}

/** 读 stdin，最多等 ms 毫秒（ms<=0 表示等到 EOF）。避免非交互环境里永久挂住。 */
function readStdin(ms) {
  return new Promise((resolve) => {
    let data = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      process.stdin.removeAllListeners('data')
      process.stdin.removeAllListeners('end')
      process.stdin.removeAllListeners('error')
      process.stdin.pause()
      resolve(value)
    }
    const timer = ms > 0 ? setTimeout(() => finish(data), ms) : null
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => finish(data))
    process.stdin.on('error', () => finish(data))
    process.stdin.resume()
  })
}

async function readTask(args) {
  if (typeof args.task === 'string' && args.task !== '-') return args.task
  if (args['task-file']) return fs.readFileSync(path.resolve(String(args['task-file'])), 'utf8')
  // `--task -` 是显式要求读 stdin，等到 EOF；其余情况只要不连 TTY 就尝试读，
  // 但设 1.5 秒上限——计划任务里忘写任务时不会静默挂死，管道有内容时照样能读到。
  if (args.task === '-') return readStdin(0)
  if (process.stdin.isTTY) return ''
  return readStdin(1500)
}

function sessionsCommand(args) {
  const home = resolveHome(args.ledger)
  const records = readRecords(home)
  if (args.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + '\n')
    return 0
  }
  if (records.length === 0) {
    process.stdout.write(`台账为空：${storePaths(home).ledger}\n`)
    return 0
  }
  const rows = records.slice(-20).map((r) => ({
    id: r.id,
    ts: r.ts,
    ok: r.ok ? 'ok' : 'FAIL',
    kind: r.kind,
    model: r.model,
    conversation: r.conversation || '-',
    chars: r.textChars,
    thread: r.threadId || '-',
  }))
  process.stdout.write(`台账：${storePaths(home).ledger}\n`)
  for (const row of rows) {
    process.stdout.write(
      [
        row.id,
        row.ts,
        row.ok,
        row.kind,
        row.model,
        `conv=${row.conversation}`,
        `chars=${row.chars}`,
        `thread=${row.thread}`,
      ].join('  ') + '\n',
    )
  }
  return 0
}

async function main(argv) {
  const args = parseArgv(argv)
  const command = args._[0]

  // 先判 version：`--version` 没有子命令，不能落进下面的 USAGE 分支。
  if (command === 'version' || args.version) {
    process.stdout.write(`dsh-codeadvisor ${VERSION}\n`)
    return 0
  }
  if (!command || command === 'help' || args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (command === 'sessions') return sessionsCommand(args)

  if (!KINDS.includes(command)) {
    process.stderr.write(`未知命令：${command}\n\n${USAGE}`)
    return 4
  }

  const task = await readTask(args)
  if (!task.trim() && !(command === 'review' && args.diff)) {
    process.stderr.write('缺少任务内容：用 --task / --task-file，或从 stdin 传入\n')
    return 4
  }

  const result = await runAdvisor({
    kind: command,
    task,
    workspace: args.workspace,
    model: args.model,
    effort: args.effort,
    paths: args.paths,
    conversation: args.conversation,
    history: args.history,
    historyChars: args['history-chars'],
    timeoutSec: args.timeout,
    ledgerHome: args.ledger,
    dryRun: Boolean(args['dry-run']),
    diff: Boolean(args.diff),
    diffBase: args.base,
    diffCommit: args.commit,
    context: args.context,
    contextBudget: args['context-budget'],
    perFileChars: args['per-file-chars'],
    noContext: Boolean(args['no-context']),
    openInCodex: args['no-open-in-codex'] ? false : undefined,
  })

  if (args.out && result.text) {
    const outPath = path.resolve(String(args.out))
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, result.text.endsWith('\n') ? result.text : result.text + '\n', 'utf8')
    result.outFile = outPath
  }

  if (args.text) {
    if (result.text) process.stdout.write(result.text + '\n')
    if (!result.ok) process.stderr.write(`${result.error.code}: ${result.error.message}\n`)
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  }

  if (result.ok) return 0
  if (!result.error) return 2
  if (result.error.code === 'TIMEOUT') return 3
  if (result.error.code === 'BAD_ARGS') return 4
  return 2
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`dsh-codeadvisor 崩溃：${err?.stack || err}\n`)
      process.exit(2)
    },
  )
}

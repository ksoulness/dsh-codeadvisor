/**
 * 上下文注入。
 *
 * 为什么需要：本机 Codex 0.147.0 的 Windows 只读沙箱无法启动子进程
 * （`CreateProcessAsUserW failed: 5 拒绝访问`），顾问实际上读不到任何文件。
 * 因此由 DSH 侧读取真实内容，按预算拼进提示词——顾问拿到的是可核对的实际文本，
 * 而不是一句「你自己去看」。
 */
import fs from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-codeadvisor', 'dist', 'build', '.venv', '__pycache__'])

function realPath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/** 用真实路径比较，否则工作区内的符号链接 / junction 可以把外部文件带进来。 */
function isInsideReal(realBase, realTarget) {
  const rel = path.relative(realBase, realTarget)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function looksBinary(text) {
  return text.includes('\u0000')
}

function walkFiles(dir, acc, limit) {
  if (acc.length >= limit) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (acc.length >= limit) return
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkFiles(path.join(dir, entry.name), acc, limit)
    } else if (entry.isFile()) {
      acc.push(path.join(dir, entry.name))
    }
  }
}

/**
 * @param {string} baseDir 工作区根；不接受根目录之外的内容
 * @param {string[]} entries 相对（或绝对但位于根内）的路径，文件或目录
 * @param {{perFileChars?: number, totalChars?: number, maxFiles?: number}} [options]
 */
export function collectContext(baseDir, entries, options = {}) {
  const perFileChars = options.perFileChars ?? 20000
  const totalChars = options.totalChars ?? 80000
  const maxFiles = options.maxFiles ?? 200

  const result = { text: '', chars: 0, files: [], skipped: [] }
  if (!Array.isArray(entries) || entries.length === 0) return result

  const realBase = realPath(baseDir)
  if (!realBase) {
    result.skipped.push({ path: baseDir, reason: 'workspace-unreadable' })
    return result
  }

  const wanted = []
  for (const raw of entries) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) continue
    const real = realPath(path.resolve(baseDir, trimmed))
    if (!real || !isInsideReal(realBase, real)) {
      result.skipped.push({ path: trimmed, reason: 'outside-workspace' })
      continue
    }
    let stat
    try {
      stat = fs.statSync(real)
    } catch {
      result.skipped.push({ path: trimmed, reason: 'missing' })
      continue
    }
    if (stat.isDirectory()) walkFiles(real, wanted, maxFiles)
    else if (stat.isFile()) wanted.push(real)
  }

  const chunks = []
  let used = 0

  for (const abs of wanted) {
    // 连目录遍历出来的文件也要复核一次：指向外部的 junction 照样能出现在 readdir 结果里。
    const real = realPath(abs)
    if (!real || !isInsideReal(realBase, real)) {
      result.skipped.push({ path: path.relative(realBase, abs), reason: 'outside-workspace' })
      continue
    }
    if (used >= totalChars) {
      result.skipped.push({ path: path.relative(realBase, real), reason: 'budget-exhausted' })
      continue
    }
    let text
    try {
      text = fs.readFileSync(real, 'utf8')
    } catch {
      result.skipped.push({ path: path.relative(realBase, real), reason: 'unreadable' })
      continue
    }
    if (looksBinary(text)) {
      result.skipped.push({ path: path.relative(realBase, real), reason: 'binary' })
      continue
    }

    const budget = Math.min(perFileChars, totalChars - used)
    let body = text
    let truncated = false
    if (body.length > budget) {
      body = body.slice(0, budget)
      truncated = true
    }

    const rel = path.relative(realBase, real).split(path.sep).join('/')
    chunks.push(`### ${rel}\n\`\`\`\n${body}\n\`\`\`${truncated ? '\n（超过单文件预算，已截断）' : ''}`)
    used += body.length
    result.files.push({ path: rel, chars: body.length, truncated })
  }

  result.text = chunks.join('\n\n')
  result.chars = used
  return result
}

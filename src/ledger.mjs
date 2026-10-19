/**
 * 会话台账。
 *
 * Codex 侧的线程 id 只作记录；真正的多轮延续走这里：每一轮的完整正文落盘，
 * 续接时按会话名回放最近 N 轮。这样不依赖 `codex exec resume`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export function resolveHome(flag) {
  if (flag) return path.resolve(flag)
  if (process.env.CODEX_ADVISOR_HOME) return path.resolve(process.env.CODEX_ADVISOR_HOME)
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'codex-advisor')
  }
  return path.join(os.homedir(), '.codex-advisor')
}

export function storePaths(home) {
  return {
    home,
    ledger: path.join(home, 'sessions.jsonl'),
    texts: path.join(home, 'texts'),
    tmp: path.join(home, 'tmp'),
  }
}

export function readRecords(home) {
  const { ledger } = storePaths(home)
  let raw = ''
  try {
    raw = fs.readFileSync(ledger, 'utf8')
  } catch {
    return []
  }
  const records = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // 半行写入或人工编辑过的行跳过，不让台账阻止本次运行
    }
  }
  return records
}

export function appendRecord(home, record) {
  const { ledger } = storePaths(home)
  fs.mkdirSync(path.dirname(ledger), { recursive: true })
  fs.appendFileSync(ledger, JSON.stringify(record) + '\n', 'utf8')
}

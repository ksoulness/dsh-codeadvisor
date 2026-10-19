import { execFile } from 'node:child_process'
import path from 'node:path'

export function codexThreadUrl(threadId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(threadId))) {
    throw new Error('Invalid Codex thread ID')
  }
  return `codex://threads/${threadId}?hostId=local`
}

/** 使用桌面已注册的原生协议；请求被接受不等于已验证界面显示。 */
export function requestDesktopOpen(threadId) {
  const url = codexThreadUrl(threadId)
  if (process.platform !== 'win32') return Promise.resolve({ requested: false, url, error: 'Windows desktop integration is required' })
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  return new Promise((resolve) => {
    execFile(path.join(system, 'rundll32.exe'), [path.join(system, 'url.dll') + ',FileProtocolHandler', url],
      { windowsHide: true, timeout: 10000 }, (error) => {
        resolve({ requested: !error, url, ...(error ? { error: error.message } : {}) })
      })
  })
}

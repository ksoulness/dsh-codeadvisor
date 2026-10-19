import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function canonicalRoot(value) {
  const resolved = fs.realpathSync.native(path.resolve(value))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function buildRequests({ model, effort, workspace, kind, task, prompt, diffMode, diffBase, diffCommit }) {
  const thread = {
    model, cwd: workspace, sandbox: 'read-only', approvalPolicy: 'never',
    ephemeral: false, historyMode: 'paginated',
  }
  if (effort) thread.config = { model_reasoning_effort: effort }
  const target = diffCommit ? { type: 'commit', sha: String(diffCommit), title: null }
    : diffBase ? { type: 'baseBranch', branch: String(diffBase) } : { type: 'uncommittedChanges' }
  return {
    thread,
    name: `DSH ${kind} · ${String(task || (diffMode ? 'Git review' : '')).split(/\r?\n/)[0]}`.slice(0, 100),
    method: diffMode ? 'review/start' : 'turn/start',
    turn: diffMode ? { target, delivery: 'inline' }
      : { input: [{ type: 'text', text: prompt }], ...(effort ? { effort } : {}) },
  }
}

/** 独立子进程拥有本轮 writer；EOF/超时只收它，不触碰桌面端及旧会话。 */
export function runAppServer({ bin, prefixArgs, cwd, requests, timeoutMs, terminateTree }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(bin, [...prefixArgs, 'app-server'], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffer = '', stderr = '', nextId = 0
    let threadId = null, usage = null, agentText = '', reviewText = '', sidebar = null
    let timedOut = false, closed = false, settled = false, payload = null
    let timer, graceTimer, shutdownTimer
    const warnings = [], pending = new Map()
    let resolveTurn
    const completed = new Promise((res) => { resolveTurn = res })
    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(shutdownTimer)
      for (const { reject } of pending.values()) reject(new Error('app-server connection closed'))
      pending.clear()
      resolveTurn(null)
      resolve({ elapsedMs: Date.now() - startedAt, timedOut, cleanupUnconfirmed: !closed,
        stderr, threadId, usage, agentText: reviewText || agentText, warnings, sidebar, ...extra })
    }
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n')
    const rpc = (method, params) => new Promise((res, reject) => {
      if (settled || closed) return reject(new Error('app-server connection closed'))
      const id = ++nextId
      pending.set(id, { resolve: res, reject })
      send({ id, method, params })
    })
    const stop = () => {
      terminateTree(child.pid)
      graceTimer = setTimeout(() => finish({ code: null, ...payload }), 5000)
    }
    const shutdown = (result) => {
      if (settled) return
      payload = result
      child.stdin.end()
      shutdownTimer = setTimeout(stop, 2000)
    }
    const readItem = (item) => {
      if (item?.type === 'agentMessage' && item.text) agentText = item.text
      if (item?.type === 'exitedReviewMode' && item.review) reviewText = item.review
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (data) => {
      buffer += data
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id != null) {
          if (message.method) {
            // 本客户端不承接交互审批、凭据输入或客户端工具，必须失败关闭。
            send({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } })
            continue
          }
          const request = pending.get(message.id)
          if (request) {
            pending.delete(message.id)
            if (message.error) request.reject(Object.assign(new Error(message.error.message || 'RPC failed'), { rpcCode: message.error.code }))
            else request.resolve(message.result)
          }
          continue
        }
        const params = message.params || {}
        if (params.threadId !== threadId) continue
        if (message.method === 'item/completed') readItem(params.item)
        if (message.method === 'thread/tokenUsage/updated') usage = params.tokenUsage?.total || null
        if (message.method === 'error' && params.error?.message) warnings.push(params.error.message)
        if (message.method === 'turn/completed') {
          for (const item of params.turn?.items || []) readItem(item)
          resolveTurn(params.turn)
        }
      }
    })
    child.stderr.on('data', (data) => { stderr = (stderr + data.toString('utf8')).slice(-2000) })
    child.stdin.on('error', () => { /* close/error 路径统一返回失败 */ })
    child.on('error', (spawnError) => { closed = true; finish({ spawnError }) })
    child.on('close', (code) => {
      closed = true
      finish(payload || { code, failed: 'app-server exited before turn completion' })
    })
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)

    ;(async () => {
      try {
        await rpc('initialize', { clientInfo: { name: 'dsh_codex_advisor', title: 'DSH Codex Advisor', version: '0.1.0' },
          capabilities: { experimentalApi: true } })
        send({ method: 'initialized', params: {} })
        let projectCursor = null
        const matches = []
        do {
          let projects
          try { projects = await rpc('project/list', { limit: 100, cursor: projectCursor }) }
          catch (error) {
            if (error.rpcCode === -32601 || (error.rpcCode === -32600 && error.message.includes('unknown variant `project/list`'))) {
              throw Object.assign(new Error('当前 Codex 不支持 project/list；请打开桌面端或用 CODEX_ADVISOR_CODEX_BIN 指定支持项目协议的运行时。'), { code: 'APP_SERVER_UNSUPPORTED' })
            }
            throw error
          }
          for (const project of projects.data) {
            if (project.roots?.some((root) => {
              try { return canonicalRoot(root.path) === canonicalRoot(cwd) } catch { return false }
            })) matches.push(project)
          }
          projectCursor = projects.nextCursor
        } while (projectCursor)
        if (matches.length !== 1) throw Object.assign(new Error(matches.length
          ? '多个桌面项目使用同一目录，无法唯一确定归属。' : '当前目录未登记为桌面项目根，请先在 Codex 添加该项目，或传正确的 --workspace。'),
          { code: matches.length ? 'PROJECT_AMBIGUOUS' : 'PROJECT_NOT_FOUND' })
        const project = matches[0]
        const started = await rpc('thread/start', { ...requests.thread, projectId: project.id })
        threadId = started.thread?.id || null
        sidebar = { source: started.thread?.source, cwd: started.thread?.cwd,
          historyMode: started.thread?.historyMode, projectId: started.thread?.projectId,
          projectName: project.name, visibleInDefaultList: false, visibleInProject: false }
        // 不相信请求值：服务端若应用了其他权限或替换模型，禁止发送用户内容。
        if (!threadId || started.sandbox?.type !== 'readOnly' || started.sandbox.networkAccess !== false
          || started.approvalPolicy !== 'never' || started.model !== requests.thread.model
          || started.thread?.ephemeral !== false || sidebar.historyMode !== 'paginated'
          || sidebar.projectId !== project.id || canonicalRoot(sidebar.cwd) !== canonicalRoot(cwd)) {
          throw new Error('thread/start returned unexpected model, sandbox or persistence settings')
        }
        await rpc('thread/name/set', { threadId, name: requests.name })
        await rpc(requests.method, { threadId, ...requests.turn })
        const turn = await completed
        if (settled) return
        if (turn?.status !== 'completed') {
          shutdown({ code: 1, failed: turn?.error?.message || `turn ${turn?.status || 'missing'}` })
          return
        }
        // 与桌面列表使用同样的默认来源过滤，并匹配本次项目根；不改数据库或 rollout。
        let cursor = null
        do {
          const list = await rpc('thread/list', { projectId: project.id, cwd, limit: 100, sortKey: 'updated_at', cursor })
          const found = list.data?.find((thread) => thread.id === threadId && thread.projectId === project.id)
          if (found) { sidebar = { ...sidebar, source: found.source, cwd: found.cwd, visibleInDefaultList: true, visibleInProject: true }; break }
          cursor = list.nextCursor
        } while (cursor)
        shutdown(sidebar.visibleInDefaultList ? { code: 0 }
          : { code: 1, failed: 'Completed thread is missing from the default project list', errorCode: 'SIDEBAR_NOT_VISIBLE' })
      } catch (error) {
        if (!settled && !timedOut) shutdown({ code: 1, failed: error.message, errorCode: error.code })
      }
    })()
  })
}

#!/usr/bin/env node
/**
 * 可选的 MCP 包装（stdio、零依赖）。
 *
 * 默认不启用：DSH 侧要走这一层需要改配置并重启宿主。命令行路线已经够用，
 * 这里只是把同一套核心暴露成原生工具 codex_plan / codex_review / codex_ask。
 *
 * 手工挂载示例（DSH 侧，按该版本的 MCP 客户端配置契约填写）：
 *   command: node
 *   args: ["<本仓库绝对路径>/mcp/server.mjs"]
 */
import fs from 'node:fs'
import { createInterface } from 'node:readline'
import process from 'node:process'
import { runAdvisor } from '../src/advisor.mjs'

const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  } catch {
    return { name: 'dsh-codeadvisor', version: '0.0.0' }
  }
})()
const SERVER_INFO = { name: PKG.name || 'dsh-codeadvisor', version: PKG.version || '0.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

const TOOLS = [
  {
    name: 'codex_plan',
    description:
      '让 Codex 顾问（只读沙箱）对当前工作区的一个任务出分步实施计划。执行仍然由 DSH 完成。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述' },
        workspace: { type: 'string', description: '工作区绝对路径，默认进程当前目录' },
        model: { type: 'string', description: 'sol | terra | astra | 具体模型名' },
        paths: { type: 'array', items: { type: 'string' }, description: '重点范围；指向的文件/目录会被读进上下文' },
        context: { type: 'array', items: { type: 'string' }, description: '额外注入上下文的文件/目录' },
        no_context: { type: 'boolean', description: '不注入任何文件内容' },
        conversation: { type: 'string', description: '同一话题的多轮延续名' },
        effort: { type: 'string', description: 'minimal|low|medium|high|xhigh' },
      },
      required: ['task'],
    },
  },
  {
    name: 'codex_review',
    description: '让 Codex 顾问（只读沙箱）审核指定范围或 git 变更，输出带定位证据的问题清单。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '审核要求；使用 diff 时可省略' },
        workspace: { type: 'string', description: '工作区绝对路径' },
        model: { type: 'string', description: 'sol | terra | astra | 具体模型名' },
        paths: { type: 'array', items: { type: 'string' } },
        context: { type: 'array', items: { type: 'string' } },
        conversation: { type: 'string' },
        diff: { type: 'boolean', description: '审核 git 变更而不是提示词范围' },
        base: { type: 'string', description: '对比基线分支（配 diff）' },
        commit: { type: 'string', description: '审核某个提交（配 diff）' },
      },
    },
  },
  {
    name: 'codex_ask',
    description: '向 Codex 顾问（只读沙箱）提一个具体问题，拿到带定位依据的回答。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '问题' },
        workspace: { type: 'string' },
        model: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
        conversation: { type: 'string' },
      },
      required: ['task'],
    },
  },
]

function toResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: result.ok !== true,
  }
}

async function callTool(name, args) {
  const kind = name === 'codex_plan' ? 'plan' : name === 'codex_review' ? 'review' : 'ask'
  return runAdvisor({
    kind,
    task: args.task,
    workspace: args.workspace,
    model: args.model,
    effort: args.effort,
    paths: args.paths,
    context: args.context,
    noContext: args.no_context,
    conversation: args.conversation,
    diff: args.diff,
    diffBase: args.base,
    diffCommit: args.commit,
  })
}

async function handle(message) {
  const { id, method, params } = message
  const reply = (result) => ({ jsonrpc: '2.0', id, result })
  const errorReply = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } })

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      if (!TOOLS.some((t) => t.name === name)) return errorReply(-32602, `未知工具：${name}`)
      try {
        return reply(toResult(await callTool(name, params?.arguments || {})))
      } catch (err) {
        return errorReply(-32603, String(err?.message || err))
      }
    }
    case 'ping':
      return reply({})
    default:
      if (id === undefined) return null // 通知类消息不需要应答
      return errorReply(-32601, `不支持的方法：${method}`)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }) + '\n',
    )
    return
  }
  handle(message).then(
    (response) => {
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    },
    (err) => {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: { code: -32603, message: String(err?.message || err) },
        }) + '\n',
      )
    },
  )
})

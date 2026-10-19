/**
 * 提示词与模型预设。
 *
 * 设计前提：Codex 只做「顾问」，DSH 是唯一执行方。因此每个请求都以同一段
 * 角色契约开头，把只读边界写死在提示词里；沙箱在命令行侧另外强制。
 */

/** 模型预设。取自 `codex debug models` 的真实目录（gpt-6.1-sol 是本机日常默认，不在目录里但可用）。 */
export const MODEL_PRESETS = {
  sol: 'gpt-6.1-sol',
  sol56: 'gpt-5.6-sol',
  terra: 'gpt-5.6-terra',
  luna: 'gpt-5.6-luna',
}

/** 用户没点名模型时用哪个。 */
export const DEFAULT_MODEL = MODEL_PRESETS.terra

/** 口语化写法 → 规范模型名。用户会说「6.1sol」「5.6terra」「terra」。 */
const SHORT_FORMS = {
  'gpt-6.1-sol': ['sol', '6.1', '61', '61sol', 'sol61', '6.1sol'],
  'gpt-5.6-sol': ['sol56', '5.6sol', '56sol'],
  'gpt-5.6-terra': ['terra', '5.6', '56', '56terra', '5.6terra', '5.6terra'],
  'gpt-5.6-luna': ['luna', '56luna', '5.6luna'],
}

const MODEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

const aliasKey = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')

const ALIAS_MAP = (() => {
  const map = new Map()
  for (const [canonical, shorts] of Object.entries(SHORT_FORMS)) {
    map.set(aliasKey(canonical), canonical)
    for (const short of shorts) map.set(aliasKey(short), canonical)
  }
  return map
})()

/**
 * 把用户的写法解析成真实模型名；空值走默认（terra），认不出返回 null。
 * 目录里的其他模型（gpt-reserve / codex-auto-review）按原名直接放行。
 */
export function normalizeModel(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return DEFAULT_MODEL
  const alias = ALIAS_MAP.get(aliasKey(raw))
  if (alias) return alias
  return MODEL_KEY_RE.test(raw) ? raw : null
}

export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']

export const KINDS = ['plan', 'review', 'ask']

export const ROLE_CONTRACT = `你是 Codex，在本机担任「顾问」；DSH 是唯一的执行方。

硬性边界：
- 只读。不要修改任何文件，不要执行会改变状态的命令（写入、安装、提交、推送、删除、重启服务等）。
- 你运行在只读沙箱中，写入会被拒绝——这是预期行为，不要试图绕过。
- 不要臆造证据。没有真正看到的文件、没有真正核对过的内容，一律标注「未验证」。
- 不要输出泛泛而谈的最佳实践；只给与本次任务直接相关的结论。
- 输出中文，结构化，能让 DSH 直接照着做。

关于你能拿到什么：
- 工作区内容由 DSH 读取后放在「参考资料」段里，那是可信的实际文件内容，可以直接引用。
- 本机沙箱可能不允许你启动任何子进程（命令会失败）。不要因此拒绝回答，
  也不要反复尝试执行命令：直接基于参考资料给出结论，并把「需要 DSH 实际运行才能确认」的部分明确列出。
- 参考资料没覆盖的文件，你可以说明「需要 DSH 补充该文件」，但不要猜它的内容。`

const KIND_SPEC = {
  plan: `给出分步实施计划。每一步包含：做什么 / 为什么 / 前置条件 / 验收标准 / 风险与回退。
标出必须由用户决策、不能由执行方自行假定的点。
不要写完整代码实现，只给关键片段、接口约束和文件落点。`,
  review: `给出问题清单。每条包含：严重度（阻塞 / 重要 / 次要）、位置（文件路径 + 章节或行号）、
证据（你实际读到的内容）、最小修复建议、如何验证。
先给结论摘要（能不能过、有几条阻塞），再逐条展开。
检查过但没问题的方面也要明确说明「已检查，无问题」。`,
  ask: `直接回答问题，给出依据（文件路径 + 定位）。
不确定就说不确定，并说明还需要什么证据才能确定。`,
}

const KIND_LABEL = {
  plan: '出实施计划（执行由 DSH 负责）',
  review: '审核（执行与修改由 DSH 负责）',
  ask: '咨询（执行由 DSH 负责）',
}

function formatHistory(history) {
  const lines = ['## 之前的会话（同一话题，供你延续）']
  history.forEach((turn, i) => {
    lines.push(`### 第 ${i + 1} 轮 · ${turn.kind} · ${turn.ts} · ${turn.model || '未知模型'}`)
    lines.push(turn.text.trim())
  })
  return lines.join('\n')
}

/**
 * 组装一次请求的完整提示词。
 *
 * @param {object} input
 * @param {'plan'|'review'|'ask'} input.kind
 * @param {string} input.task 用户的任务描述
 * @param {string[]} [input.paths] 重点范围（只是给模型的说明，不是沙箱）
 * @param {Array<{kind:string,ts:string,model?:string,text:string}>} [input.history]
 * @param {string} [input.context] DSH 侧读取的真实文件内容
 */
export function buildPrompt({ kind, task, paths = [], history = [], context = '' }) {
  const blocks = [ROLE_CONTRACT]

  if (history.length > 0) blocks.push(formatHistory(history))

  blocks.push(`## 任务类型\n${KIND_LABEL[kind] || kind}`)

  const scope = paths.filter((p) => String(p).trim().length > 0)
  if (scope.length > 0) {
    blocks.push(
      `## 重点范围\n${scope.map((p) => `- ${p}`).join('\n')}\n` +
        '（以上是重点范围，不是读取上限。）',
    )
  }

  if (String(context).trim()) {
    blocks.push(`## 参考资料（DSH 从工作区读取的实际内容）\n${context}`)
  }

  blocks.push(`## 输出要求\n${KIND_SPEC[kind] || ''}`)
  blocks.push(`## 任务\n${String(task).trim()}`)

  return blocks.join('\n\n') + '\n'
}

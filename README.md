# Codex Advisor Kit

[![test](https://github.com/ksoulness/codex-advisor-kit/actions/workflows/test.yml/badge.svg)](https://github.com/ksoulness/codex-advisor-kit/actions/workflows/test.yml)

> **DSH 干活，Codex 出主意：一次问询、只读沙箱、结构化结果、台账可续——改动权始终在 DSH 手里。**

[`ksoulness/dsh-codex-kit`](https://github.com/ksoulness/dsh-codex-kit) 把「Codex 想清楚、DSH 动手做」接成闭环。本项目是它的**反向**：DSH 是主控与执行方，Codex 降级为只读顾问——由 DSH 主动去 Codex 开新对话，让指定模型做计划与审核，然后由 DSH 自己执行和验收。

不复制粘贴源码，不把 diff 塞进聊天框，也不把执行权交出去。

## 解决什么问题

| 没有它的时候 | 有了它 |
| --- | --- |
| 想要第二意见，只能自己把代码贴给另一个模型：贴的东西和真实文件对不上、还容易漏 | DSH 按路径**自己读真实文件**注入上下文，顾问看到的就是磁盘上的内容 |
| 「另一个模型说这样改」→ 谁改？改了没有？没法追 | Codex 恒定 `sandbox: read-only`，物理上改不了；执行单列在 DSH 侧 |
| 多轮讨论断了就找不回来 | 每轮正文落盘 + `sessions.jsonl` 台账，`--conversation` 按话题回放 |
| 模型说「第 42 行有问题」，你去翻发现没有 | 提示词强制要求给出定位证据；DSH 侧再核一遍，核不上标「未验证」 |
| 不知道这次问询花了多少 | 返回 `usage`（输入/缓存/输出/推理 token）与耗时 |

## 最后效果

```text
用户 ❯ 让 Codex 审一下你刚才改的 advisor.mjs

DSH  ❯ node src/advisor.mjs review --workspace <本仓库> --model terra \
         --paths src/advisor.mjs --task "审核只读约束与超时处理，给出阻塞问题"
       → { ok: true, model: "gpt-5.6-terra", threadId: "01a1…", elapsedMs: 41233,
           usage: { inputTokens: 75525, outputTokens: 1834 }, textFile: "…\\adv_x.md" }
       （打开 src/advisor.mjs 逐条核对顾问指出的位置 → 采纳 2 条、驳回 1 条）
DSH  ❯ 自己动手改、自己跑测试、自己验证
```

拿到的不是「已完成」，而是：带定位的审核意见 + 真实 token 用量 + 台账记录，最后由 DSH 自己证明改对了。

## 三个动作

| 命令 | 用途 | 什么时候用 |
| --- | --- | --- |
| `plan` | 出分步实施计划（前置 / 验收 / 风险 / 回退） | 动手前，方案有取舍或风险 |
| `review` | 出带定位证据的问题清单 | 实现后自查，或评审别人的改动 |
| `review --diff` | 审核 git 未提交 / 某分支 / 某提交 | 有 git 仓库的改动评审 |
| `ask` | 单个具体问题 | 疑难判断，不需要长篇计划 |

## 安装

前置：Node.js ≥ 22.19、本机已登录的 `codex` CLI，支持 `app-server` 与 `historyMode: paginated`（本机桌面运行时 0.163.0-alpha.10.2 已验证；npm CLI 0.147.0 缺少项目协议，不可用于本目标）。

```powershell
git clone https://github.com/ksoulness/codex-advisor-kit.git
cd codex-advisor-kit
node --test
```

零运行时依赖，不需要 `npm install`。

> 本包**不发布到 npm**（`package.json` 保留 `"private": true` 以防误发布）；分发走 GitHub 仓库和 Release 里的 `codex-advisor-kit-0.1.0.tgz`。要改成可发布，删掉 `private` 字段再 `npm publish` 即可。

把技能装上（DSH 新会话生效）：

```powershell
Copy-Item -Recurse -Force .\skills\codex-advisor `
  "$env:DSH_HOME\agents-home\skills\codex-advisor"
```

## 用法

```powershell
# 计划
node src\advisor.mjs plan --workspace E:\Code\某项目 --model sol --task "把存储层从 JSON 换到 SQLite，出分步计划"

# 审核指定范围
node src\advisor.mjs review --workspace E:\Code\某项目 --model terra --paths "src/a.mjs,src/b.mjs" --task "审核错误处理与资源释放"

# 审核 git 变更（无需写提示词）
node src\advisor.mjs review --diff --workspace E:\Code\某项目 --model terra
node src\advisor.mjs review --diff --base main --workspace E:\Code\某项目

# 多轮
node src\advisor.mjs plan   --workspace E:\Code\某项目 --conversation design-a --task "出方案"
node src\advisor.mjs review --workspace E:\Code\某项目 --conversation design-a --task "挑毛病"

# 台账
node src\advisor.mjs sessions
```

只看正文：加 `--text`。只演练命令不真的调用：`--dry-run`（会打印完整命令与提示词）。

### 参数速查

| 参数 | 说明 |
| --- | --- |
| `--workspace <目录>` | 必须传本次项目根；想进入已登记项目列表时，路径应与 Codex 左侧项目目录一致 |
| `--model <模型>` | `terra`=`gpt-5.6-terra`（**默认**）、`sol`=`gpt-6.1-sol`、`sol56`=`gpt-5.6-sol`、`luna`=`gpt-5.6-luna`；口语写法 `6.1sol` / `5.6sol` 也能认，目录里其他模型直接写原名 |
| `--effort <级别>` | `minimal`/`low`/`medium`/`high`/`xhigh`。**默认不指定，沿用 Codex 自身配置（本机 high）** |
| `--paths <a,b>` | 重点范围。指向的文件/目录**默认也会被读进上下文** |
| `--context <a,b>` | 在 `--paths` 之外追加注入上下文的文件/目录 |
| `--no-context` | 完全不注入文件内容（顾问只能看到任务描述） |
| `--context-budget <n>` | 上下文总字符预算，默认 80000 |
| `--per-file-chars <n>` | 单文件字符预算，默认 20000 |
| `--conversation <名字>` | 同一话题的多轮延续（本地台账回放最近 `--history` 轮，默认 3） |
| `--timeout <秒>` | 默认 900，超时后终止进程树并在宽限期内收口 |
| `--ledger <目录>` | 台账目录，默认 `%LOCALAPPDATA%\codex-advisor` |
| `--out <文件>` | 正文另存一份 |
| `--no-open-in-codex` | 成功后不请求 Codex 桌面端打开该会话 |

退出码：`0` 成功 / `2` 失败 / `3` 超时 / `4` 参数错误。

任务内容三种来源：`--task "<文本>"`、`--task-file <文件>`、stdin（显式写 `--task -`，或直接 `echo "…" | node src/advisor.mjs ask`）。非交互环境下没给任务时最多等 1.5 秒就会以退出码 `4` 报错，不会挂死。

## 它怎么跑起来

```text
DSH → advisor.mjs → codex app-server（独立 stdio 子进程）
                   initialize → project/list（按根目录匹配唯一项目）
                   thread/start（含 projectId）→ thread/name/set
                   turn/start（或 inline review/start）→ turn/completed
                   thread/list（默认来源过滤 + projectId + cwd）→ 校验可见性
                   codex://threads/<id> → 请求桌面端采纳并显示会话
DSH ← 正文 + threadId + usage + sidebar + 本机台账
```

- 新建线程持久化、`historyMode: paginated`、`sandbox: read-only`、`approvalPolicy: never`；发送任务前核验服务端实际模型与沙箱。
- Windows 默认从正在运行的 Codex 桌面进程找到其实际 app-server 可执行文件，不按缓存目录时间猜版本；可用 `CODEX_ADVISOR_CODEX_BIN` 显式指定。运行时不支持 `project/list` 时，在创建线程和推理之前返回 `APP_SERVER_UNSUPPORTED`。
- `project/list` 按真实项目根匹配唯一项目，`thread/start` 携带该原生 `projectId`，并回读确认；未登记目录或多个项目共用根时分别返回 `PROJECT_NOT_FOUND` / `PROJECT_AMBIGUOUS`。普通问询用 `turn/start`，Git 审核用同线程的 `review/start`。
- 从 `item/completed` 收正文，从 `thread/tokenUsage/updated` 收真实用量；只有 `turn.status=completed` 且有正文才算问询成功。
- 返回 `sidebar.{projectId,projectName,visibleInProject,visibleInDefaultList,source,cwd,historyMode}` 和 `desktop`；按原生项目 ID 查询不到本次线程时返回 `SIDEBAR_NOT_VISIBLE`，正文和线程 ID 仍保留。
- Windows 默认使用桌面运行时成功创建并回读项目成员后，会调用桌面注册的 `codex://` 协议请求打开该线程。`desktop.requested=true` 表示协议已被系统接受；`--no-open-in-codex` 可禁用本次请求。旧桌面工具返回的 legacy 项目 ID 与新版 canonical ID 不同，不能混用。
- 标题以 `DSH plan/review/ask ·` 开头。无需退出 Codex，不修改历史 rollout 或数据库。
- 每次调用创建新线程；`--conversation` 继续按本机台账回放历史正文。结束时关闭独立 app-server，超时只终止本次子进程树，宽限期未确认退出则返回 `cleanup: unconfirmed`。
- 官方协议：[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 为什么是 DSH 注入上下文

此前 `codex exec` 路线实测 Windows 只读沙箱无法启动子进程；本次 app-server 迁移保留由 DSH 注入上下文的机制，不要求顾问自行运行命令。

```text
codex exec -s read-only ...  →  CreateProcessAsUserW failed: 5 / 拒绝访问
```

于是顾问读不到任何文件，第一轮真实审核直接回复「无法完成基于证据的审核」。与其让顾问空转，
不如由 DSH 把真实文件读好放进提示词：

- `--paths` / `--context` 指到的文件与目录由 DSH 读取，按预算拼成「参考资料」段；
- 单文件 20 000 字符、总量 80 000 字符上限，超了截断并标注；
- 只接受工作区**真实路径**（解析符号链接/junction 后比较），越界一律跳过并记录原因；
- 二进制、缺失、不可读、超预算都会出现在 `context.skipped` 里，不静默吞掉。
- 顾问仍然恒定只读：它拿到的只是文本，改不了任何东西。

## 怎么触发（不设全局规则）

**不加全局指令、不自动评审**。只有你明确点名才用，一句话就够：

```text
调用codex，6.1sol，来执行任务<XXX>
调用codex 来审核 src/advisor.mjs
调用codex，terra，给 <方案> 出计划
```

| 你说的 | 实际发生 |
| --- | --- |
| 只说「调用 codex」 | 模型默认 **terra（`gpt-5.6-terra`）** |
| 带模型写法（`6.1sol` / `terra` / `luna` / 完整模型名） | 用你给的；口语写法自动规范化 |
| 「出计划 / 给方案」 | `plan` |
| 「审核 / 检查 / 挑毛病」 | `review`（有 git 仓库且指改动 → `review --diff`） |
| 「问一下 / 为什么」 | `ask` |

**推理强度默认不动**：不传 `--effort`，沿用 Codex 自己配置的 `high`。只有你说「快一点 / 随便看看」才降到 `low`/`medium`。

## 可选：MCP 原生工具

`mcp/server.mjs` 把同一套核心包成 stdio MCP，工具名 `codex_plan` / `codex_review` / `codex_ask`，零依赖。

**默认不启用**：DSH 侧接入需要改配置并重启宿主。命令行路线已经够用，是否升级由你决定。接入后原生工具的返回体与命令行 JSON 完全一致。

```powershell
# 手工试一下握手是否正常
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node mcp\server.mjs
```

## 安全与边界

- **只读是硬约束**：`thread/start` 固定 `sandbox: read-only` / `approvalPolicy: never`；服务端返回非只读或网络放行时，立即停止，任务内容不发送。`--dry-run` 可以审计命令和 RPC 请求。
- **不经 shell**：所有参数走 argv 数组。Windows 上只找到 `codex.cmd` 而没有对应 `codex.js` 时**直接失败关闭**，不退回 `shell: true` 拼接（那会让 `--base` 之类的值变成命令注入面）。
- **上下文越界防护**：路径比较基于 `realpath`，工作区内的符号链接 / junction 指向外部时会被拒绝。
- **提示词双重声明**：即使沙箱被绕过，角色契约也写明「不许改文件、不许改变状态」。
- **模型名白名单**：只接受 `[A-Za-z0-9._:-]`。
- **台账不出本机**：正文与记录都落在本机目录，不上传、不发外部消息。
- **台账只增不减**：`sessions.jsonl` 每轮追加一行、`texts/` 每轮存一份正文，约 0.8 KB/次（1 万次量级约 8 MB）。没有自动轮转——需要清理时直接删 `%LOCALAPPDATA%\codex-advisor` 下的旧 `texts/*.md` 或改用 `--ledger <新目录>`，不影响 Codex 侧任何数据。
- **上下文会发给模型提供商**：注入的内容会随提示词发给所选模型；涉密文件不要 `--context`。
- 本包不是 OpenAI / DeepSeek 官方产品。

## 已验证 / 未验证

在制作机（Windows、Node `v24.19.0`、桌面 Codex CLI `0.163.0-alpha.10.2`（npm CLI 为 `0.147.0`）、DSH `0.2.1-alpha.2`）实测：

- ✅ 真实问询：默认 `gpt-5.6-terra`，约 9 秒返回预期短句，输入约 2.5 万 token；独占 app-server 子进程退出已确认。
- ✅ 新会话落态：`source=vscode`、`historyMode=paginated`，并带原生 `projectId`；按项目 ID + cwd + 默认来源过滤的 `thread/list` 读回通过。
- ✅ 自动侧栏端到端：新线程完成后 `desktop.requested=true`，桌面端可访问性树确认该会话位于对应项目下。
- ✅ 回归测试 23 项：本机全部通过（含无符号链接权限时自动跳过的那 1 项）。覆盖只读与模型回读、桌面原生协议请求、RPC 错误、提前退出、部分正文后失败、超时、列表缺失、多轮、上下文、三种 Git target、MCP 握手、旧运行时拒绝、项目分页、项目缺失与歧义、错误归属拒绝。
- Git 审核的 RPC 路由由协议替身覆盖；未在真实模型上跑过完整 Git 审核。
- `--workspace` 必须是目标项目根；不会自动在桌面新增项目。
- `--conversation` 是正文回放，每轮仍创建新 Codex 线程。
- 模型额度不足或满载如实报错，不静默换模型；耗时和 token 随模型、技能及上下文变化。
- 未验证：MCP 在 DSH 的真实挂载、其他 Codex 版本及非 Windows 平台。

## 目录结构

```text
src/advisor.mjs       CLI、上下文与台账
src/app-server.mjs    JSON-RPC、只读线程、回合/审核事件、默认列表校验、进程收口
src/desktop.mjs       Codex 桌面原生协议请求
src/prompts.mjs       角色契约、模型预设、三类任务的输出要求
src/context.mjs       上下文注入（realpath 边界、预算、跳过原因）
src/ledger.mjs        台账读写（sessions.jsonl + texts/）
mcp/server.mjs        可选 stdio MCP 包装（codex_plan / codex_review / codex_ask）
skills/codex-advisor/ 给 DSH 的技能：什么时候问、怎么问、怎么验收
tests/                假 app-server 替身 + 23 项测试
```

## 许可

MIT。本包不是 OpenAI / DeepSeek 官方产品。

---

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)


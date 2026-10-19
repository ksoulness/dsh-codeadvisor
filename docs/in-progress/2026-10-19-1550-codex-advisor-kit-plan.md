# Codex Advisor Kit（反向问询项目）实施方案

- 创建：2026-10-19 15:50（Asia/Singapore, UTC+08:00）
- 开始实施：2026-10-19 15:52
- 状态：侧栏接入已完成；MCP 原生挂载及宿主重启验收仍由用户决定
- 位置：`E:\Code\codex-advisor-kit`（与 `E:\Code\DSH` 同级，独立仓库）

## 1. 目标与验收

**目标**：参照 [`ksoulness/dsh-codex-kit`](https://github.com/ksoulness/dsh-codex-kit)（Codex 主控 → DSH 执行）做**反向**：DSH 主控与执行，Codex 只做计划与审核。用户可以「调用 DSH 去 Codex 建对话」，由 DSH 指定模型、拿回计划/审核意见，然后 DSH 自己动手。

**验收标准**：

| # | 验收项 | 判定方式 |
| --- | --- | --- |
| A1 | 三个动作可用：`plan` / `review` / `ask` | 单元测试 + 真实调用 |
| A2 | Codex 恒定只读，物理上无法落地改动 | 断言命令含 `-s read-only`，且无任何 bypass 参数 |
| A3 | 每次开新对话并记录线程 id | 返回 `threadId`，台账 `sessions.jsonl` 有该记录 |
| A4 | 多轮延续可用 | `--conversation` 回放上一轮正文（不依赖 `resume`） |
| A5 | 结构化结果含真实用量 | `usage.{inputTokens,outputTokens,...}` 来自 `turn.completed` |
| A6 | 失败/超时如实报错，不编造答案 | `ok:false` + `error.code`；超时收进程树 |
| A7 | 测试全绿 | `node --test` 9/9（修复顾问指出的 3 条问题后增至 15 项，见 §7.2） |
| A8 | DSH 侧有技能说明，新会话可自动识别 | 技能装入 `$DSH_HOME\agents-home\skills` |

## 2. 本轮前置调查（已完成）

| 事实 | 证据 |
| --- | --- |
| `codex exec --json` 可用，exit 0 | 真实调用 3 次，`ADVISOR_SMOKE_OK` / `PROBE_ONE` |
| JSONL 契约：`thread.started.thread_id`、`turn.completed.usage.*` | 抓取原始 stdout |
| `-o/--output-last-message` 给出干净正文 | 同上 |
| `exec review --uncommitted` **不能**与 PROMPT 同用 | `error: the argument '--uncommitted' cannot be used with '[PROMPT]'` |
| `exec review` 接受 `--json` | 同一条报错的 Usage 行含 `--json` |
| **`exec resume` 在本机不可用** | 所有 `CODEX_HOME\thread-writer-locks\*.lock` 均被桌面端进程持有；resume 报 `thread already has an active writer` |

→ 结论：多轮不能靠 Codex 线程续接，必须自建台账回放。这是本项目与参照项目最大的设计差异。

## 3. 范围与授权

- 只新建 `E:\Code\codex-advisor-kit`，不修改 `E:\Code\DSH` 的任何文件。
- 不修改 Codex 的 `config.toml`、不安装 Codex 插件。
- 不启用 MCP 原生工具路线（需重启 DSH 宿主，本轮不做，仅留文件）。
- 技能安装到 `$DSH_HOME\agents-home\skills\codex-advisor`（新增目录，不覆盖同名技能）。

## 4. 实施步骤

| # | 步骤 | 依赖 | 验收 |
| --- | --- | --- | --- |
| S1 | 建目录骨架、`package.json`、`.gitignore` | — | 目录存在 |
| S2 | `src/prompts.mjs`：角色契约 + 模型预设 + 三类输出要求 | S1 | `node --check` |
| S3 | `src/ledger.mjs`：台账读写 | S1 | `node --check` |
| S4 | `src/advisor.mjs`：CLI + 只读参数 + JSONL 解析 + 超时 + 回放 | S2,S3 | `node --check`；`--dry-run` 参数正确 |
| S5 | `mcp/server.mjs`（预留） | S4 | 握手返回 3 个工具 |
| S6 | 测试：假 codex 替身 + 9 项 | S4,S5 | `node --test` 9/9（最终 15 项） |
| S7 | 技能 `skills/codex-advisor/SKILL.md` | S4 | 文件存在、格式与现有技能一致 |
| S8 | README / PROJECT.md / 触发约定 | S7 | 无占位符、无失效链接 |
| S9 | 真实 Codex 端到端调用 | S4 | `ok:true` 且有可用正文 |
| S10 | 装技能、git init、清理临时目录 | S9 | 技能目录存在；仓库干净 |

## 5. 回退

- 全部为本轮新建文件，回退 = 删除 `E:\Code\codex-advisor-kit` 与 `$DSH_HOME\agents-home\skills\codex-advisor`。
- 不触及任何原有文件，因此无备份需求。
- 真实调用只消耗 Codex 配额，不改任何工程状态（只读沙箱）。

## 6. 验证记录

（见下方「结果」）

## 7. 结果

| # | 结果 | 证据 |
| --- | --- | --- |
| A1 | ✅ | `node --test` 15/15；真实 `review` 与 `plan` 调用均成功 |
| A2 | ✅ | 测试断言命令含 `-s read-only` 且无 `bypass` 子串；`--dry-run` 可审计 |
| A3 | ✅ | 返 `threadId`；台账记录 `threadId` |
| A4 | ✅ | 测试「同一 conversation 第二轮带上上一轮正文」通过；真实 `--conversation next-steps` 落台账 |
| A5 | ✅ | 真实调用 `usage.inputTokens=78442 / 85223 / 190371` |
| A6 | ✅ | 测试 fail 模式 → `CODEX_EXIT`；sleep 模式 → `TIMEOUT` + `cleanup` 如实标记 |
| A7 | ✅ | 15 pass / 0 fail |
| A8 | ✅ | `$DSH_HOME\agents-home\skills\codex-advisor\SKILL.md` 已装 |

### 7.1 实施中发现的真实障碍（改变了架构）

| 发现 | 处置 |
| --- | --- |
| **Codex 0.147.0 的 Windows 只读沙箱起不了子进程**（`CreateProcessAsUserW failed: 5 / 拒绝访问`），顾问读不到任何文件，首轮真实审核直接回「无法完成基于证据的审核」 | 新增 `src/context.mjs`：由 DSH 读真实文件注入提示词（单文件 2 万 / 总量 8 万字符预算），并在角色契约里告知顾问「命令可能失败，直接基于参考资料回答」 |
| Windows 上 `codex` 是 npm `.cmd` 垫片，Node `spawn` 直接起会 ENOENT | `resolveCodex()` 优先 `codex.exe`，其次把垫片解析成 `node <npm>/node_modules/@openai/codex/bin/codex.js` |
| 真实模型目录只有 5 个（`gpt-5.6-sol/terra/luna`、`gpt-reserve`、`codex-auto-review`），`gpt-6.1-sol` 不在目录内 | 预设改为 `sol`(=6.1，本机日常) / `sol56` / `terra` / `luna`，并在 README 里写明 |

### 7.2 闭环自证：第一版代码交给顾问审核 → 修掉

`review` 首轮给出 **3 条阻塞问题**，DSH 逐条核对源码确认全部成立后修复：

| 顾问指出的问题 | 核对结果 | 修复 |
| --- | --- | --- |
| `shell: true` 回退 + `quoteForShell` 只处理空格 → `--base/--commit` 含 `&` 可注入命令 | 成立 | 删除 shell 分支，改为失败关闭（`CODEX_UNRESOLVED`），并加测试 |
| 超时只发终止、Promise 仍等 `close`，清理失败会永久挂起，却宣称「已终止」 | 成立 | `terminateTree()` 可等待；5 秒宽限期强制收口；结果新增 `cleanup: confirmed\|unconfirmed` |
| `context.mjs` 的 `isInside` 是字符串比较，`statSync/readFileSync` 跟随符号链接 → junction 可带出工作区外文件 | 成立 | 改用 `realpath` 双向比较，遍历出的文件再复核一次；加符号链接逃逸测试 |

修复后 `node --test` 从 10 项增至 15 项，全绿。

### 7.3 触发方式与默认模型的变更（2026-10-19 17:4x，用户决定）

- **不加全局路由**：删除 `docs/routing-policy.md`，触发约定只写在技能里；未点名「调用 codex」不调用。
- **默认模型改为 terra**（`gpt-5.6-terra`）；用户带模型（如 `6.1sol`）就用他的。新增 `normalizeModel()` 做口语写法规范化，测试覆盖 9 种写法。
- **推理强度默认不指定**，沿用 Codex 自身配置（本机 `high`）；只有用户说「快一点」才降级。
- 验证：`node --test` 17/17；`--dry-run` 确认无 `--model` 时为 `gpt-5.6-terra`、无 `model_reasoning_effort` 参数；**默认 terra 真实调用通过**（21s，`TERRA_DEFAULT_OK`）。

### 7.4 DSH 创建的 Codex 会话进入项目列表（2026-10-19）

- 用户新增目标：从 DSH 调用顾问后，会话原生出现在 Codex 左侧对应项目对话区。
- 授权范围：本项目调用入口、回归测试、说明和 DSH 已安装技能；不修改历史 rollout、数据库、Codex 配置，不退出或重启桌面端。
- 验收：`thread/start` 创建持久、paginated、只读会话；`turn/start` 与 `review/start` 保留原功能；新会话通过无 sourceKinds 的 `thread/list` 且 cwd 对应已登记项目；返回 threadId、正文和真实 usage。
- 2026-10-19（本轮）：官方文档与本机 0.147.0 生成类型均确认新建方法为 `thread/start`；无来源环境变量的独立 app-server 实测 ephemeral 会话 source=vscode、historyMode=paginated、sandbox=readOnly/networkAccess=false。proxy initialize 超时，实施使用独立 stdio app-server。
- 最小步骤：替换 exec 传输 → 覆盖 RPC 失败/超时/只读/审核测试 → 一次真实短问询并从默认项目列表读回 → 同步技能与必要维护说明。
- 修改前源码与说明已备份至 `.local/before-app-server-20261019/`；回退为逐文件恢复，不涉及会话数据。
- 2026-10-19 17:17:20 +08:00：实现与短时验证完成；`node --test` 20 项中 19 通过、1 项因文件符号链接权限跳过，`npm run check` 通过。
- 真实默认 terra 问询：约 14,991 ms，线程 `01a15370-07c3-76c3-bc4a-01fe99029f2b`，返回 `DSH_SIDEBAR_OK`；输入 24,773 / 输出 11 token；独立 app-server 退出已确认。未设置 Codex 来源环境变量，服务端仍返回 source=vscode / paginated / cwd=E:\Code\DSH，默认来源项目 cwd 列表命中。
- 桌面 `list_threads` 已读到新线程，`read_thread` 能读到 completed 回合与正文；但 `projectId=null`，原生 `move_thread_to_project` 返回 `The task's source project could not be safely determined.`，未成功移动。已通过异步问题请用户确认实际分组；不再尝试绕过该检查。
- 源技能、DSH 已安装技能及 E 侧镜像 SHA-256 一致（87E00BA4…10C7C9F）；已更新 README、PROJECT 与自制资产清单。
- 状态：调用链实施完成，等待桌面实际项目分组验收（V5）；尚不能宣告本次完整目标完成。

### 7.5 桌面项目归属修复（用户确认首轮未见后）

- 2026-10-19 17:18–17:24 +08:00：继续核验。npm CLI 是 0.147.0，当前桌面子进程实际为 0.163.0-alpha.10.2。两版生成类型实证：新版增加 project/list、thread/start.projectId、thread/metadata/update.projectId 和 thread/list.projectId，旧版无此能力。上轮只按 cwd 验收不足。
- 新版 project/list 读出 DSH 原生项目 ID `01a0b19b-880a-7c22-829a-42ea77a54f9d`，roots=[E:\Code\DSH]；桌面工具列出的 legacy 项目 ID 是另一命名空间，不混用。
- 已实施：Windows 从桌面主进程拥有的 codex.exe 找实际运行时；先 project/list 动态匹配真实根且必须唯一；thread/start 携带 projectId，发任务前回读确认；最终按项目 ID + cwd + 默认来源查成员。旧 CLI、缺失项目、歧义项目或错误归属均失败关闭，不能回退为仅 cwd 匹配。
- 旧 native move 工具曾无法判断来源。新版 thread/read 已明确读取首轮验收线程为 projectId=null、cwd=E:\Code\DSH，并确认目标项目根唯一，消除了原先来源不明的条件；随后仅用新版受支持的 thread/metadata/update 给这条本轮测试线程补归属。修改后 thread/read 与 DSH 成员列表读回一致。未修改任何其他历史线程。
- 真实新问询 `01a15378-7903-7a10-8b17-7184ad450fb6`，默认 terra，8,917 ms，返回 DSH_PROJECT_OK；输入 24,760 / 输出 8 token；projectId 与 DSH 一致，visibleInProject=true，进程退出 confirmed。
- 回归测试 22 项：21 通过、1 项因文件符号链接权限跳过；静态检查通过。实际旧 CLI 探针确认在 project/list 即拒绝（threadId=null、未推理）；已按其真实 -32600 unknown variant 错误格式补齐说明与测试，相关 2 项测试通过。
- 本轮修改前代码备份 `.local/before-project-assignment-20261019/`；无需重启。程序不硬编码实测项目 ID，不改数据库/rollout/桌面配置。
- 已再次异步请用户切换项目后确认标题含 DSH_PROJECT_OK 的新验收会话；尚未收到确认，不能以 API 归属成功宣告界面验收通过。
- 2026-10-19 17:28 +08:00：只读检查当前 app.asar 内项目代码，确认桌面同时维护 canonical→legacy 映射及受 localProjectTaskMembership 条件控制的成员同步；未读取或修改状态文件/功能开关。桌面原生工具对新线程仍返回 projectId=null，移动工具仍无法确定源项目；因此后台归属已通过，但不能保证当前桌面缓存已采纳。等待用户第二次界面反馈，未操作 GUI。旧 CLI 失败路径实际复验已为 APP_SERVER_UNSUPPORTED / threadId=null。
- DSH 安装技能与 E 侧镜像已再次同步，三份 SHA-256 相同（1D916E30…A5D45FE）。

### 7.6 第二次侧栏验收失败与 GUI 检查

- 2026-10-19 17:49:42 +08:00：用户第二次明确反馈仍然看不到。§7.5 只完成服务端项目归属，不满足原始侧栏验收；状态修正为部分完成，不再写成仅待确认。
- 用户明确授权本次仅操作 Codex 窗口：搜索两条测试会话、检查侧栏与原生菜单，可归入已核验 DSH 项目；不发送消息、不重启。
- Computer Use 可访问性树实证：当前 Codex 模式、DSH 项目已展开，成员包括本聊天和现役其他 DSH 聊天，确无 DSH_SIDEBAR_OK / DSH_PROJECT_OK 两条验收会话。
- GUI 通道限制：截图先后 FrameArrived timed out / window capture timed out；按钮点击返回 coordinate input geometry is unavailable；set_value 在刷新后仍返回 element no longer exists。未重复盲点或另造 UIA 客户端。原生 navigate_to_codex_page 虽返回 navigated=true，但界面未确认打开测试会话，不作为成功证据。
- app-server daemon version 只读查询返回 F:\data\CodexData\app-server-control\app-server-control.sock 连接失败，os error 10050；未启动、重启或修改 daemon。
- 窗口随后切到另一 DSH 聊天并出现编辑项目对话框；无法归因于用户或其他任务操作，立即停止输入。已异步询问是否用户正在操作；只有答复后再继续相关 GUI 检查，现有本次 GUI 授权不重复索取。
- 顾问接口 ok=true 仅表示顾问问询与服务端项目列表回读成功；visibleInProject 是服务端成员列表命中，当前已被 UI 实证为不足以保证侧栏显示。原始自动显示目标未完成。

### 7.7 原生协议触发桌面采纳（2026-10-19）

- 用户确认可以继续 GUI 检查后，撤销未保存的编辑项目对话框；未发送消息、未重启，也未修改数据库、rollout 或桌面状态文件。
- 实测桌面注册 `codex://threads/<id>?hostId=local` 后，原先两条验收会话均由可访问性树读到 DSH 项目列表。由此定位桌面采纳的必要步骤为原生协议请求，而不是手改持久化数据。
- 实现 `src/desktop.mjs` 并接入 `advisor.mjs`：仅当 app-server 已确认 `sidebar.visibleInProject=true` 的成功调用，且 Windows 默认发现桌面运行时时，自动请求该协议；结果写入 JSON/台账 `desktop`。`--no-open-in-codex` 可禁用单次请求。
- 独立端到端验收：新线程 `01a153c4-4d64-70b1-8eca-ca3bb8ac620a` 返回 `DSH_AUTO_SIDEBAR_OK`，服务端回读 `projectName=DSH`、`visibleInProject=true`，`desktop.requested=true`；随后可访问性树直接读到该条位于 `DSH中的已安排任务`。耗时 8,652 ms，输入 24,766 / 输出 12 token。
- 验证：新增原生协议触发单测；共 23 项测试中 22 通过、1 项因本机没有创建文件符号链接权限跳过；`npm run check` 通过。V5 已通过。

## 8. 用户触发的验证与待授权事项

| ID | 对象 | 动作 | 授权缺口 | 依赖 |
| --- | --- | --- | --- | --- |
| V1 | DSH 0.2.1-alpha.2（3079 会话） | 重启宿主后确认 `codex-advisor` 技能出现在技能目录 | 重启会中断当前会话后端，需用户自行触发 | A8 |
| V2 | `mcp/server.mjs` | 以 MCP 原生工具（`codex_plan`/`codex_review`/`codex_ask`）挂进 DSH 配置 | 需修改 profile 配置并重启宿主，本轮未授权 | V1 |
| V3 | ~~`docs/routing-policy.md` 合并进全局指令~~ | **用户已决定：不加全局规则**，改为技能内的显式触发约定（「调用 codex」+ 可选模型），默认 terra | 已闭环，无需授权 | — |
| V4 | 台账目录 | 确认默认落点 `%LOCALAPPDATA%\codex-advisor` 是否可接受（或改到别处） | 仅确认，无风险 | — |
| V5 | 自动进入桌面 DSH 项目侧栏 | 已通过：原生项目归属回读后自动请求 `codex://`，新验收线程已由可访问性树确认在 DSH 项目下 | 已闭环 | — |

### 8.1 `plan` 顾问指出的挂载前必须先解决的问题（尚未实施）

`plan --conversation next-steps` 给出的判断，DSH 记录为待决定项，不擅自实施：

| # | 问题 | 现状 | 挂载 MCP 前需要的动作 |
| --- | --- | --- | --- |
| D1 | MCP 层没有工作区授权：调用者可指定任意 `workspace` | `tools/call` 直接透传给 `runAdvisor()`，schema 不是运行时授权边界 | 在 MCP 层加允许工作区清单，越权拒绝后再进核心 |
| D2 | MCP 层没有参数校验：未知字段/错误类型照样进核心 | 仅 `runAdvisor()` 内部校验 kind/model/effort | MCP 层按 schema 校验后再调用 |
| D3 | 递归风险：子 Codex 若加载同一顾问 MCP 可能自我调用 | 未证明会发生，也未证明已隔离 | 挂载前确认子进程的工具可见性 |
| D4 | 超时预算：核心默认 900 秒，MCP 层无取消转发 | 宿主超时 < 900 秒时会出现「宿主已放弃、Codex 还在跑」 | 宿主工具超时需 ≥ 900 秒 + 5 秒宽限 + 余量，或下调核心默认 |
| D5 | MCP 层没有在途任务管理 | 守护进程重启不会终止已起的 Codex 子进程 | 需要时再加单实例/在途登记；本轮不做 |


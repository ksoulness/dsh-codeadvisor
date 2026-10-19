---
name: codex-advisor
description: 仅在本机 DSH 被用户明确点名「调用 codex」时使用：调本机 Codex CLI 的指定模型开新对话，只做计划与审核，绝不落地改动；所有执行仍由 DSH 完成。未点名时不要主动调用。
metadata:
  scope: personal-local-dsh
  host: DESKTOP-JCAJDQ3
  kit: E:\Code\codex-advisor-kit
---

# Codex 只读顾问

本技能只适用于本机（Windows `DESKTOP-JCAJDQ3`）个人 DSH。它把「另一个模型怎么看」接进来，而**不把执行权交出去**：Codex 在只读沙箱里出计划和审核意见，DSH 负责一切实际改动与验证。

## 触发方式：只有用户点名才用

**不设默认路由**。用户没有明确说「调用 codex / 问一下 codex / 让 codex 看看」时，不要调用本技能，也不要因为任务看起来重要就自动加一轮评审。

用户的一句话通常长这样：

```text
调用codex，6.1sol，来执行任务<XXX>
调用codex 来审核 <文件或改动>
调用codex，terra，给 <方案> 出计划
```

解析规则：

| 用户说了什么 | 你怎么做 |
| --- | --- |
| 只说了「调用 codex」 | 模型用 **terra（`gpt-5.6-terra`）**，这是默认 |
| 带了模型写法（`6.1sol` / `terra` / `luna` / `sol56` / 完整模型名） | 用他给的那个，口语写法由 `--model` 自动规范化 |
| 说了「出计划 / 给方案」 | 用 `plan` |
| 说了「审核 / 检查 / 挑毛病 / 看看这段改动」 | 用 `review`；有 git 仓库且指的是改动 → `review --diff` |
| 说了「问一下 / 这是什么原因」 | 用 `ask` |

**没写清是计划还是审核时**：按任务本身判断（要动手前 → `plan`；已实现 → `review`），并在回复第一句说明你选了哪个、为什么，不要反问。

**推理强度**：默认不指定，沿用 Codex 自己的配置（本机是 `high`）。只有用户明确说「低强度 / 快一点 / 随便看看」才加 `--effort low` 或 `medium`；说「好好想想 / 高强度」加 `--effort high`。不要每次自作主张改这个旋钮。

## 一条命令

```powershell
node E:\Code\codex-advisor-kit\src\advisor.mjs <plan|review|ask> --workspace <项目根> --model <terra|sol|6.1sol|luna> --paths "<文件或目录>" --task "<任务>"
```

`--paths` 指向的文件/目录会由 DSH 读进上下文（默认单文件 2 万字符、总量 8 万字符上限）。
输出是一段 JSON：`ok / model / threadId / sidebar / desktop / usage / context / text / textFile / error`。正文在 `text`，同时落盘到 `textFile`。

常用变体：

```powershell
# 审核当前 git 未提交改动（不需要写提示词）
node E:\Code\codex-advisor-kit\src\advisor.mjs review --diff --workspace <项目根> --model terra

# 多轮：同名 --conversation 会回放上一轮正文
node ... plan  --workspace <根> --conversation my-design --task "第一轮：出方案"
node ... review --workspace <根> --conversation my-design --task "第二轮：挑毛病"

# 长任务描述走文件，避免命令行转义
node ... plan --workspace <根> --task-file .\task.md
```

## 硬规则

1. **只读是协议硬约束**：入口通过独立 `codex app-server` 调 `thread/start`，固定 `sandbox: read-only` / `approvalPolicy: never` / `historyMode: paginated`，发送任务前回读实际权限与模型；禁止 bypass、修改 rollout 或数据库。
2. **顾问读不到你的文件，是 DSH 喂给它的**。本机 Codex 的 Windows 只读沙箱起不了子进程，它无法自己 `cat` 任何东西。所以必须用 `--paths` / `--context` 把真正的文件内容带进去，否则它只会回你「无法审核」——那不是它的问题，是没给上下文。
3. **每轮新建线程，多轮用 `--conversation` 回放正文**，不争抢桌面端旧线程 writer lock。`--workspace` 必须传当前项目根，路径与桌面已登记项目目录一致；标题以 `DSH plan/review/ask ·` 开头。入口先用新版 `project/list` 匹配唯一项目，再在 `thread/start` 写入并回读 `projectId`。Windows 默认使用正在运行的桌面端运行时；旧 npm CLI 缺少项目协议时直接返回 `APP_SERVER_UNSUPPORTED`。
4. **顾问的结论不是证据**。它说「这个函数在第 42 行有 bug」，DSH 必须自己打开文件核对后再动手；核对不上的部分标注「未验证」，不得当成事实转述给用户。本工程自身的 3 条阻塞问题就是这么查出来并修掉的——先核对，再改。
5. **执行权不转移**。Codex 出计划 → DSH 判断可行性 → DSH 动手 → DSH 验证。任何一步都不许改成「Codex 说做完了」。
6. **模型不可用如实报**：`terra` 报 `Selected model is at capacity` 时，把原话告诉用户并问要不要换 `sol`，不要静默换模型。
7. **成本**：耗时与 token 随模型、技能和上下文变化，按返回 `elapsedMs` / `usage` 报告；本次带项目归属的短问询约 9 秒、24,760 输入 token。`--conversation` 回放历史正文，每轮仍创建新线程。
8. **项目列表验收**：成功问询后按默认来源过滤 + 原生 `projectId` + `cwd` 查询 `thread/list`，回读同一项目 ID 才设 `sidebar.visibleInProject=true`，查不到返回 `SIDEBAR_NOT_VISIBLE`；随后默认请求桌面注册的 `codex://` 协议打开这条线程。`desktop.requested=true` 表示该请求已被系统接受；`--no-open-in-codex` 可对单次调用禁用。`PROJECT_NOT_FOUND` 时先在桌面添加项目或纠正 `--workspace`，不静默创建项目或退回仅 cwd 匹配。
9. **桌面侧栏已实测**：本机 0.163.0-alpha.10.2 上，原生协议请求后新验收会话已由 Codex 可访问性树确认位于 DSH 项目侧栏。其他桌面版本不能由这次实测外推，必须如实报告 `desktop` 和 `sidebar` 的返回值。
10. **失败如实报**：`ok:false` 时把 `error.code` 和 `error.message` 原样呈现，不要自己脑补答案代替它。超时结果里的 `cleanup: unconfirmed` 也要照实说。

## 交付格式

回复用户时给三块，不要只贴 JSON：

1. 用了哪个模型、哪一轮对话、耗时与用量；
2. 顾问的结论摘要（计划要点 / 阻塞问题条数）；
3. DSH 自己的判断：哪些采纳、哪些核验不通过、接下来实际做什么。

完整正文按需给路径（`textFile`），不要把几万字原样贴进聊天。

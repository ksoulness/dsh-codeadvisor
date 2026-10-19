# PROJECT — Codex Advisor Kit

DSH 主执行 + Codex 只读顾问。参照 [`ksoulness/dsh-codex-kit`](https://github.com/ksoulness/dsh-codex-kit) 做反向：由 DSH 去 Codex 开新对话，让指定模型出计划与审核，执行仍归 DSH。

- 仓库根：`E:\Code\codex-advisor-kit`
- 运行时：Node.js ≥ 22.19，零依赖；依赖本机 `codex` CLI（实测 0.147.0）
- 入口：`node src\advisor.mjs <plan|review|ask> --workspace <根> --model <sol|terra> --task "<要求>"`
- 台账：`%LOCALAPPDATA%\codex-advisor\{sessions.jsonl,texts\}`

## 硬约束

1. Codex 恒定 `read-only`，代码里没有任何 bypass 分支；也绝不经 shell 拼参数。
2. 不用 `codex exec resume`（本机被桌面端 writer lock 占用），多轮用 `--conversation` 台账回放。
3. 顾问读不到文件——本机 Codex 只读沙箱起不了子进程，上下文必须由 DSH 读取注入。
4. 顾问结论不是证据，DSH 必须自己核对后再动手。

## 文档索引

### 进行中
- [Codex Advisor Kit（反向问询项目）实施方案](docs/in-progress/2026-10-19-1550-codex-advisor-kit-plan.md) —— 2026-10-19，部分完成；桌面侧栏验收失败，继续诊断

### 参考
- [README](README.md)
- 触发约定只在技能 `skills/codex-advisor/SKILL.md` 里，不写进 DSH 全局指令；用户点名「调用 codex」才用，默认模型 terra。

## 变更记录

- 2026-10-19 15:50 建立工程；核心 CLI + MCP 预留 + 技能 + 测试 + 文档。
- 2026-10-19 16:05 处理实际障碍：Windows `.cmd` 垫片解析、Codex 只读沙箱无法执行命令→改为 DSH 注入上下文、模型预设对齐真实目录。
- 2026-10-19 16:35 第一版交顾问审核，确认并修掉 3 条阻塞问题（shell 注入面、超时未收口、上下文链接逃逸）；测试 10 → 15 项全绿。
- 2026-10-19 17:10 真实 `plan` 调用产出下一步计划，挂载 MCP 前的 5 项待决定问题记入方案 §8.1。
- 2026-10-19 17:45 按用户决定调整触发方式：不加全局规则、改为「调用 codex」显式点名；默认模型改 terra、支持 `6.1sol` 等口语写法；推理强度默认不指定。测试 17/17，默认 terra 真实调用通过。

- 2026-10-19：顾问传输改为独立 app-server 的 `thread/start` + `turn/start/review/start`，保留只读与正文回放；真实问询、默认项目 cwd 列表及桌面聊天列表通过，实际项目分组待核验。详见原方案 §7.4；回退件 `.local/before-app-server-20261019/`。

- 2026-10-19：用户确认首轮侧栏未见后，查明 npm CLI 0.147.0 不支持项目协议，桌面实际为 0.163.0-alpha.10.2。入口改为识别当前桌面运行时，project/list 匹配唯一根，thread/start 写入原生 projectId，按项目成员列表验收。真实新问询通过；界面刷新待用户核验。

- 2026-10-19：第二次侧栏验收仍未显示，GUI 可访问性树已复核。后台服务端归属不是侧栏成功证据，任务改为部分完成；本次 GUI 已获授权，因输入通道不稳定且窗口出现未知来源编辑对话框暂停相关动作。

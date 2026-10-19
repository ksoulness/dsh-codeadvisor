# 给 AI agent 的安装说明

这一份是写给 AI agent 看的：**人类不需要自己动手，把下面第一段整段发给你的 AI，它就能装完并自检。**

---

## 一、直接粘给 AI 的那段话

```text
请帮我安装 DSH 技能 dsh-codeadvisor。它是 DeepSeek Harness（DSH）的「技能 + CLI」，不是插件、不是 npm 包。

请按顺序做，每步都把实际输出报给我：

1. 前置检查：Node.js >= 22.19；`codex --version` 能跑；该运行时支持 `app-server` 与 `project/list`
   （Windows 上优先用 Codex 桌面端自带的运行时，例如 %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe；
   缺 `project/list` 会在建线程前直接报 APP_SERVER_UNSUPPORTED，那就换运行时）。
2. 克隆仓库到临时目录：git clone https://github.com/ksoulness/dsh-codeadvisor.git <临时目录>
3. 安装技能：把 `<临时目录>/skills/dsh-codeadvisor` 整个目录复制到
   `%DSH_HOME%\agents-home\skills\dsh-codeadvisor`（非 Windows 用 $DSH_HOME/agents-home/skills/）。
   该目录自带 SKILL.md 与 CLI（src/、mcp/），装完即可用，克隆的临时目录可以删。
4. 自检并把结果报给我：
   - node "<技能目录>\src\advisor.mjs" --version      → 应输出 dsh-codeadvisor <版本号>
   - node "<技能目录>\src\advisor.mjs" ask --workspace "<我的项目根>" --dry-run --task "installed?"  → 应返回 "ok": true 且 "dryRun": true
   - node "<技能目录>\src\advisor.mjs" sessions        → 应打印台账路径，无记录也算正常
5. 不要做这些：不要当 DSH 插件安装、不要改 profile、不要 npm publish、不要手改技能目录里的源码
   （要改就改 git 仓库，再整目录覆盖安装）。
6. 装完告诉我：装到哪个路径、自检三步的实际输出、以及我以后该怎么触发它。
```

---

## 二、给 AI 的补充约束（收到上面那段之后再读）

### 边界

- **只装技能 + 保留 CLI**：复制 `skills/dsh-codeadvisor` 整目录即可，其中 `src/` 是 CLI、`SKILL.md` 是技能定义、`mcp/server.mjs` 是可选的 MCP 壳（默认不启用）。
- **不改宿主配置**：不写 `config.toml`、不动 profile、不挂 Web 前端、不要求重启宿主。装完新会话可见即可。
- **不发布**：`package.json` 带 `private: true`，禁止 `npm publish`。
- **不篡改**：技能目录是安装副本；要改代码改 git 仓库，再整目录覆盖。
- **不碰用户数据**：台账在 `%LOCALAPPDATA%\dsh-codeadvisor`（非 Windows：`~/.dsh-codeadvisor`），安装过程不要写、不要清。

### 装完必须自检（三项缺一不可）

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| CLI 可运行 | `node "<技能目录>\src\advisor.mjs" --version` | `dsh-codeadvisor <版本>` |
| 参数与协议装配正常 | `... ask --workspace "<项目根>" --dry-run --task "installed?"` | JSON 里 `"ok": true`、`"dryRun": true`；`command` 指向一个真实存在的 codex 可执行文件 |
| 台账可写可读 | `... sessions` | 打印台账绝对路径；空台账也正常 |

`--dry-run` 不消耗模型 token、不创建线程，用来验证装配；**不要**在安装阶段跑真实问询。

### 真跑一次（可选，装完由人类决定）

```powershell
node "<技能目录>\src\advisor.mjs" ask --workspace "<已登记为 Codex 项目的目录>" --model terra --task "只回复：READY"
```

`--workspace` 必须是 Codex 桌面端里**已存在的项目根**，否则会返回 `PROJECT_NOT_FOUND`（这是预期保护，不是装坏了）。

### 常见失败与含义

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `APP_SERVER_UNSUPPORTED` | 该 codex 运行时太旧，没有 `project/list` | 换新版运行时，或用 `CODEX_ADVISOR_CODEX_BIN` 指定 |
| `PROJECT_NOT_FOUND` | 目录没在 Codex 里登记为项目 | 先在 Codex 添加该项目，或传正确的 `--workspace` |
| `PROJECT_AMBIGUOUS` | 多个项目共用同一目录 | 精简 Codex 项目列表 |
| `CODEX_MISSING` / `CODEX_UNRESOLVED` | 找不到或无法确定 codex 可执行文件 | 设 `CODEX_ADVISOR_CODEX_BIN` 指向真实可执行文件 |
| `SIDEBAR_NOT_VISIBLE` | 线程建好但不在默认列表里 | 正文和 threadId 仍有效；检查桌面端版本与项目归属 |

---

## 三、装好之后怎么用（给人类看的一句话）

> 直接用自然语言点名即可：**「调用 codex，帮我审一下 `src/xxx.mjs`」**、**「让 codex 给这个重构出个计划」**、**「问一下 codex，这个报错什么原因」**。

DSH 会自己判断走 `review` / `plan` / `ask`、挑模型（默认 `terra`）、把相关文件读进上下文，然后由 DSH 自己执行和验收——Codex 那条线程恒定 `sandbox: read-only`，不会改任何文件。

不想要桌面弹窗，说一句「不用打开 Codex 窗口」（等价于 `--no-open-in-codex`）。

---

## 四、卸载

```powershell
Remove-Item -Recurse -Force "$env:DSH_HOME\agents-home\skills\dsh-codeadvisor"
```

台账留着不影响新装；要一并清掉再删 `%LOCALAPPDATA%\dsh-codeadvisor`。

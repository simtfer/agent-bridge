# agent-bridge

在 A 机用自然语言下发任务，交给 B 机上的 coding agent 执行；会话绑定一个目标（机器 + harness），长任务在关键节点停下来等人批准。

- **A 机**：`gateway`（任务/会话/收件箱 + JSON 状态文件）+ `tui`（终端收件箱）+ 任意 harness（opencode / pi / …）
- **B 机**：`runner`（常驻服务）+ adapter（`opencode` / `opencode serve` / `pi` / `echo`）+ 每任务独立 worktree
- **协议**：局域网 HTTP/HTTPS + SSE，token 鉴权；任务状态机 + gate 协议
- **可靠性**：Job Object 进程治理、并发队列、runner 崩溃后任务转 `interrupted` 并可恢复
- **平台**：Windows 10/11，不需要 WSL，不需要容器

## 架构

```
A（Windows）                                    B（Windows，无 WSL/容器）
┌──────────────────────────────┐               ┌────────────────────────────────┐
│ opencode/pi 会话              │               │ agent-runner（服务，账户 agent）│
│   │ MCP tools / CLI            │  HTTP+SSE     │   ├─ adapter: opencode         │
│   ▼                          │◄─────────────►│   ├─ adapter: pi               │
│ agent-bridge gateway         │  局域网 token  │   ├─ 进程树 / worktree 管理     │
│  sessions / tasks / inbox    │               │   └─ D:\agent-work\run_*        │
│  TUI（人工审批/插话）          │               │                                │
└──────────────────────────────┘               └────────────────────────────────┘
```

关键设计：

1. **会话绑定目标**：`session -> {runner, harness, model}`。任务继承 session 的 target，不能逐任务改。换 harness = 新开会话，避免错派。
2. **长任务不占进程**：agent 到达 gate 后输出一行 `<<<GATE {...}>>>` 并停止。`opencode run` 模式杀进程后用 `--session <id>` 恢复；`opencode serve` 模式保留服务端 session，直接发下一条消息。
3. **人工入口是 TUI**：任务列表 + 实时事件 + 审批卡片 + 插话输入行。人不在时问题留在 gateway，重开 TUI 自动补齐。
4. **结果以仓库为主**：worktree 是 `task/<runId>` 分支；stdout 只回摘要。
5. **runner 崩溃可恢复**：每个 run 落盘 `run.json` + `events.jsonl`，重启后 `running/queued` 转 `interrupted`，TUI 按 `R` 或 `agent-bridge resume` 继续。

## 快速开始（本机 loopback，5 分钟）

前置：Node.js ≥ 20、Git for Windows。先不接真实 harness，用 `echo` adapter 验证链路。

Job Object 是可选增强；仓库里已带 `bin/jobrun.exe`，如果拷到别的机器后缺失，在 B 上执行：

```powershell
pwsh -NoProfile -File scripts\build-jobrun.ps1
```

```powershell
cd D:\projects\a\agent-bridge
node bin/agent-bridge.mjs runner  --config config/runner.local.json
node bin/agent-bridge.mjs gateway --config config/gateway.local.json
```

另开一个终端：

```powershell
cd D:\projects\a\agent-bridge
$sid = node bin/agent-bridge.mjs session new --config config/client.json --to local/echo
node bin/agent-bridge.mjs submit --config config/client.json --session $sid "say hi"
node bin/agent-bridge.mjs tui --config config/client.json
```

TUI 键位：

| 键 | 动作 |
|---|---|
| `j` / `k` | 选择任务 |
| `Tab` | 跳到下一个待答任务 |
| `a` / `d` | 批准 / 拒绝 |
| `s` | 插话（steer） |
| `r` / `Enter` | 回答 clarification |
| `q` | 退出（任务继续跑） |

## 接真实 harness

### opencode

opencode 可以直接跑在原生 Windows 上（官方推荐 WSL，但原生可用）。runner 配置里指定默认模型：

```json
{
  "defaultModel": "opencode/deepseek-v4.1-flash-free"
}
```

然后：

```powershell
$sid = node bin/agent-bridge.mjs session new --config config/client.json --to local/opencode
node bin/agent-bridge.mjs submit --config config/client.json --session $sid "Reply with exactly OK"
node bin/agent-bridge.mjs watch --config config/client.json <taskId>
```

adapter 实际执行：

```
opencode run --format json --dir <workdir> --model <model> [--agent <agent>] [--session <id>] -- "<prompt>"
```

从 JSON 事件流里提取 `sessionID`、`text`、`tool_use`、`step_finish`，并归一化成 bridge 事件。

### pi

pi 原生支持 Windows，默认用 Git Bash 执行 `bash` 工具；需要先登录 provider（`pi /login` 或配置 API key）。adapter 使用：

```
pi --mode rpc [--session-id <id>] [--model <model>]
```

通过 stdin/stdout 的 JSONL 协议收发 `prompt` / `steer` / `abort`，事件包括 `message_update`、`tool_execution_*`、`agent_settled`。

runner 默认会解析 `pi.cmd` / `pi.ps1`，`.ps1` 通过 `pwsh -File` 启动。pi 未配置模型时会返回明确错误，不会挂住。

### opencode serve 模式（长会话 / 可中断）

默认 `opencodeMode: "run"`：每个任务起一个 `opencode run` 进程，gate 时杀进程、回答时 `--session` 恢复。适合简单、隔离的执行。

改成：

```json
"opencodeMode": "serve",
"opencodeServerPort": 4096
```

runner 会启动一个常驻 `opencode serve`，每个任务通过 `/session` 创建独立会话：

- 事件来自 `GET /event?directory=<workdir>`，归一化为 `delta/tool/usage/status`；
- gate 时**不杀进程**，session 保留在服务端，回答直接发下一条消息；
- 取消走 `POST /session/:id/abort`，不再依赖进程树；
- 恢复时直接用持久化的 session id 继续。

对比：

| | `run` 模式 | `serve` 模式 |
|---|---|---|
| 冷启动 | 每个任务一次 | 服务常驻，会话创建快 |
| gate 恢复 | 杀进程 + `--session` 重启 | 直接发消息 |
| 运行中插话 | 排队到下一轮 | 可扩展为 `/api/.../prompt` 的 steer |
| 隔离 | 每任务进程 | 共享 server，会话级目录隔离 |
| 权限审批 | 依赖 prompt gate | `permission.asked` 能看到，但 reply 端点当前版本未打通 |

> serve 模式的 permission reply 目前不可用（见“已知缺口”）。需要审批时用 gate 协议，或在 `opencode.json` 里配 allow/deny。

## TLS（自签 CA）

默认走 HTTP；跨机器部署建议开 TLS。gateway 和 runner 都支持，也可以只给 A↔B 开、本地 gateway↔TUI 保持 HTTP。

1. 在 B（或任意一台可信机器）生成 CA 和两张服务端证书：

```powershell
pwsh -NoProfile -File scripts\make-certs.ps1 `
  -OutDir certs `
  -RunnerHost 192.168.1.20 `
  -GatewayHost 127.0.0.1
```

产物：

- `ca.crt`：拷到 A 和 B（客户端信任它）
- `runner.crt` / `runner.key`：只放 B
- `gateway.crt` / `gateway.key`：只放 A（如果 gateway 也开 TLS）
- `ca.key`：离线保存，不要拷到任何在线机器

证书的 SAN 必须匹配你实际连接的地址：连 IP 就要 `-RunnerHost 192.168.1.20`，连主机名就传 DNS 名。IP 变了要重签。

2. B 的 `runner.json`：

```json
"tls": {
  "cert": "certs/runner.crt",
  "key": "certs/runner.key"
}
```

3. A 的 `gateway.json` 里对应 runner 条目：

```json
"b1": {
  "url": "https://192.168.1.20:8788",
  "token": "<B 的 token>",
  "tls": { "ca": "certs/ca.crt" }
}
```

4. 如果 gateway 本身也对局域网开 TLS：

```json
"tls": { "cert": "certs/gateway.crt", "key": "certs/gateway.key" }
```

客户端（CLI/MCP/TUI）配置：

```json
"gateway": {
  "url": "https://192.168.1.20:8787",
  "token": "<gateway token>",
  "tls": { "ca": "certs/ca.crt" }
}
```

`rejectUnauthorized` 默认是 `true`，不要为了省事关掉。`certs/` 已加入 `.gitignore`，私钥文件由脚本收紧 ACL。

## 两台机器部署

### B 机（执行端）

1. 把 `agent-bridge` 目录拷到 B，例如 `D:\agent-bridge`。
2. 编译 Job Object helper（只需一次，依赖 Windows 自带的 .NET Framework）：

```powershell
cd D:\agent-bridge
pwsh -NoProfile -File scripts\build-jobrun.ps1
# -> bin\jobrun.exe
```

3. 把仓库克隆到 B，例如 `D:\repos\app`，编辑 `config\runner.json`：

```json
{
  "port": 8788,
  "host": "0.0.0.0",
  "token": "<长随机串>",
  "workRoot": "D:\\agent-work",
  "stateRoot": "D:\\agent-state",
  "maxConcurrent": 2,
  "jobObject": true,
  "jobMemoryMb": 4096,
  "jobProcessLimit": 128,
  "taskTimeoutSec": 0,
  "defaultModel": "opencode/deepseek-v4.1-flash-free",
  "repos": { "app": "D:\\repos\\app" }
}
```

`taskTimeoutSec: 0` 表示不设墙钟超时；长任务建议保持 0，由人工取消。`jobMemoryMb` 是整个 Job 的上限，按 B 的内存调整。

4. 用管理员 PowerShell 初始化账户、ACL、长路径、防火墙和开机任务：

```powershell
cd D:\agent-bridge
.\scripts\init-runner.ps1 `
  -Config D:\agent-bridge\config\runner.json `
  -WorkRoot D:\agent-work -StateRoot D:\agent-state `
  -Port 8788 -AllowFrom 192.168.1.10 `
  -RegisterTask
```

脚本会：创建非管理员本地用户 `agent-bridge`、生成随机密码、创建目录、`icacls` 去掉继承并只授该用户/管理员/SYSTEM、开启 `LongPathsEnabled`、按来源 IP 建防火墙规则、注册开机任务。

- 如果用户已存在，脚本不会重置密码，`-RegisterTask` 会提示你手动注册。
- 先不加 `-RegisterTask` 跑一遍，手动确认 runner 能启动，再注册任务。
- `-DryRun` 只打印步骤，不修改系统。

5. 手动启动测试：

```powershell
runas /user:agent-bridge cmd
# 在新窗口：
"D:\Programs\nodejs\node.exe" "D:\agent-bridge\bin\agent-bridge.mjs" runner --config "D:\agent-bridge\config\runner.json"
```

6. 从 A 检查：

```powershell
curl http://192.168.1.20:8788/health
```

### A 机（控制端 + 人工入口）

编辑 `config/gateway.json`：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "token": "<gateway token>",
  "dataDir": "D:\\agent-bridge-data",
  "runners": {
    "b1": { "url": "http://192.168.1.20:8788", "token": "<B1 的 token>" },
    "b2": { "url": "http://192.168.1.21:8788", "token": "<B2 的 token>" }
  }
}
```

```powershell
node bin/agent-bridge.mjs gateway --config config/gateway.json
```

`runners` 是机器注册表，key 就是会话里的 `--to b1/opencode` 的 `b1`。加一台 B 只需要加一条，不需要改代码。

`gateway` 默认只监听 `127.0.0.1`，TUI/MCP 都在本机；不需要对局域网暴露。若要从另一台机器 attach TUI，再改成 `0.0.0.0` 并配 token。

### 多台机器 / 多个 harness

一个会话只绑定一个目标，所以“指定机器或 harness”就是创建一个对应会话：

```powershell
# B1 上的 opencode
node bin/agent-bridge.mjs session new --to b1/opencode
# B1 上的 pi
node bin/agent-bridge.mjs session new --to b1/pi
# B2 上的 opencode
node bin/agent-bridge.mjs session new --to b2/opencode
```

每个会话在 A 侧对应一个父 harness 会话（或一个 MCP server 进程）。人类在哪个会话里说话，任务就落到哪个 `runner/harness`，不存在“模型猜错目标”的问题。要换目标就新开会话，TUI 顶部的 target 是只读的。

`runners` 里没有的 key 会被 gateway 拒绝：

```json
{ "error": "unknown runner: b9", "known": ["b1", "b2"] }
```

## A 侧接入：MCP 或 CLI

A 侧不绑定具体 harness：OpenCode、Claude Code、pi、Hermes 都可以，只要它支持 stdio MCP 或能执行 shell。逐家配置见 [`docs/a-harnesses.md`](docs/a-harnesses.md)。

不用手写路径，可以生成对应 harness 的 MCP 配置：

```powershell
agent-bridge mcp-config --harness opencode --session s_xxxx
agent-bridge mcp-config --harness claude  --session s_xxxx
agent-bridge mcp-config --harness pi      --session s_xxxx
agent-bridge mcp-config --harness hermes  --session s_xxxx
```

完整的一对一场景（A=Claude Code，B=pi）见 [`docs/scenario-claude-pi.md`](docs/scenario-claude-pi.md)。

### 方式 1：MCP（推荐给 opencode / Claude Code）

每个 session 起一个 MCP server，target 在启动时固定：

```
node D:\projects\a\agent-bridge\bin\agent-bridge.mjs mcp --config <client.json> --session <s_...>
```

opencode 配置示例：

```json
{
  "mcp": {
    "agent-bridge": {
      "type": "local",
      "command": [
        "node",
        "D:\\projects\\a\\agent-bridge\\bin\\agent-bridge.mjs",
        "mcp",
        "--config",
        "D:\\projects\\a\\agent-bridge\\config\\client.json",
        "--session",
        "s_xxxxxxxx"
      ],
      "enabled": true
    }
  }
}
```

工具：

| 工具 | 作用 |
|---|---|
| `delegate_task` | 下发任务，立即返回 taskId |
| `task_status` | 查询状态/摘要/错误 |
| `list_inbox` | 列出待人工处理的问题 |
| `answer_question` | 批准/拒绝/回答 |
| `steer_task` | 给运行中的任务插话 |
| `cancel_task` | 取消 |

### 方式 2：CLI（任何能跑 shell 的 harness）

```powershell
agent-bridge session new --to b1/opencode
agent-bridge submit --session s_xxx --repo app --ref fix/login `
  --constraint "不改 public API" --accept "登录超时 30s" "修复登录超时"
agent-bridge status t_xxx
```

`submit` 立即返回 taskId，不会阻塞父 harness 的 shell 工具。

### 父 harness 的系统提示（关键）

见 [`examples/system-prompt.md`](examples/system-prompt.md)。要点：

- 当前会话的 target 已固定，调用工具时**不要**指定机器/harness。
- 仓库、分支、验收标准不明确时先问人，不要猜。
- `delegate_task` 返回后立即告诉用户 taskId，不要轮询等待。
- 用户要求换 harness 时，提示“新开一个会话”。

## 人工引导：三种交互

| 类型 | 触发 | 行为 |
|---|---|---|
| approval | agent 要执行高风险动作 | 输出 `<<<GATE ...>>>` 并停止；TUI 批准/拒绝 |
| clarification | agent 缺信息 | 同上，但回答是自由文本 |
| steer | 人主动插话 | TUI `s`；运行中注入，不支持注入则排队到下一个 checkpoint |

Gate 协议（写在发给 B 的 prompt 里）：

```
<<<GATE {"kind":"approval","title":"Approve db:migrate?","detail":{"command":"npm run db:migrate","cwd":"..."}}>>>
```

runner 检测到后：状态转 `waiting`，问题进 inbox，opencode 进程在 1.2s 后停止；人回答后 adapter 用 `--session <id>` 重新拉起并注入回答。

**注意**：这是“协作式 gate”，不是操作系统级沙箱。`opencode run` 在无 TTY 下可能自动允许 bash；真正的权限控制要靠：

- B 机专用非管理员账户 + ACL 限制工作目录；
- `opencode.json` 的 permission 配置（需实测你的版本在 headless 下的行为）；
- 不要把生产凭据放在 B 上；
- 不可信代码请用独立机器 / Hyper-V VM（Windows 11 专业版）。

## runner 崩溃恢复

每个 run 在 `stateRoot\runs\<runId>\` 下落盘：

- `run.json`：task、state、sessionRef、question、lastText、seq
- `events.jsonl`：完整事件流

runner 启动时扫描这些目录：

- `running` / `queued` → 标记为 `interrupted`
- `waiting` → 保留问题，等人回答
- gateway 的 relay 会自动重连，看到 `interrupted` 后更新 A 侧任务

恢复方式：

```powershell
# TUI 里按 R
agent-bridge resume <taskId> "继续，先检查 git status"
```

对应接口 `POST /v1/tasks/{id}/resume`。恢复逻辑：

- `opencode run`：用持久化的 `sessionRef` 执行 `--session <id>`；
- `opencode serve`：直接向原 session 发一条消息；
- `pi`：用 session id/文件重新起进程；
- 默认恢复消息会要求 agent 先重查 git 状态和未完成改动。

已知限制：

- 进程被硬杀时，最后 ~100ms 内的事件可能丢失；`run.json` 在状态变更时立即写，风险窗口很小。
- 如果 runner 在建好 `run.json` 之前崩溃（几毫秒），这个 run 不会出现在恢复列表里。

## 安全模型（无容器）

| 目标 | 当前做法 |
|---|---|
| 账户隔离 | 专用本地用户 `agent-bridge`（非管理员），`scripts/init-runner.ps1` 创建 |
| 文件隔离 | 每任务 `D:\agent-work\run_*` + 独立 worktree，ACL 只授该用户 + 管理员 + SYSTEM |
| 进程清理 | `bin/jobrun.exe` Job Object：`KILL_ON_JOB_CLOSE`、进程数/内存上限、可选墙钟超时 |
| 并发 | runner 队列 + `maxConcurrent`（默认 2） |
| 网络 | 局域网 + token；可开自签 TLS/mTLS；防火墙限定来源 IP |
| 凭据 | harness 配置放在 runner 用户 profile 下 |
| 审计 | `stateRoot\runs\*\events.jsonl` + gateway 事件日志 |

已知缺口：

- 没有内核级隔离；能接受“防误操作”，不能接受“防恶意代码”。
- Job Object 是在 `Process.Start` 之后 `AssignProcessToJobObject`，存在极小的“子进程已启动但尚未入 Job”的窗口；对正常 CLI 足够，恶意代码不要依赖它。
- `opencode serve` 的 `permission.asked` 事件已经能看到，但 reply 端点在当前版本上还没打通（`/api/session/.../permission/.../reply` 返回 404）。serve 模式请用 gate 协议或 allow/deny 规则，不要依赖 `permission: ask`。
- 人工恢复的任务会临时突破 `maxConcurrent`（人工优先），落回队列后重新受控。

## 目录

```
agent-bridge/
├─ bin/
│  ├─ agent-bridge.mjs          CLI 入口
│  └─ jobrun.exe                Job Object helper（build 产物）
├─ native/jobrun.cs             Job Object + 输出转发
├─ scripts/
│  ├─ build-jobrun.ps1          用 csc 编译 helper
│  ├─ init-runner.ps1           B 机账户/ACL/防火墙/开机任务
│  └─ make-certs.ps1            自签 CA + runner/gateway 证书
├─ src/
│  ├─ gateway.mjs               A 侧：session/task/inbox/SSE
│  ├─ runner.mjs                B 侧：队列、worktree、事件、恢复
│  ├─ store.mjs                 JSON 状态存储
│  ├─ mcp.mjs                   MCP stdio server
│  ├─ tui.mjs                   终端收件箱
│  ├─ cli.mjs                   session/submit/status/...
│  ├─ jobrun.mjs                Job Object 包装
│  ├─ http.mjs                  HTTP/HTTPS 客户端（支持 CA）
│  ├─ util.mjs                  SSE/ANSI/配置/原子写
│  └─ adapters/
│     ├─ echo.mjs               测试用
│     ├─ opencode.mjs           opencode run --format json
│     ├─ opencode-server.mjs    opencode serve HTTP/SSE
│     └─ pi.mjs                 pi --mode rpc
├─ config/                      示例配置
├─ certs/                       本地自签证书（gitignored）
├─ docs/a-harnesses.md          OpenCode/Claude Code/pi/Hermes 接入
├─ docs/scenario-claude-pi.md   A=Claude Code，B=pi 的完整步骤
├─ test/                        smoke + live + recovery + concurrency
└─ examples/system-prompt.md    父 harness 提示词
```

## 测试

```powershell
node test/smoke.mjs            # echo adapter，7 项，无外部依赖
node test/concurrency.mjs      # maxConcurrent=2，验证排队和并发上限
node test/timeout.mjs          # Job Object 墙钟超时（1s 杀进程）
node test/recovery.mjs         # 落盘 run 恢复为 interrupted
node test/recovery-process.mjs # 硬杀 runner 后重启并恢复
node test/recovery-gateway.mjs # gateway relay 跨 runner 重启
node test/live-pi-mock.mjs     # B=pi 的 RPC/gate 流程（mock pi，无需登录）
node test/scenario-claude-pi.mjs # A MCP → gateway → B pi 全链路（mock）
node test/live-opencode.mjs    # 真实 opencode run，约 10s
node test/live-gate.mjs        # run 模式 gate + 恢复
node test/live-serve.mjs       # 真实 opencode serve，约 10s
node test/live-serve-gate.mjs  # serve 模式 gate + 恢复
node test/mcp.mjs              # MCP 工具（需要 gateway 已启动）
```

## 故障排查

- **`Failed to change directory`**：workdir 必须是绝对路径；已在 `prepareWorkspace` 里 `path.resolve`。
- **opencode 参数被当成 flag**：adapter 用 `--` 分隔 prompt，不要去掉。
- **pi 启动报 `spawn EINVAL`**：Node 26 不允许直接 spawn `.cmd`；adapter 优先解析 `pi.ps1` 并用 `pwsh -File`。
- **中文乱码**：Windows Terminal 用 UTF-8；runner/gateway 输出是 UTF-8，旧 conhost 可能显示异常。
- **Defender 拖慢**：给 `D:\agent-work` 和 Node 缓存加排除。
- **长路径**：开启 `LongPathsEnabled=1`，Git 设置 `core.longpaths=true`。

# 场景：A = Claude Code，B = pi

目标：在 A 机的 Claude Code 里用自然语言下发任务，B 机的 pi 执行；关键节点在 A 机的 `agent-bridge tui` 里审批。

```
A（Windows）                                      B（Windows）
Claude Code ── MCP stdio ──► agent-bridge gateway ── HTTP/HTTPS ──► runner ── RPC ──► pi
                                   │
                              agent-bridge tui（人工审批）
```

## 1. B 机：准备 pi

```powershell
pi --version
pi /login          # 或配置 provider API key
pi --list-models   # 确认能看到 anthropic/... 等模型
```

记下你要用的模型 ID，例如 `anthropic/claude-sonnet-4-5`。runner 配置：

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
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "repos": { "app": "D:\\repos\\app" }
}
```

启动：

```powershell
node D:\agent-bridge\bin\agent-bridge.mjs runner --config D:\agent-bridge\config\runner.pi.json
```

`pi` 必须能在 runner 的账户下找到。默认会解析 `pi.ps1` / `pi.cmd`；如果不在 PATH，配置：

```json
"piBin": "C:\\Users\\agent-bridge\\AppData\\Local\\Programs\\pi\\pi.ps1"
```

验证：

```powershell
curl http://127.0.0.1:8788/health
```

## 2. A 机：启动 gateway

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "token": "<gateway token>",
  "dataDir": "D:\\agent-bridge-data",
  "runners": {
    "b1": {
      "url": "http://192.168.1.20:8788",
      "token": "<B 的 token>"
    }
  }
}
```

```powershell
node D:\agent-bridge\bin\agent-bridge.mjs gateway --config D:\agent-bridge\config\gateway.claude-pi.json
```

## 3. A 机：创建绑定 pi 的会话

```powershell
agent-bridge session new --to b1/pi --model anthropic/claude-sonnet-4-5
# s_xxxx
```

## 4. A 机：给 Claude Code 配 MCP

```powershell
agent-bridge mcp-config --harness claude --session s_xxxx
```

把输出写入项目根目录 `.mcp.json`（或用户级 Claude Code MCP 配置）：

```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\agent-bridge\\bin\\agent-bridge.mjs",
        "mcp",
        "--config",
        "D:\\projects\\a\\agent-bridge\\config\\client.json",
        "--session",
        "s_xxxx"
      ]
    }
  }
}
```

检查：

```powershell
claude mcp list
```

Claude Code 里应该能看到 `agent-bridge`，工具名类似：

```
mcp__agent-bridge__delegate_task
mcp__agent-bridge__task_status
mcp__agent-bridge__list_inbox
mcp__agent-bridge__answer_question
mcp__agent-bridge__steer_task
mcp__agent-bridge__cancel_task
```

如果 Claude Code 询问是否允许这些工具，选择允许；或在项目 `.claude/settings.json` 里加 allowlist。

## 5. 在 Claude Code 里对话

把 [`examples/system-prompt.md`](../examples/system-prompt.md) 的核心规则放进 `CLAUDE.md`，然后直接说：

> 把“修复登录超时”交给 B 上的 pi。仓库 app，分支 fix/login，先出方案，方案批准后再改。

预期：

1. Claude Code 调 `delegate_task`，参数包含 goal/repo/base_ref/acceptance/gates；
2. 工具立即返回 `taskId`；
3. Claude Code 告诉你“已下发 t_xxxx 到 b1/pi”；
4. B 的 pi 开始执行；
5. 你在 A 的另一终端跑：

```powershell
agent-bridge tui
```

在 TUI 里看进度、批准 gate、插话。

## 6. 无头验证（可选）

如果 Claude Code 已登录，可以用 print 模式验证 MCP 工具：

```powershell
claude -p "调用 delegate_task 把任务『回复 OK』下发给当前会话的目标，返回 taskId" `
  --mcp-config .mcp.json `
  --allowedTools "mcp__agent-bridge__delegate_task,mcp__agent-bridge__task_status"
```

然后：

```powershell
agent-bridge status <taskId>
```

## 7. 这个场景里各部分的职责

| 部分 | 职责 |
|---|---|
| Claude Code | 理解自然语言、补全参数、调用 MCP 工具、把 taskId 告诉你 |
| gateway | 绑定 `claude 会话 -> b1/pi`，保存任务/问题/事件 |
| runner | 起 `pi --mode rpc` 进程，转发 prompt/steer/abort，管理 worktree |
| pi | 真正执行、读代码、改代码、跑命令；到 gate 停下来 |
| TUI | 人工审批/插话/回答；不占用 Claude Code 的上下文 |

## 8. 已验证 / 未验证

已验证：

- **全链路（mock）**：`test/scenario-claude-pi.mjs` 用一个 MCP 客户端模拟 Claude Code，连 gateway，把任务下发给 B 的 pi（mock RPC），走完 delegate → gate → list_inbox → answer → completed；
- A 侧 MCP 协议（`test/mcp.mjs`）：initialize、tools/list、delegate_task、task_status；
- B 侧 pi adapter（`test/live-pi-mock.mjs`）：RPC `prompt`、`get_state` 会话 ID、gate、恢复；
- gateway/runner 全链路、TLS、并发、崩溃恢复。

未在本机验证：

- 本机没有安装 Claude Code（`claude` 命令不存在），所以没有跑 Claude Code TUI → MCP 的真实对话；上面的全链路测试用的是与 Claude Code 相同的 MCP stdio 协议；
- 本机 pi 没有登录 provider（`pi --list-models` 为空），所以没有跑真实模型；adapter 对未登录会返回明确错误。

在你有 Claude Code 和已登录 pi 的机器上，按上面 1–5 步即可完成真实场景。

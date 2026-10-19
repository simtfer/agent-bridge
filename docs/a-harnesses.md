# A 侧接入不同 harness

agent-bridge 的 A 侧不依赖任何具体 harness。A 只要能做下面两件事之一，就能下发任务：

1. **接一个 stdio MCP server**（推荐）：`agent-bridge mcp --session <id>`
2. **执行 shell 命令**：`agent-bridge submit --session <id> "..."`

所以 OpenCode、Claude Code、pi、Hermes 都可以是 A。区别只在“把 MCP server 配到哪个文件”。

## 生成配置

不用手写路径，直接生成：

```powershell
agent-bridge mcp-config --harness opencode --session s_xxxx
agent-bridge mcp-config --harness claude  --session s_xxxx
agent-bridge mcp-config --harness pi      --session s_xxxx
agent-bridge mcp-config --harness hermes  --session s_xxxx
```

每个会话绑定一个目标（`runner/harness`），所以**换 B 机器或换 B 侧 harness，就要新建会话并重新生成配置**。

## 对照表

| A harness | MCP 配置位置 | 关键点 |
|---|---|---|
| OpenCode | `opencode.json` 的 `mcp` | `type: "local"`，`command` 是数组 |
| Claude Code | 项目 `.mcp.json` 的 `mcpServers`，或 `claude mcp add` | 标准 stdio 配置 |
| pi | `~/.pi/agent/mcp.json` 或 `.pi/mcp.json` | 默认 `codemode` 暴露，必须 `"exposure": "direct"` 否则模型看不到工具 |
| Hermes | 取决于发行版；通用 `mcpServers` | 支持 stdio MCP 就直接用；不支持就用 CLI 兜底 |

## OpenCode

把 `mcp-config --harness opencode` 的输出合并进 `opencode.json`：

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
        "s_xxxx"
      ],
      "enabled": true
    }
  }
}
```

重启 OpenCode 后，工具会以 `agent-bridge_*` 或 `mcp__agent-bridge__*` 的形式出现（取决于版本）。

## Claude Code

项目根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\projects\\a\\agent-bridge\\bin\\agent-bridge.mjs",
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

或者：

```powershell
claude mcp add agent-bridge -- node D:\projects\a\agent-bridge\bin\agent-bridge.mjs mcp --config D:\projects\a\agent-bridge\config\client.json --session s_xxxx
```

## pi

写入 `~/.pi/agent/mcp.json`（用户级）或 `.pi/mcp.json`（项目级，需要信任项目）：

```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\projects\\a\\agent-bridge\\bin\\agent-bridge.mjs",
        "mcp",
        "--config",
        "D:\\projects\\a\\agent-bridge\\config\\client.json",
        "--session",
        "s_xxxx"
      ],
      "exposure": "direct"
    }
  }
}
```

`exposure: "direct"` 很重要。pi 默认 `codemode`，工具不会直接声明给模型，模型只能通过 codemode 脚本调用；`direct` 才会像内置工具一样直接可用。

验证：

```powershell
pi mcp list
```

## Hermes

Hermes 有多个发行版，MCP 配置名可能不同。判断标准很简单：

- 如果它支持 **stdio MCP**（配置里能写 `command` + `args`），用 `mcp-config --harness hermes` 的通用 `mcpServers` 片段。
- 如果它只支持 HTTP MCP，需要给 `agent-bridge` 加一个 HTTP 入口（当前只有 stdio），或者用 CLI。
- 如果它没有 MCP，直接在它的 shell 工具里调用：

```powershell
agent-bridge submit --session s_xxxx --repo app --ref main "修复登录超时"
agent-bridge status t_xxxx
agent-bridge inbox
agent-bridge approve q_xxxx
```

CLI 是通用兜底：任何能执行命令的 harness 都能用，包括 Hermes 和没有 MCP 的版本。

## 工具清单

MCP server 暴露：

| 工具 | 作用 |
|---|---|
| `delegate_task` | 下发任务，立即返回 taskId |
| `dispatch_task` | 下发并等待到终态或 waiting（短任务） |
| `task_wait` | 等到 completed/failed/waiting/interrupted；waiting 时返回 question |
| `task_status` | 查状态/摘要/错误 |
| `task_result` | 取最终 summary/usage/error/workdir |
| `task_resume` | 恢复 interrupted 任务 |
| `pending_approvals` / `list_inbox` | 列出待人工处理的问题 |
| `task_approve` / `answer_question` | 批准/拒绝/回答 |
| `task_respond` | 回答 clarification |
| `steer_task` | 给运行中的任务插话 |
| `cancel_task` | 取消 |

## 对话契约

把 [`examples/system-prompt.md`](../examples/system-prompt.md) 的内容放进 A harness 的系统提示/项目规则。核心规则：

- 当前会话目标已固定，不要指定机器或 harness；
- 缺 repo/branch/验收标准先问人；
- `delegate_task` 立即返回 taskId；随后用 `task_wait` 等待，不要轮询 `task_status`；
- 换目标要新开会话；
- 高风险任务加 gate；
- `waiting` 时在对话里问人，再 `task_approve`/`task_respond`。

## 边界

- A 侧 harness 只负责“理解 + 调用工具”，不参与 B 的执行。
- B 完成后不会自动把结果推回 A 的对话；A 通过 `task_wait`/`task_result` 取结果并转述给用户。
- 审批在 A 的对话里完成，通过 `task_wait` + `task_approve`/`task_respond`。
- 一个会话一个目标；多 B / 多 harness 就多会话。

import { loadConfig, parseArgs, log } from "./util.mjs";
import { requestJson } from "./http.mjs";

/**
 * Minimal MCP stdio server. It exposes the gateway as tools so any harness that
 * supports MCP can delegate without shelling out.
 *
 * The session (and therefore the target machine/harness) is fixed when the
 * server is started: `agent-bridge mcp --session s_...`.
 */
export async function runMcp(argv = []) {
  const args = parseArgs(argv);
  const config = loadConfig(args.config || "config/client.json");
  const sessionId = args.session || process.env.AGENT_BRIDGE_SESSION;
  if (!sessionId) throw new Error("--session or AGENT_BRIDGE_SESSION required");

  const headers = { "content-type": "application/json" };
  if (config.gateway?.token) headers["x-bridge-token"] = config.gateway.token;

  async function api(path, options = {}) {
    return requestJson(`${config.gateway.url}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      tls: config.gateway.tls,
    });
  }

  const tools = [
    {
      name: "delegate_task",
      description:
        "Delegate a coding task to the target machine/harness fixed for this session. " +
        "Returns immediately with a task id. Do not wait or poll in a loop; the human " +
        "monitors progress and answers gates in the terminal inbox.",
      inputSchema: {
        type: "object",
        properties: {
          goal: { type: "string", description: "One-sentence goal." },
          raw_request: { type: "string", description: "The user's original wording." },
          repo: { type: "string", description: "Repository name configured on the runner." },
          repo_path: { type: "string", description: "Absolute repo path on the runner (optional)." },
          base_ref: { type: "string", description: "Branch or commit to start from." },
          constraints: { type: "array", items: { type: "string" } },
          acceptance: { type: "array", items: { type: "string" } },
          gates: {
            type: "array",
            items: { type: "string", enum: ["plan", "pre-merge", "approval"] },
            description: "Milestones where the remote agent must stop for human sign-off.",
          },
        },
        required: ["goal"],
      },
    },
    {
      name: "task_status",
      description: "Get the current state, summary and error of a delegated task.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
    {
      name: "list_inbox",
      description: "List pending human decisions/questions across delegated tasks.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "answer_question",
      description: "Answer a pending question or approve/deny a gate.",
      inputSchema: {
        type: "object",
        properties: {
          question_id: { type: "string" },
          decision: { type: "string", enum: ["approve", "deny"] },
          text: { type: "string", description: "Optional instruction or clarification." },
        },
        required: ["question_id"],
      },
    },
    {
      name: "steer_task",
      description: "Send an additional instruction to a running task.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, text: { type: "string" } },
        required: ["task_id", "text"],
      },
    },
    {
      name: "cancel_task",
      description: "Cancel a running or waiting task.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
    },
  ];

  async function callTool(name, input = {}) {
    switch (name) {
      case "delegate_task": {
        const data = await api("/v1/tasks", {
          method: "POST",
          body: JSON.stringify({
            sessionId,
            goal: input.goal,
            rawRequest: input.raw_request || input.goal,
            repo: input.repo,
            repoPath: input.repo_path,
            baseRef: input.base_ref,
            constraints: input.constraints,
            acceptance: input.acceptance,
            gates: input.gates,
          }),
        });
        return {
          taskId: data.taskId,
          target: data.target,
          state: data.state,
          hint: "Returned immediately. The human can watch progress in `agent-bridge tui`.",
        };
      }
      case "task_status": {
        const task = await api(`/v1/tasks/${input.task_id}`);
        return {
          taskId: task.id,
          state: task.state,
          goal: task.goal,
          summary: task.summary,
          error: task.error,
          workdir: task.workdir,
          questionId: task.questionId,
        };
      }
      case "list_inbox": {
        const data = await api("/v1/inbox");
        return data.questions;
      }
      case "answer_question": {
        await api(`/v1/questions/${input.question_id}/answer`, {
          method: "POST",
          body: JSON.stringify({
            decision: input.decision || "approve",
            text: input.text,
            actor: config.actor || "mcp",
          }),
        });
        return { ok: true };
      }
      case "steer_task": {
        await api(`/v1/tasks/${input.task_id}/steer`, {
          method: "POST",
          body: JSON.stringify({ text: input.text, actor: config.actor || "mcp" }),
        });
        return { ok: true };
      }
      case "cancel_task": {
        await api(`/v1/tasks/${input.task_id}/cancel`, { method: "POST" });
        return { ok: true };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  function send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        fail(null, -32700, `parse error: ${error.message}`);
        continue;
      }

      if (message.method === "initialize") {
        reply(message.id, {
          protocolVersion: message.params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "agent-bridge", version: "0.1.0" },
        });
        continue;
      }
      if (message.method === "notifications/initialized") continue;
      if (message.method === "ping") {
        reply(message.id, {});
        continue;
      }
      if (message.method === "tools/list") {
        reply(message.id, { tools });
        continue;
      }
      if (message.method === "tools/call") {
        const name = message.params?.name;
        const input = message.params?.arguments || {};
        try {
          const result = await callTool(name, input);
          reply(message.id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          });
        } catch (error) {
          reply(message.id, {
            content: [{ type: "text", text: `error: ${error.message}` }],
            isError: true,
          });
        }
        continue;
      }
      fail(message.id, -32601, `method not found: ${message.method}`);
    }
  });

  log(`mcp server ready for session ${sessionId}`);
  await new Promise(() => {});
}

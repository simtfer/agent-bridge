import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, loadConfig, createSseParser, log } from "./util.mjs";
import { request, requestJson } from "./http.mjs";

const DEFAULT_CONFIG = "config/client.json";
const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-bridge.mjs");

async function api(config, path, options = {}) {
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (config.gateway?.token) headers["x-bridge-token"] = config.gateway.token;
  return requestJson(`${config.gateway.url}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    tls: config.gateway.tls,
  });
}

function splitList(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function printTask(task) {
  const lines = [
    `${task.id}  [${task.state}]  ${task.goal}`,
    `  target: ${task.target?.runner}/${task.target?.harness}` +
      (task.target?.model ? `  model=${task.target.model}` : ""),
    `  repo: ${task.repo || "-"}  ref: ${task.baseRef || "-"}`,
    `  workdir: ${task.workdir || "-"}`,
  ];
  if (task.summary) lines.push(`  summary: ${task.summary}`);
  if (task.error) lines.push(`  error: ${task.error}`);
  console.log(lines.join("\n"));
}

export async function cli(command, argv) {
  const args = parseArgs(argv);
  const configPath = args.config || DEFAULT_CONFIG;
  const config = loadConfig(configPath);
  if (!config.gateway?.url) throw new Error(`gateway.url missing in ${configPath}`);

  switch (command) {
    case "mcp-config": {
      const harness = String(args.harness || "").toLowerCase();
      if (!["opencode", "claude", "claude-code", "pi", "hermes", "generic"].includes(harness)) {
        throw new Error("usage: mcp-config --harness opencode|claude|pi|hermes|generic --session <id>");
      }
      const sessionId = args.session || process.env.AGENT_BRIDGE_SESSION;
      if (!sessionId) throw new Error("--session or AGENT_BRIDGE_SESSION required");
      const configPath = path.resolve(args.config || DEFAULT_CONFIG);
      const argv = [BIN_PATH, "mcp", "--config", configPath, "--session", sessionId];

      let output;
      if (harness === "opencode") {
        output = {
          mcp: {
            "agent-bridge": {
              type: "local",
              command: [process.execPath, ...argv],
              enabled: true,
            },
          },
        };
      } else if (harness === "pi") {
        output = {
          mcpServers: {
            "agent-bridge": {
              command: process.execPath,
              args: argv,
              exposure: "direct",
            },
          },
        };
      } else if (harness === "claude" || harness === "claude-code") {
        output = {
          mcpServers: {
            "agent-bridge": {
              type: "stdio",
              command: process.execPath,
              args: argv,
              env: {},
            },
          },
        };
      } else {
        output = {
          mcpServers: {
            "agent-bridge": {
              command: process.execPath,
              args: argv,
              env: {},
            },
          },
        };
      }

      console.log(JSON.stringify(output, null, 2));
      console.error(
        harness === "opencode"
          ? "merge into opencode.json, then restart opencode"
          : harness === "pi"
            ? "merge into ~/.pi/agent/mcp.json or .pi/mcp.json, then run /reload"
            : "merge into the harness MCP config, or use `agent-bridge submit` if it has no MCP support",
      );
      return;
    }

    case "session": {
      const sub = args._[0];
      if (sub !== "new") throw new Error("usage: session new --to <runner>/<harness>");
      const to = String(args.to || "");
      const [runner, ...rest] = to.split("/");
      const harness = rest.join("/");
      if (!runner || !harness) throw new Error("--to must look like b1/opencode");
      const session = await api(config, "/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          target: { runner, harness, model: args.model, agent: args.agent },
          name: args.name,
        }),
      });
      console.log(session.id);
      console.error(`session ${session.id} -> ${runner}/${harness}`);
      return;
    }

    case "sessions": {
      const data = await api(config, "/v1/sessions");
      for (const session of data.sessions) {
        console.log(
          `${session.id}  ${session.target.runner}/${session.target.harness}` +
            `${session.target.model ? `  ${session.target.model}` : ""}  ${session.createdAt}`,
        );
      }
      return;
    }

    case "submit": {
      const sessionId = args.session || process.env.AGENT_BRIDGE_SESSION;
      if (!sessionId) throw new Error("--session or AGENT_BRIDGE_SESSION required");
      const goal = args.goal && args.goal !== true ? String(args.goal) : args._.join(" ");
      if (!goal) throw new Error("goal required (positional text or --goal)");
      const body = {
        sessionId,
        goal,
        rawRequest: goal,
        repo: args.repo,
        baseRef: args.ref,
        repoPath: args["repo-path"],
        constraints: splitList(args.constraint),
        acceptance: splitList(args.accept),
        gates: splitList(args.gate),
      };
      const data = await api(config, "/v1/tasks", {
        method: "POST",
        body: JSON.stringify(body),
      });
      console.log(data.taskId);
      console.error(`submitted ${data.taskId} -> ${data.target.runner}/${data.target.harness}`);
      return;
    }

    case "status": {
      const id = args._[0];
      if (!id) throw new Error("usage: status <taskId>");
      printTask(await api(config, `/v1/tasks/${id}`));
      return;
    }

    case "watch": {
      const id = args._[0];
      if (!id) throw new Error("usage: watch <taskId>");
      const headers = config.gateway.token ? { "x-bridge-token": config.gateway.token } : {};
      const response = await request(`${config.gateway.url}/v1/tasks/${id}/events`, {
        headers,
        tls: config.gateway.tls,
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const parser = createSseParser(({ event, data }) => {
        const payload = data?.data ?? data;
        if (event === "delta") {
          process.stdout.write(String(payload?.text || ""));
          return;
        }
        const text =
          typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
        console.log(`\n[${event}] ${text}`);
        if (event === "done") process.exit(0);
      });
      for await (const chunk of response.stream) {
        parser.push(chunk.toString("utf8"));
      }
      return;
    }

    case "inbox": {
      const data = await api(config, "/v1/inbox");
      if (data.questions.length === 0) {
        console.log("inbox empty");
        return;
      }
      for (const question of data.questions) {
        console.log(`\n${question.id}  [${question.kind}]  ${question.title}`);
        console.log(`  task: ${question.taskId}`);
        if (question.detail) console.log(`  detail: ${JSON.stringify(question.detail)}`);
        console.log(`  options: ${question.options.join(", ")}`);
      }
      return;
    }

    case "approve":
    case "deny": {
      const id = args._[0];
      if (!id) throw new Error(`usage: ${command} <questionId> [--text "..."]`);
      const text = args.text && args.text !== true ? String(args.text) : undefined;
      await api(config, `/v1/questions/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({
          decision: command,
          text,
          actor: args.actor || config.actor || "cli",
        }),
      });
      console.log(`${command === "deny" ? "denied" : "approved"} ${id}`);
      return;
    }

    case "answer": {
      const id = args._[0];
      const text = args._.slice(1).join(" ") || args.text;
      if (!id || !text) throw new Error("usage: answer <questionId> <text>");
      await api(config, `/v1/questions/${id}/answer`, {
        method: "POST",
        body: JSON.stringify({ decision: "approve", text, actor: args.actor || config.actor || "cli" }),
      });
      console.log(`answered ${id}`);
      return;
    }

    case "steer": {
      const id = args._[0];
      const text = args._.slice(1).join(" ") || args.text;
      if (!id || !text) throw new Error("usage: steer <taskId> <text>");
      await api(config, `/v1/tasks/${id}/steer`, {
        method: "POST",
        body: JSON.stringify({ text, actor: args.actor || config.actor || "cli" }),
      });
      console.log(`steered ${id}`);
      return;
    }

    case "resume": {
      const id = args._[0];
      if (!id) throw new Error("usage: resume <taskId> [text]");
      const text = args._.slice(1).join(" ") || args.text;
      await api(config, `/v1/tasks/${id}/resume`, {
        method: "POST",
        body: JSON.stringify({ text, actor: args.actor || config.actor || "cli" }),
      });
      console.log(`resumed ${id}`);
      return;
    }

    case "cancel": {
      const id = args._[0];
      if (!id) throw new Error("usage: cancel <taskId>");
      await api(config, `/v1/tasks/${id}/cancel`, { method: "POST" });
      console.log(`canceled ${id}`);
      return;
    }

    case "tui": {
      const { runTui } = await import("./tui.mjs");
      await runTui(config, { once: Boolean(args.once) });
      return;
    }

    default:
      console.log(`agent-bridge <command>

commands:
  gateway --config config/gateway.json     start the A-side gateway
  runner  --config config/runner.json      start the B-side runner
  mcp --session <id>                       expose the session as MCP tools (stdio)
  mcp-config --harness <name> --session <id>
                                            print MCP config for opencode/claude/pi/hermes
  session new --to b1/opencode             create a session bound to one target
  sessions                                 list sessions
  submit --session <id> [--repo x] [--ref y] "goal"
  status <taskId>
  watch <taskId>
  inbox
  approve <questionId> [--text "..."]
  deny    <questionId> [--text "..."]
  answer  <questionId> <text>
  steer   <taskId> <text>
  resume  <taskId> [text]                  resume an interrupted run
  cancel  <taskId>
  tui                                      open the terminal inbox
`);
  }
}

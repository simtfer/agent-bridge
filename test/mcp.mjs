import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const gateway = "http://127.0.0.1:8787";
const token = "dev-gateway-token";

async function api(path, options = {}) {
  const response = await fetch(`${gateway}${path}`, {
    ...options,
    headers: { "content-type": "application/json", "x-bridge-token": token },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const session = await api("/v1/sessions", {
  method: "POST",
  body: JSON.stringify({ target: { runner: "local", harness: "echo" } }),
});

const child = spawn(
  process.execPath,
  ["bin/agent-bridge.mjs", "mcp", "--config", "config/client.json", "--session", session.id],
  { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
);

let buffer = "";
const waiters = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    setTimeout(() => {
      if (waiters.delete(id)) reject(new Error(`timeout: ${method}`));
    }, 10000);
  });
}

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "agent-bridge");
  console.log("ok - initialize");

  const list = await request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("delegate_task"));
  assert.ok(names.includes("answer_question"));
  console.log("ok - tools/list");

  const call = await request("tools/call", {
    name: "delegate_task",
    arguments: { goal: "mcp hello", raw_request: "mcp hello" },
  });
  const payload = JSON.parse(call.result.content[0].text);
  assert.match(payload.taskId, /^t_/);
  assert.equal(payload.target.harness, "echo");
  console.log("ok - delegate_task");

  let status;
  for (let i = 0; i < 50; i++) {
    const result = await request("tools/call", {
      name: "task_status",
      arguments: { task_id: payload.taskId },
    });
    status = JSON.parse(result.result.content[0].text);
    if (status.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status.state, "completed");
  assert.match(status.summary, /mcp hello/);
  console.log("ok - task_status");
} finally {
  child.kill();
}

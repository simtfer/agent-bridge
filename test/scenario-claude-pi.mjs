import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Runner } from "../src/runner.mjs";
import { Gateway } from "../src/gateway.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-scenario-"));
const piBin = path.resolve("test/mock-pi.ps1");

const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  maxConcurrent: 2,
  piBin,
});
const runnerAddress = await runner.listen();
const runnerUrl = `http://127.0.0.1:${runnerAddress.port}`;

const gateway = new Gateway({
  port: 0,
  host: "127.0.0.1",
  token: "",
  dataDir: path.join(temp, "gateway"),
  runners: { local: { url: runnerUrl, token: "" } },
});
const gatewayAddress = await gateway.listen();
const gatewayUrl = `http://127.0.0.1:${gatewayAddress.port}`;

const session = await fetch(`${gatewayUrl}/v1/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ target: { runner: "local", harness: "pi" } }),
}).then((response) => response.json());

const clientConfigPath = path.join(temp, "client.json");
fs.writeFileSync(
  clientConfigPath,
  JSON.stringify(
    {
      gateway: { url: gatewayUrl, token: "" },
      actor: "scenario",
    },
    null,
    2,
  ),
);

const bin = path.resolve("bin", "agent-bridge.mjs");
const child = spawn(
  process.execPath,
  [bin, "mcp", "--config", clientConfigPath, "--session", session.id],
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
child.stderr.on("data", () => {});

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

async function tool(name, args) {
  const response = await request("tools/call", { name, arguments: args });
  const text = response.result.content[0].text;
  const value = JSON.parse(text);
  if (response.result.isError) throw new Error(value);
  return value;
}

async function waitFor(taskId, state, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const status = await tool("task_status", { task_id: taskId });
    if (status.state === state) return status;
    if (status.state === "failed") throw new Error(`failed: ${JSON.stringify(status)}`);
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "scenario", version: "0" },
  });
  console.log("ok - MCP initialize (Claude Code side)");

  const delegated = await tool("delegate_task", {
    goal: "do mock work [gate]",
    raw_request: "do mock work",
  });
  assert.match(delegated.taskId, /^t_/);
  assert.equal(delegated.target.harness, "pi");
  console.log("ok - delegate_task to b1/pi");

  await waitFor(delegated.taskId, "waiting");
  const inbox = await tool("list_inbox", {});
  const question = inbox.find((item) => item.taskId === delegated.taskId);
  assert.ok(question, "question should be in inbox");
  console.log("ok - pi gate visible through MCP");

  await tool("answer_question", {
    question_id: question.id,
    decision: "approve",
    text: "approved",
  });
  const completed = await waitFor(delegated.taskId, "completed");
  assert.match(completed.summary, /mock-pi: approved/);
  console.log("ok - pi resumed and completed; scenario passed");
} finally {
  child.kill();
  await gateway.close();
  await runner.close();
}

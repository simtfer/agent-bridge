import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";
import { Gateway } from "../src/gateway.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-test-"));
const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  adapters: { echo: true, opencode: false, pi: false },
});
const runnerAddress = await runner.listen();
const runnerUrl = `http://127.0.0.1:${runnerAddress.port}`;

const gateway = new Gateway({
  port: 0,
  host: "127.0.0.1",
  token: "",
  dataDir: path.join(temp, "gateway"),
  runner: { url: runnerUrl, token: "" },
});
const gatewayAddress = await gateway.listen();
const base = `http://127.0.0.1:${gatewayAddress.port}`;

async function call(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text}`);
  return data;
}

async function waitFor(taskId, predicate, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const task = await call("GET", `/v1/tasks/${taskId}`);
    if (predicate(task)) return task;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${taskId}: ${JSON.stringify(task)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const checks = [];
function ok(name) {
  checks.push(name);
  console.log(`ok - ${name}`);
}

try {
  const session = await call("POST", "/v1/sessions", {
    target: { runner: "local", harness: "echo" },
  });
  assert.match(session.id, /^s_/);
  ok("create session");

  const created = await call("POST", "/v1/tasks", {
    sessionId: session.id,
    goal: "say hello",
    constraints: ["no network"],
    acceptance: ["reply"],
  });
  assert.match(created.taskId, /^t_/);
  ok("submit task");

  const done = await waitFor(created.taskId, (task) => task.state === "completed");
  assert.equal(done.target.harness, "echo");
  assert.match(done.summary || "", /echo: say hello/);
  ok("task completes and keeps session target");

  const gate = await call("POST", "/v1/tasks", {
    sessionId: session.id,
    goal: "needs approval [gate]",
  });
  await waitFor(gate.taskId, (task) => task.state === "waiting");
  const inbox = await call("GET", "/v1/inbox");
  const question = inbox.questions.find((item) => item.taskId === gate.taskId);
  assert.ok(question, "question should be in inbox");
  ok("gate reaches inbox");

  await call("POST", `/v1/questions/${question.id}/answer`, {
    decision: "approve",
    text: "go ahead",
    actor: "test",
  });
  const approved = await waitFor(gate.taskId, (task) => task.state === "completed");
  assert.match(approved.summary || "", /answer accepted/);
  ok("answer resumes the run");

  const canceled = await call("POST", "/v1/tasks", {
    sessionId: session.id,
    goal: "cancel me [gate]",
  });
  await waitFor(canceled.taskId, (task) => task.state === "waiting");
  await call("POST", `/v1/tasks/${canceled.taskId}/cancel`);
  await waitFor(canceled.taskId, (task) => task.state === "canceled");
  ok("cancel task");

  const wrong = await call("GET", "/v1/snapshot").catch((error) => error);
  assert.ok(wrong.tasks, "snapshot should include tasks");
  ok("snapshot");

  console.log(`\n${checks.length} checks passed`);
} finally {
  await gateway.close();
  await runner.close();
}

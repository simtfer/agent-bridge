import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-gw-recovery-"));
const runnerPort = 8796;
const gatewayPort = 8797;
const runnerConfigPath = path.join(temp, "runner.json");
const gatewayConfigPath = path.join(temp, "gateway.json");

fs.writeFileSync(
  runnerConfigPath,
  JSON.stringify(
    {
      port: runnerPort,
      host: "127.0.0.1",
      token: "",
      workRoot: path.join(temp, "work"),
      stateRoot: path.join(temp, "state"),
      maxConcurrent: 2,
      jobObject: false,
      repos: {},
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  gatewayConfigPath,
  JSON.stringify(
    {
      port: gatewayPort,
      host: "127.0.0.1",
      token: "",
      dataDir: path.join(temp, "gateway"),
      runners: { local: { url: `http://127.0.0.1:${runnerPort}`, token: "" } },
    },
    null,
    2,
  ),
);

const entry = path.resolve("bin/agent-bridge.mjs");
const gatewayBase = `http://127.0.0.1:${gatewayPort}`;

function startRunner() {
  const child = spawn(process.execPath, [entry, "runner", "--config", runnerConfigPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

function startGateway() {
  const child = spawn(process.execPath, [entry, "gateway", "--config", gatewayConfigPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function wait(url, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function get(pathname) {
  return fetch(`${gatewayBase}${pathname}`).then((response) => response.json());
}

let runner = startRunner();
let gateway = startGateway();

try {
  await wait(`http://127.0.0.1:${runnerPort}/health`);
  await wait(`${gatewayBase}/health`);

  const session = await fetch(`${gatewayBase}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: { runner: "local", harness: "echo" } }),
  }).then((response) => response.json());

  const task = await fetch(`${gatewayBase}/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: session.id,
      goal: "gateway recovery",
      delayMs: 15000,
    }),
  }).then((response) => response.json());

  for (let i = 0; i < 50; i++) {
    const current = await get(`/v1/tasks/${task.taskId}`);
    if (current.state === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  runner.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  runner = startRunner();
  await wait(`http://127.0.0.1:${runnerPort}/health`);

  let interrupted = false;
  for (let i = 0; i < 100; i++) {
    const current = await get(`/v1/tasks/${task.taskId}`);
    if (current.state === "interrupted") {
      interrupted = true;
      break;
    }
    if (current.state === "failed") throw new Error(`task failed during restart: ${current.error}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(interrupted, "gateway should observe interrupted state");
  console.log("ok - gateway relay reconnected and saw interrupted");

  await fetch(`${gatewayBase}/v1/tasks/${task.taskId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "continue" }),
  });

  const started = Date.now();
  for (;;) {
    const current = await get(`/v1/tasks/${task.taskId}`);
    if (current.state === "completed") {
      assert.match(current.summary, /answer accepted: continue/);
      console.log("ok - gateway resumed the recovered task");
      break;
    }
    if (current.state === "failed") throw new Error(`resume failed: ${current.error}`);
    if (Date.now() - started > 20000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
} finally {
  runner.kill();
  gateway.kill();
}

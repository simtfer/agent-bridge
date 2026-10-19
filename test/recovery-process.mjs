import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-crash-"));
const port = 8795;
const configPath = path.join(temp, "runner.json");
const config = {
  port,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  maxConcurrent: 2,
  jobObject: false,
  defaultModel: "opencode/deepseek-v4.1-flash-free",
  repos: {},
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

const entry = path.resolve("bin/agent-bridge.mjs");
const base = `http://127.0.0.1:${port}`;

function start() {
  const child = spawn(process.execPath, [entry, "runner", "--config", configPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitHealth(timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error("runner did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function get(pathname) {
  return fetch(`${base}${pathname}`).then((response) => response.json());
}

let child = start();
try {
  await waitHealth();
  const created = await fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: {
        id: "t_crash",
        goal: "survive a crash",
        rawRequest: "survive a crash",
        delayMs: 15000,
        target: { runner: "local", harness: "echo" },
      },
    }),
  }).then((response) => response.json());

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await get(`/v1/runs/${created.runId}`)).state, "running");

  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));

  child = start();
  await waitHealth();

  const recovered = await get(`/v1/runs/${created.runId}`);
  assert.equal(recovered.state, "interrupted");
  console.log("ok - run survived a hard restart as interrupted");

  await fetch(`${base}/v1/runs/${created.runId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "continue after crash" }),
  });

  const started = Date.now();
  for (;;) {
    const run = await get(`/v1/runs/${created.runId}`);
    if (run.state === "completed") {
      assert.match(run.lastText, /answer accepted: continue after crash/);
      console.log("ok - recovered run resumed and completed");
      break;
    }
    if (run.state === "failed") throw new Error(`resume failed: ${JSON.stringify(run)}`);
    if (Date.now() - started > 15000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  child.kill();
}

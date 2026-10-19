import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-concurrency-"));
const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  maxConcurrent: 2,
  adapters: { echo: true },
});
const address = await runner.listen();
const base = `http://127.0.0.1:${address.port}`;

async function get(runId) {
  return fetch(`${base}/v1/runs/${runId}`).then((response) => response.json());
}

try {
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const created = await fetch(`${base}/v1/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: {
          id: `t_${i}`,
          goal: `slow task ${i}`,
          rawRequest: `slow task ${i}`,
          delayMs: 400,
          target: { runner: "local", harness: "echo" },
        },
      }),
    }).then((response) => response.json());
    runs.push(created.runId);
  }

  let maxRunning = 0;
  let sawQueued = false;
  const started = Date.now();
  for (;;) {
    const states = await Promise.all(runs.map((runId) => get(runId)));
    const running = states.filter((run) => run.state === "running").length;
    if (states.some((run) => run.state === "queued")) sawQueued = true;
    maxRunning = Math.max(maxRunning, running);
    assert.ok(running <= 2, `running=${running} exceeds maxConcurrent=2`);
    if (states.every((run) => run.state === "completed")) break;
    if (Date.now() - started > 20000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  assert.ok(maxRunning === 2, `expected 2 concurrent runs, saw ${maxRunning}`);
  assert.ok(sawQueued, "expected at least one queued run");
  console.log(`ok - maxConcurrent respected (peak ${maxRunning}, queued seen)`);
} finally {
  await runner.close();
}

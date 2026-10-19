import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";
import { writeJsonAtomic } from "../src/util.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-recovery-"));
const stateRoot = path.join(temp, "state");
const workRoot = path.join(temp, "work");
const runId = "run_recover";
const stateDir = path.join(stateRoot, "runs", runId);
const workdir = path.join(workRoot, runId);
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(workdir, { recursive: true });

const task = {
  id: "t_recover",
  goal: "recover me",
  rawRequest: "recover me",
  target: { runner: "local", harness: "echo" },
};
const createdAt = new Date().toISOString();

await writeJsonAtomic(path.join(stateDir, "run.json"), {
  id: runId,
  task,
  state: "running",
  seq: 2,
  workdir,
  stateDir,
  sessionRef: null,
  gate: null,
  gateHandled: false,
  lastText: "partial output",
  usage: null,
  question: null,
  started: true,
  finalized: false,
  createdAt,
});
fs.writeFileSync(
  path.join(stateDir, "events.jsonl"),
  [
    { seq: 1, runId, taskId: task.id, ts: createdAt, type: "state", data: { state: "running" } },
    { seq: 2, runId, taskId: task.id, ts: createdAt, type: "message", data: { text: "partial output" } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n") + "\n",
);

const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot,
  stateRoot,
  maxConcurrent: 2,
});
const address = await runner.listen();
const base = `http://127.0.0.1:${address.port}`;

async function get(pathname) {
  return fetch(`${base}${pathname}`).then((response) => response.json());
}

try {
  const loaded = await get(`/v1/runs/${runId}`);
  assert.equal(loaded.state, "interrupted");
  console.log("ok - runner restart marks running tasks interrupted");

  await fetch(`${base}/v1/runs/${runId}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "continue" }),
  });

  const started = Date.now();
  for (;;) {
    const run = await get(`/v1/runs/${runId}`);
    if (run.state === "completed") {
      assert.match(run.lastText, /answer accepted: continue/);
      console.log("ok - interrupted task resumed and completed");
      break;
    }
    if (run.state === "failed") throw new Error(`resume failed: ${JSON.stringify(run)}`);
    if (Date.now() - started > 10000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
} finally {
  await runner.close();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-pi-mock-"));
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
const address = await runner.listen();
const base = `http://127.0.0.1:${address.port}`;

async function get(runId) {
  return fetch(`${base}/v1/runs/${runId}`).then((response) => response.json());
}

async function start(goal) {
  return fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: {
        id: `t_${Math.random().toString(16).slice(2, 8)}`,
        goal,
        rawRequest: goal,
        target: { runner: "local", harness: "pi" },
      },
    }),
  }).then((response) => response.json());
}

async function waitFor(runId, predicate, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const run = await get(runId);
    if (predicate(run)) return run;
    if (run.state === "failed") throw new Error(`run failed: ${JSON.stringify(run)}`);
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

try {
  const simple = await start("say hi");
  const completed = await waitFor(simple.runId, (run) => run.state === "completed");
  assert.match(completed.lastText, /mock-pi:/);
  assert.equal(completed.sessionRef, "mock-session");
  console.log("ok - pi adapter speaks RPC and captures session id");

  const gated = await start("gate test [gate]");
  const waiting = await waitFor(gated.runId, (run) => run.state === "waiting" && run.question);
  assert.match(waiting.question.title, /Mock pi gate/);
  console.log("ok - pi gate reaches the inbox");

  await fetch(`${base}/v1/runs/${gated.runId}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "answer", text: "approved" }),
  });
  const resumed = await waitFor(gated.runId, (run) => run.state === "completed");
  assert.match(resumed.lastText, /mock-pi: approved/);
  console.log("ok - pi resumes after a gate");
} finally {
  await runner.close();
}

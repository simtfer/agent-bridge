import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-gate-"));
const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  defaultModel: "opencode/deepseek-v4.1-flash-free",
});
const address = await runner.listen();
const base = `http://127.0.0.1:${address.port}`;

const task = {
  id: "t_gate",
  goal:
    'Ask the human for approval before doing anything. Output exactly one line: ' +
    '<<<GATE {"kind":"approval","title":"Approve echo?","detail":{"command":"echo hi"}}>>> ' +
    "and then stop.",
  rawRequest: "gate test",
  constraints: [],
  acceptance: [],
  gates: ["approval"],
  target: {
    runner: "local",
    harness: "opencode",
    model: "opencode/deepseek-v4.1-flash-free",
  },
};

async function get(pathname) {
  return fetch(`${base}${pathname}`).then((response) => response.json());
}

try {
  const created = await fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  }).then((response) => response.json());
  console.log("run:", created.runId);

  let question = null;
  const started = Date.now();
  for (;;) {
    const run = await get(`/v1/runs/${created.runId}`);
    if (run.state === "waiting" && run.question) {
      question = run.question;
      break;
    }
    if (run.state === "completed" || run.state === "failed") {
      throw new Error(`expected gate, got ${run.state}: ${JSON.stringify(run)}`);
    }
    if (Date.now() - started > 120000) throw new Error("timeout waiting for gate");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("gate:", question.title);
  assert.match(question.title, /approve/i);

  await fetch(`${base}/v1/runs/${created.runId}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "answer", text: "Approved. Reply with DONE and stop." }),
  });

  for (;;) {
    const run = await get(`/v1/runs/${created.runId}`);
    if (run.state === "completed") {
      console.log("summary:", JSON.stringify(run.lastText));
      assert.match(run.lastText, /DONE/);
      break;
    }
    if (run.state === "failed") throw new Error(`resume failed: ${JSON.stringify(run)}`);
    if (Date.now() - started > 180000) throw new Error("timeout waiting for resume");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("live gate check passed");
} finally {
  await runner.close();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-live-"));
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
  id: "t_live",
  goal: "Reply with exactly OK",
  rawRequest: "Reply with exactly OK",
  constraints: [],
  acceptance: ["reply is OK"],
  gates: [],
  target: {
    runner: "local",
    harness: "opencode",
    model: "opencode/deepseek-v4.1-flash-free",
  },
};

try {
  const created = await fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  }).then((response) => response.json());
  console.log("run:", created.runId);

  const started = Date.now();
  for (;;) {
    const run = await fetch(`${base}/v1/runs/${created.runId}`).then((response) =>
      response.json(),
    );
    if (run.state === "completed" || run.state === "failed" || run.state === "canceled") {
      console.log("state:", run.state);
      console.log("summary:", JSON.stringify(run.lastText));
      assert.equal(run.state, "completed");
      assert.match(run.lastText, /OK/);
      break;
    }
    if (Date.now() - started > 120000) throw new Error(`timeout: ${JSON.stringify(run)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("live opencode check passed");
} finally {
  await runner.close();
}

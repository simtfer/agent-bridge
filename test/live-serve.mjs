import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-serve-"));
const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  maxConcurrent: 2,
  opencodeMode: "serve",
  opencodeServerPort: 4097,
  defaultModel: "opencode/deepseek-v4.1-flash-free",
});
const address = await runner.listen();
const base = `http://127.0.0.1:${address.port}`;

try {
  const created = await fetch(`${base}/v1/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task: {
        id: "t_serve",
        goal: "Reply with exactly OK",
        rawRequest: "Reply with exactly OK",
        target: {
          runner: "local",
          harness: "opencode",
          model: "opencode/deepseek-v4.1-flash-free",
        },
      },
    }),
  }).then((response) => response.json());

  const started = Date.now();
  for (;;) {
    const run = await fetch(`${base}/v1/runs/${created.runId}`).then((response) =>
      response.json(),
    );
    if (run.state === "completed") {
      assert.match(run.lastText, /OK/);
      console.log("ok - opencode serve session completed");
      break;
    }
    if (run.state === "failed") throw new Error(`serve run failed: ${JSON.stringify(run)}`);
    if (Date.now() - started > 120000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
} finally {
  await runner.close();
}

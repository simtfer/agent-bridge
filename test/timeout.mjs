import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner } from "../src/runner.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bridge-timeout-"));
const runner = new Runner({
  port: 0,
  host: "127.0.0.1",
  token: "",
  workRoot: path.join(temp, "work"),
  stateRoot: path.join(temp, "state"),
  taskTimeoutSec: 1,
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
        id: "t_timeout",
        goal: "Write a very long essay about distributed systems, at least 2000 words.",
        rawRequest: "long task",
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
    if (run.state === "failed") {
      console.log(`ok - timeout killed the run in ${Math.round((Date.now() - started) / 1000)}s`);
      break;
    }
    if (run.state === "completed") throw new Error("expected timeout, run completed");
    if (Date.now() - started > 30000) throw new Error("timeout test hung");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
} finally {
  await runner.close();
}

import { spawn } from "node:child_process";
import { truncate, isWindows } from "../util.mjs";

const GATE_RE = /^\s*```(?:json)?\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*```\s*$|^\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*$/;

function killTree(pid) {
  if (!pid) return;
  if (isWindows()) {
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Drives `opencode run --format json`.
 *
 * Long waits use "checkpoint and release": the process exits when it emits a
 * gate, and the answer is delivered by a new `--session <id>` invocation.
 */
export class OpencodeAdapter {
  constructor(options) {
    this.cwd = options.cwd;
    this.model = options.model || null;
    this.agent = options.agent || null;
    this.bin = options.bin || "opencode";
    this.sessionId = options.sessionId || null;
    this.onEvent = options.onEvent;
    this.wrapSpawn = options.wrapSpawn;
    this.child = null;
    this.canceled = false;
    this.gate = null;
    this.lastText = "";
  }

  async run(prompt) {
    return this.#spawn(prompt, false);
  }

  async respond(text) {
    this.gate = null;
    this.lastText = "";
    await this.#waitForExit();
    return this.#spawn(text, true);
  }

  async steer(text) {
    // `opencode run` has no running-session injection; queue as a follow-up run.
    this.onEvent("log", { message: "steer queued until the next run", text });
    this.pendingSteer = text;
  }

  async cancel() {
    this.canceled = true;
    if (this.child?.pid) killTree(this.child.pid);
  }

  #waitForExit(timeoutMs = 8000) {
    if (!this.child) return Promise.resolve();
    const child = this.child;
    killTree(child.pid);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("close", finish);
      setTimeout(finish, timeoutMs);
    });
  }

  #spawn(message, resume) {
    if (this.child) throw new Error("opencode adapter is already running");
    this.gate = null;
    this.lastText = "";
    this.canceled = false;

    const args = ["run", "--format", "json", "--dir", this.cwd];
    if (this.model) args.push("--model", this.model);
    if (this.agent) args.push("--agent", this.agent);
    if (resume && this.sessionId) args.push("--session", this.sessionId);
    args.push("--", message);

    this.onEvent("status", { phase: resume ? "resuming" : "starting" });
    const launch = this.wrapSpawn
      ? this.wrapSpawn(this.bin, args)
      : { command: this.bin, args };
    const child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    let buffer = "";

    const handleLine = (line) => {
      line = line.replace(/\r$/, "").trim();
      if (!line) return;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.onEvent("log", { stream: "stdout", line: truncate(line, 500) });
        return;
      }
      this.#handleRecord(record);
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
    });

    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) this.onEvent("log", { stream: "stderr", line: truncate(line, 800) });
      }
    });

    return new Promise((resolve, reject) => {
      child.on("error", (error) => {
        if (this.child === child) this.child = null;
        this.onEvent("error", { message: `failed to start opencode: ${error.message}` });
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (buffer.trim()) handleLine(buffer);
        this.#checkGate(this.lastText);
        if (this.child === child) this.child = null;
        resolve({
          code,
          signal,
          canceled: this.canceled,
          sessionId: this.sessionId,
          lastText: this.lastText,
          gate: this.gate,
        });
      });
    });
  }

  #handleRecord(record) {
    if (record.sessionID) this.sessionId = record.sessionID;

    switch (record.type) {
      case "step_start":
        this.onEvent("status", { phase: "thinking" });
        return;
      case "text": {
        const text = record.part?.text;
        if (!text) return;
        this.lastText = text;
        this.onEvent("message", { role: "assistant", text });
        return;
      }
      case "tool_use": {
        const part = record.part || {};
        const state = part.state || {};
        this.onEvent("tool", {
          tool: part.tool,
          callId: part.callID,
          status: state.status,
          title: state.title,
          input: state.input,
          output: truncate(state.output, 4000),
        });
        return;
      }
      case "step_finish": {
        const part = record.part || {};
        this.#checkGate(this.lastText);
        this.onEvent("usage", {
          tokens: part.tokens || null,
          cost: part.cost ?? null,
          reason: part.reason || null,
        });
        return;
      }
      case "error": {
        this.onEvent("error", {
          message: record.error?.message || record.part?.error || "opencode error",
        });
        return;
      }
      default:
        this.onEvent("log", { stream: "event", type: record.type });
    }
  }

  #checkGate(text) {
    const match = GATE_RE.exec(text);
    if (!match) return;
    try {
      this.gate = JSON.parse(match[1] || match[2]);
      this.onEvent("gate", this.gate);
    } catch {
      this.onEvent("error", { message: "gate marker was not valid JSON" });
    }
  }
}

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { truncate, isWindows } from "../util.mjs";

const GATE_RE = /^\s*```(?:json)?\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*```\s*$|^\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*$/;

function resolveOnPath(name) {
  const dirs = String(process.env.PATH || "").split(path.delimiter);
  const preferred = name.toLowerCase() === "pi"
    ? [".ps1", ".cmd", ".exe", ".bat"]
    : String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").map((ext) => ext.toLowerCase());
  const extensions = isWindows() ? preferred : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension.toLowerCase()}`);
      if (fs.existsSync(candidate)) return candidate;
      const upper = path.join(dir, `${name}${extension.toUpperCase()}`);
      if (fs.existsSync(upper)) return upper;
    }
  }
  return null;
}

function commandFor(bin) {
  let resolved = bin;
  if (!path.isAbsolute(bin) && !bin.includes("/") && !bin.includes("\\")) {
    resolved = resolveOnPath(bin) || bin;
  }
  const lower = resolved.toLowerCase();
  if (lower.endsWith(".ps1")) {
    return { command: "pwsh", prefix: ["-NoProfile", "-NonInteractive", "-File", resolved] };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { command: "cmd.exe", prefix: ["/d", "/s", "/c", `"${resolved}"`] };
  }
  return { command: resolved, prefix: [] };
}

/**
 * Drives `pi --mode rpc` over strict JSONL stdin/stdout.
 * Pi keeps the process alive between turns, so approval/clarification can be
 * answered without restarting the session.
 */
export class PiAdapter {
  constructor(options) {
    this.cwd = options.cwd;
    this.bin = options.bin || "pi";
    this.model = options.model || null;
    this.provider = options.provider || null;
    this.sessionId = options.sessionId || null;
    this.onEvent = options.onEvent;
    this.wrapSpawn = options.wrapSpawn;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.gate = null;
    this.lastText = "";
    this.settled = false;
    this.running = false;
    this.extensionUiId = null;
    this.canceled = false;
  }

  async run(prompt) {
    this.#start();
    this.settled = false;
    this.running = true;
    this.#send({ type: "prompt", message: prompt });
    return this.#waitForSettled();
  }

  async respond(text) {
    if (!this.child) this.#start();
    if (this.extensionUiId) {
      this.#send({ type: "extension_ui_response", id: this.extensionUiId, value: text });
      this.extensionUiId = null;
      return this.#waitForSettled();
    }
    const streaming = this.running && !this.settled;
    this.gate = null;
    this.settled = false;
    this.running = true;
    this.#send(
      streaming
        ? { type: "prompt", message: text, streamingBehavior: "steer" }
        : { type: "prompt", message: text },
    );
    return this.#waitForSettled();
  }

  async steer(text) {
    this.#send({ type: "steer", message: text });
  }

  async cancel() {
    this.canceled = true;
    try {
      this.#send({ type: "abort" });
    } catch {
      /* process may be gone */
    }
    setTimeout(() => this.child?.kill(), 1500);
  }

  async close() {
    try {
      this.child?.stdin.end();
    } catch {
      /* ignore */
    }
  }

  #start() {
    if (this.child) return;
    const { command, prefix } = commandFor(this.bin);
    const args = [...prefix, "--mode", "rpc"];
    if (this.sessionId) args.push("--session-id", this.sessionId);
    if (this.model) args.push("--model", this.model);
    if (this.provider) args.push("--provider", this.provider);

    this.onEvent("status", { phase: "starting" });
    const launch = this.wrapSpawn
      ? this.wrapSpawn(command, args)
      : { command, args };
    const child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          this.#handleRecord(JSON.parse(line));
        } catch {
          this.onEvent("log", { stream: "stdout", line: truncate(line, 500) });
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) this.onEvent("log", { stream: "stderr", line: truncate(line, 800) });
      }
    });

    try {
      this.#send({ type: "get_state" });
    } catch {
      /* pi may not be ready yet; state is only used for recovery */
    }

    child.on("error", (error) => {
      this.child = null;
      this.onEvent("error", { message: `failed to start pi: ${error.message}` });
      this.#settle({ code: 1, error });
    });

    child.on("close", (code, signal) => {
      this.child = null;
      this.#settle({ code, signal, canceled: this.canceled, lastText: this.lastText });
    });
  }

  #send(command) {
    if (!this.child?.stdin?.writable) throw new Error("pi process is not running");
    const record = command.id ? command : { id: `req-${this.nextId++}`, ...command };
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  #waitForSettled() {
    if (!this.running && this.settled) {
      return Promise.resolve({
        code: 0,
        canceled: this.canceled,
        sessionId: this.sessionId,
        lastText: this.lastText,
        gate: this.gate,
      });
    }
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  #settle(result) {
    this.running = false;
    this.settled = true;
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve({
        ...result,
        sessionId: this.sessionId,
        lastText: this.lastText,
        gate: this.gate,
      });
    }
  }

  #handleRecord(record) {
    switch (record.type) {
      case "response": {
        if (record.success === false) {
          this.onEvent("error", {
            message: `pi ${record.command || "command"} failed: ${record.error || "unknown error"}`,
          });
          if (record.command === "prompt") {
            this.#settle({ code: 1 });
            setTimeout(() => this.child?.kill(), 300);
          }
        } else if (record.command === "get_state" && record.data) {
          this.sessionId = record.data.sessionId || record.data.id || this.sessionId;
          this.sessionFile = record.data.sessionFile || record.data.path || this.sessionFile;
        }
        return;
      }
      case "message_update": {
        const update = record.assistantMessageEvent || {};
        if (update.type === "text_delta") {
          this.lastText += update.delta || "";
          this.onEvent("delta", { text: update.delta || "" });
        } else if (update.type === "text_end") {
          this.lastText = update.content ?? this.lastText;
          this.#checkGate(this.lastText);
          this.onEvent("message", { role: "assistant", text: this.lastText });
        } else if (update.type === "toolcall_end") {
          this.onEvent("tool", {
            tool: update.toolCall?.name,
            status: "requested",
            input: update.toolCall?.arguments,
          });
        }
        return;
      }
      case "tool_execution_start":
        this.onEvent("tool", {
          tool: record.toolName,
          callId: record.toolCallId,
          status: "running",
          input: record.args,
        });
        return;
      case "tool_execution_end":
        this.onEvent("tool", {
          tool: record.toolName,
          callId: record.toolCallId,
          status: record.isError ? "error" : "completed",
          output: truncate(JSON.stringify(record.result ?? ""), 4000),
        });
        return;
      case "extension_ui_request":
        this.extensionUiId = record.id;
        this.gate = {
          kind: record.kind || "clarification",
          title: record.title || record.message || "pi extension request",
          detail: record,
        };
        this.onEvent("gate", this.gate);
        return;
      case "agent_end":
        this.onEvent("status", { phase: "agent_end", willRetry: record.willRetry });
        return;
      case "agent_settled":
        this.running = false;
        this.#checkGate(this.lastText);
        this.#settle({ code: 0, aborted: record.aborted });
        return;
      case "queue_update":
        this.onEvent("log", { queue: { steering: record.steering, followUp: record.followUp } });
        return;
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

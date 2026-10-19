import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  now,
  uid,
  log,
  sendJson,
  sendText,
  readBody,
  authOk,
  sseHead,
  sseSend,
  sseComment,
  parseArgs,
  loadConfig,
  truncate,
  readJson,
  writeJsonAtomic,
  sleep,
} from "./util.mjs";
import { EchoAdapter } from "./adapters/echo.mjs";
import { OpencodeAdapter } from "./adapters/opencode.mjs";
import { OpencodeServerAdapter } from "./adapters/opencode-server.mjs";
import { PiAdapter } from "./adapters/pi.mjs";
import { wrapSpawn, jobrunAvailable } from "./jobrun.mjs";
import { serverTlsOptions, requestJson } from "./http.mjs";

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  port: 8788,
  host: "0.0.0.0",
  token: "",
  workRoot: path.join(os.tmpdir(), "agent-bridge-work"),
  stateRoot: path.join(os.tmpdir(), "agent-bridge-state"),
  repos: {},
  defaultModel: null,
  maxConcurrent: 2,
  jobObject: true,
  jobMemoryMb: 4096,
  jobProcessLimit: 128,
  taskTimeoutSec: 0,
  persistDelayMs: 120,
  opencodeMode: "run",
  opencodeServerPort: 4096,
  piBin: null,
  adapters: { echo: true, opencode: true, pi: true },
};

function buildPrompt(task) {
  const lines = [
    "You are a delegated coding agent running on a remote Windows machine.",
    `Goal: ${task.goal}`,
  ];
  if (task.repo) lines.push(`Repo: ${task.repo} (ref: ${task.baseRef || "current HEAD"})`);
  if (task.repoPath) lines.push(`Workspace: ${task.repoPath}`);
  if (task.constraints?.length) {
    lines.push("Constraints:");
    for (const item of task.constraints) lines.push(`- ${item}`);
  }
  if (task.acceptance?.length) {
    lines.push("Acceptance criteria:");
    for (const item of task.acceptance) lines.push(`- ${item}`);
  }
  if (task.gates?.length) {
    lines.push(`Required gates: ${task.gates.join(", ")}. Stop at each gate and wait.`);
  }
  lines.push(
    "",
    "If you need a human decision or approval, output exactly one line:",
    '<<<GATE {"kind":"approval","title":"short question","detail":{"command":"...","cwd":"..."}}>>>',
    "Then stop immediately. Do not guess and do not continue past the gate.",
    "",
    "Original request:",
    task.rawRequest || task.goal,
    "",
    "When finished, end with a short summary and list changed files.",
  );
  return lines.join("\n");
}

async function git(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
    };
  }
}

async function prepareWorkspace(task, runId, config) {
  const workdir = path.resolve(config.workRoot, runId);
  let repoPath = task.repoPath || (task.repo ? config.repos[task.repo] : null);
  if (repoPath) repoPath = path.resolve(repoPath);

  if (!repoPath) {
    await fsp.mkdir(workdir, { recursive: true });
    return workdir;
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`repo not found on runner: ${repoPath}`);
  }

  const branch = `task/${runId}`;
  const ref = task.baseRef || "HEAD";
  let result = await git(repoPath, ["worktree", "add", "-b", branch, workdir, ref]);
  if (!result.ok) {
    result = await git(repoPath, ["worktree", "add", workdir, ref]);
  }
  if (!result.ok) {
    throw new Error(`git worktree failed: ${result.stderr.trim()}`);
  }
  return workdir;
}

export class Runner {
  constructor(config) {
    this.config = { ...DEFAULTS, ...config };
    this.runs = new Map();
    this.server = null;
    this.useJobObject = this.config.jobObject !== false && jobrunAvailable();
    this.queue = [];
    this.active = 0;
    this.maxConcurrent = Math.max(1, Number(this.config.maxConcurrent) || 1);
    this.opencodeServerUrl = null;
    this.opencodeProcess = null;
  }

  async init() {
    await fsp.mkdir(this.config.workRoot, { recursive: true });
    await fsp.mkdir(this.config.stateRoot, { recursive: true });
    await this.loadRuns();
    if (this.config.opencodeMode === "serve") {
      try {
        await this.ensureOpencodeServer();
        log(`opencode server ready at ${this.opencodeServerUrl}`);
      } catch (error) {
        log(`opencode serve unavailable: ${error.message}`);
      }
    }
  }

  async ensureOpencodeServer() {
    if (this.opencodeServerUrl) return this.opencodeServerUrl;
    const port = Number(this.config.opencodeServerPort) || 4096;
    const url = `http://127.0.0.1:${port}`;

    try {
      await requestJson(`${url}/global/health`, { timeoutMs: 1200 });
      this.opencodeServerUrl = url;
      return url;
    } catch {
      /* not running yet */
    }

    this.opencodeProcess = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.opencodeProcess.stderr?.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) log(`opencode: ${truncate(line, 300)}`);
      }
    });
    this.opencodeProcess.on("exit", (code) => {
      log(`opencode serve exited with ${code}`);
      this.opencodeProcess = null;
      this.opencodeServerUrl = null;
    });

    const started = Date.now();
    for (;;) {
      try {
        await requestJson(`${url}/global/health`, { timeoutMs: 1200 });
        this.opencodeServerUrl = url;
        return url;
      } catch {
        if (Date.now() - started > 20000) {
          throw new Error(`opencode serve did not become healthy on port ${port}`);
        }
        await sleep(300);
      }
    }
  }

  stopOpencodeServer() {
    if (this.opencodeProcess?.pid) {
      spawn("taskkill", ["/PID", String(this.opencodeProcess.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    }
    this.opencodeProcess = null;
    this.opencodeServerUrl = null;
  }

  async loadRuns() {
    const root = path.resolve(this.config.stateRoot, "runs");
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const data = readJson(path.join(dir, "run.json"), null);
      if (!data?.id || !data?.task) continue;

      const events = [];
      try {
        const raw = await fsp.readFile(path.join(dir, "events.jsonl"), "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch {
            /* skip a torn line */
          }
        }
      } catch {
        /* no events yet */
      }

      const run = {
        ...data,
        events,
        clients: new Set(),
        adapter: null,
        persistTimer: null,
        loading: true,
        generation: data.generation || 0,
      };
      run.seq = Math.max(data.seq || 0, ...events.map((event) => event.seq || 0));

      if (run.state === "running" || run.state === "queued") {
        run.state = "interrupted";
        run.started = true;
        run.finalized = true;
        run.active = false;
        run.seq += 1;
        run.events.push({
          seq: run.seq,
          runId: run.id,
          taskId: run.task.id,
          ts: now(),
          type: "state",
          data: { state: "interrupted" },
        });
      } else if (run.state === "waiting") {
        run.started = true;
        run.finalized = true;
        run.active = false;
      }

      run.loading = false;
      this.runs.set(run.id, run);
      this.writeRun(run);
    }
  }

  persist(run, immediate = false) {
    if (!run?.stateDir || run.loading) return;
    if (immediate) {
      if (run.persistTimer) {
        clearTimeout(run.persistTimer);
        run.persistTimer = null;
      }
      this.writeRun(run);
      return;
    }
    if (run.persistTimer) return;
    run.persistTimer = setTimeout(() => {
      run.persistTimer = null;
      this.writeRun(run);
    }, this.config.persistDelayMs);
    run.persistTimer.unref?.();
  }

  writeRun(run) {
    const data = {
      id: run.id,
      task: run.task,
      state: run.state,
      seq: run.seq,
      workdir: run.workdir,
      stateDir: run.stateDir,
      sessionRef: run.sessionRef,
      gate: run.gate,
      gateHandled: run.gateHandled,
      lastText: run.lastText,
      usage: run.usage,
      question: run.question,
      started: run.started,
      finalized: run.finalized,
      createdAt: run.createdAt,
    };
    run.writeChain = (run.writeChain || Promise.resolve())
      .then(() => writeJsonAtomic(path.join(run.stateDir, "run.json"), data))
      .catch((error) => log(`failed to persist ${run.id}: ${error.message}`));
  }

  createAdapter(task, cwd, onEvent, sessionRef = null) {
    const harness = task.target.harness;
    const model = task.target.model || this.config.defaultModel;
    const options = {
      cwd,
      model,
      agent: task.target.agent,
      sessionId: task.target.sessionId || sessionRef,
      permissionRules: this.config.opencodePermission || null,
      task,
      onEvent,
      wrapSpawn: (command, args) =>
        wrapSpawn(command, args, {
          enabled: this.useJobObject,
          cwd,
          timeoutSec: this.config.taskTimeoutSec,
          memoryMb: this.config.jobMemoryMb,
          processLimit: this.config.jobProcessLimit,
        }),
    };
    if (harness === "echo") return new EchoAdapter(options);
    if (harness === "opencode") {
      if (this.config.opencodeMode === "serve") {
        if (!this.opencodeServerUrl) throw new Error("opencode serve is not available");
        return new OpencodeServerAdapter({ ...options, serverUrl: this.opencodeServerUrl });
      }
      return new OpencodeAdapter(options);
    }
    if (harness === "pi") {
      return new PiAdapter({ ...options, bin: this.config.piBin || options.bin });
    }
    throw new Error(`unknown harness: ${harness}`);
  }

  emit(run, type, data) {
    const event = {
      seq: ++run.seq,
      runId: run.id,
      taskId: run.task.id,
      ts: now(),
      type,
      data: data ?? null,
    };
    run.events.push(event);
    if (run.events.length > 5000) run.events.splice(0, run.events.length - 5000);

    const line = `${JSON.stringify(event)}\n`;
    fs.appendFile(path.join(run.stateDir, "events.jsonl"), line, () => {});
    for (const res of run.clients) sseSend(res, type, event, event.seq);
    this.persist(run);
    return event;
  }

  setState(run, state) {
    if (run.state === state) return;
    run.state = state;
    this.emit(run, "state", { state });
    this.persist(run, true);
  }

  async create(task) {
    const run = {
      id: uid("run"),
      task,
      state: "queued",
      seq: 0,
      events: [],
      clients: new Set(),
      createdAt: now(),
      workdir: null,
      stateDir: path.resolve(this.config.stateRoot, "runs", uid("r")),
      adapter: null,
      gate: null,
      gateHandled: false,
      generation: 0,
      lastText: "",
      usage: null,
      question: null,
      started: false,
      active: false,
      finalized: false,
      loading: false,
      persistTimer: null,
    };
    this.runs.set(run.id, run);
    await fsp.mkdir(run.stateDir, { recursive: true });

    try {
      run.workdir = await prepareWorkspace(task, run.id, this.config);
    } catch (error) {
      this.setState(run, "failed");
      this.emit(run, "error", { message: error.message });
      this.emit(run, "done", { state: "failed", error: error.message });
      return run;
    }

    this.emit(run, "state", { state: "queued", workdir: run.workdir });
    this.persist(run, true);
    this.queue.push(run);
    this.pump();
    return run;
  }

  pump() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const run = this.queue.shift();
      if (run.state === "canceled" || run.finalized) continue;
      run.active = true;
      this.active += 1;
      this.start(run, buildPrompt(run.task));
    }
  }

  finalize(run) {
    if (run.finalized) return;
    run.finalized = true;
    if (run.active) {
      run.active = false;
      this.active = Math.max(0, this.active - 1);
    }
    this.persist(run, true);
    this.pump();
  }

  start(run, prompt) {
    run.started = true;
    this.setState(run, "running");
    this.emit(run, "status", { phase: "starting", harness: run.task.target.harness });

    try {
      run.adapter = this.createAdapter(
        run.task,
        run.workdir,
        (type, data) => this.onAdapterEvent(run, type, data),
        run.sessionRef,
      );
    } catch (error) {
      this.fail(run, error.message);
      return;
    }

    const generation = ++run.generation;
    run.adapter
      .run(prompt)
      .then((result) => this.onAdapterExit(run, result, generation))
      .catch((error) => {
        if (generation === run.generation) this.fail(run, `adapter failed: ${error.message}`);
      });
  }

  onAdapterEvent(run, type, data) {
    switch (type) {
      case "status":
        return this.emit(run, "status", data);
      case "message":
        run.lastText = data.text || run.lastText;
        return this.emit(run, "message", data);
      case "delta":
        return this.emit(run, "delta", data);
      case "tool":
        return this.emit(run, "tool", data);
      case "usage":
        run.usage = data;
        return this.emit(run, "usage", data);
      case "log":
        return this.emit(run, "log", data);
      case "error":
        return this.emit(run, "error", data);
      case "gate":
        return this.onGate(run, data);
      default:
        return this.emit(run, type, data);
    }
  }

  onGate(run, gate) {
    if (run.gateHandled) return;
    run.gateHandled = true;
    run.gate = gate;
    this.setState(run, "waiting");
    const question = {
      id: uid("q"),
      runId: run.id,
      taskId: run.task.id,
      kind: gate.kind || "approval",
      title: gate.title || "需要人工确认",
      detail: gate.detail ?? gate,
      options: gate.options || ["approve", "deny"],
      createdAt: now(),
      answer: null,
      answeredBy: null,
      answeredAt: null,
    };
    run.question = question;
    this.emit(run, "question", question);
    this.persist(run, true);
    // The process is parked; free the slot for queued tasks.
    this.finalize(run);

    // opencode is one-shot: stop it so a long human wait does not hold a process.
    if (run.task.target.harness === "opencode" && !run.adapter?.longLived) {
      setTimeout(() => {
        if (run.state === "waiting") run.adapter?.cancel().catch(() => {});
      }, 1200);
    }
  }

  onAdapterExit(run, result, generation) {
    if (generation !== undefined && generation !== run.generation) return;
    run.sessionRef = result?.sessionId || run.sessionRef;
    if (result?.lastText) run.lastText = result.lastText;

    if (run.state === "canceled") {
      this.emit(run, "done", { state: "canceled", summary: run.lastText });
      this.finalize(run);
      return;
    }
    if (run.state === "waiting" && run.gate) {
      this.emit(run, "status", { phase: "paused", reason: "waiting_for_human" });
      this.finalize(run);
      return;
    }
    if (result?.code === 0 || result?.code === null) {
      this.setState(run, "completed");
      this.emit(run, "done", {
        state: "completed",
        summary: run.lastText,
        usage: run.usage,
        sessionRef: run.sessionRef,
        workdir: run.workdir,
      });
      this.finalize(run);
      return;
    }
    this.fail(run, `harness exited with code ${result?.code}${result?.signal ? ` (${result.signal})` : ""}`);
  }

  fail(run, message) {
    this.setState(run, "failed");
    this.emit(run, "error", { message });
    this.emit(run, "done", { state: "failed", error: message });
    this.finalize(run);
  }

  ensureAdapter(run) {
    if (!run.adapter) {
      run.adapter = this.createAdapter(
        run.task,
        run.workdir,
        (type, data) => this.onAdapterEvent(run, type, data),
        run.sessionRef,
      );
    }
    return run.adapter;
  }

  async resume(run, text) {
    if (run.state !== "interrupted") {
      throw new Error(`run is ${run.state}, only interrupted runs can resume`);
    }
    const message =
      text ||
      "The runner process restarted. Continue this task from the current workspace state. " +
        "First re-check git status and any partial changes, then proceed.";
    run.gate = null;
    run.gateHandled = false;
    run.finalized = false;
    run.active = true;
    this.active += 1;
    this.setState(run, "running");
    this.emit(run, "status", { phase: "resuming_after_restart" });

    const generation = ++run.generation;
    try {
      const result = await this.ensureAdapter(run).respond(message);
      this.onAdapterExit(run, result, generation);
    } catch (error) {
      this.fail(run, `resume after restart failed: ${error.message}`);
    }
    return { ok: true };
  }

  async input(run, input) {
    const { kind = "answer", text = "", actor = "unknown" } = input;
    if (run.state === "waiting") {
      if (run.question) {
        run.question.answer = kind === "deny" ? "deny" : text || kind;
        run.question.answeredBy = actor;
        run.question.answeredAt = now();
      }
      run.gate = null;
      run.gateHandled = false;
      // Resume gets priority; it may temporarily exceed maxConcurrent.
      run.finalized = false;
      if (!run.active) {
        run.active = true;
        this.active += 1;
      }
      this.setState(run, "running");
      this.emit(run, "answer", { kind, text, actor });
      const message =
        kind === "deny"
          ? "The human denied this action. Stop and explain what is blocked."
          : text;
      try {
        const generation = ++run.generation;
        const adapter = this.ensureAdapter(run);
        const result = await adapter.respond(message);
        this.onAdapterExit(run, result, generation);
      } catch (error) {
        this.fail(run, `resume failed: ${error.message}`);
      }
      return { ok: true };
    }

    if (run.state === "running") {
      await run.adapter.steer(text);
      this.emit(run, "steer", { text, actor });
      return { ok: true };
    }

    throw new Error(`run is ${run.state}, cannot accept input`);
  }

  async cancel(run) {
    if (run.state === "completed" || run.state === "failed" || run.state === "canceled") {
      return { ok: true };
    }
    if (!run.started) {
      const index = this.queue.indexOf(run);
      if (index >= 0) this.queue.splice(index, 1);
      this.setState(run, "canceled");
      this.emit(run, "done", { state: "canceled", summary: run.lastText });
      return { ok: true };
    }
    this.setState(run, "canceled");
    try {
      await run.adapter?.cancel();
    } catch {
      /* ignore */
    }
    this.emit(run, "done", { state: "canceled", summary: run.lastText });
    this.finalize(run);
    return { ok: true };
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        runs: this.runs.size,
        active: this.active,
        queued: this.queue.length,
        maxConcurrent: this.maxConcurrent,
        jobObject: this.useJobObject,
        workRoot: this.config.workRoot,
      });
    }
    if (!authOk(req, this.config.token)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "POST" && pathname === "/v1/run") {
      const body = await readBody(req);
      if (!body?.task?.goal) return sendJson(res, 400, { error: "task.goal required" });
      const run = await this.create(body.task);
      return sendJson(res, 202, { runId: run.id, state: run.state, workdir: run.workdir });
    }

    const runMatch = pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = this.runs.get(runMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      return sendJson(res, 200, {
        runId: run.id,
        taskId: run.task.id,
        state: run.state,
        workdir: run.workdir,
        question: run.question,
        usage: run.usage,
        lastText: run.lastText,
        sessionRef: run.sessionRef,
        seq: run.seq,
      });
    }

    const eventsMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const run = this.runs.get(eventsMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      const after = Number(url.searchParams.get("after") || 0);
      sseHead(res);
      for (const event of run.events) {
        if (event.seq > after) sseSend(res, event.type, event, event.seq);
      }
      run.clients.add(res);
      const heartbeat = setInterval(() => sseComment(res), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        run.clients.delete(res);
      });
      return;
    }

    const resumeMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const run = this.runs.get(resumeMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      const body = (await readBody(req)) || {};
      try {
        return sendJson(res, 200, await this.resume(run, body.text));
      } catch (error) {
        return sendJson(res, 409, { error: error.message });
      }
    }

    const inputMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/input$/);
    if (req.method === "POST" && inputMatch) {
      const run = this.runs.get(inputMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      const body = await readBody(req);
      try {
        const result = await this.input(run, body || {});
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 409, { error: error.message });
      }
    }

    const cancelMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const run = this.runs.get(cancelMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      return sendJson(res, 200, await this.cancel(run));
    }

    const diffMatch = pathname.match(/^\/v1\/runs\/([^/]+)\/diff$/);
    if (req.method === "GET" && diffMatch) {
      const run = this.runs.get(diffMatch[1]);
      if (!run) return sendJson(res, 404, { error: "run not found" });
      const result = await git(run.workdir, ["diff", "--stat", "--patch"]);
      return sendText(res, 200, truncate(result.stdout || result.stderr, 200000));
    }

    return sendJson(res, 404, { error: "not found" });
  }

  async listen() {
    await this.init();
    const handler = (req, res) => {
      this.handle(req, res).catch((error) => {
        log("runner error:", error);
        sendJson(res, 500, { error: error.message });
      });
    };
    this.server = this.config.tls?.cert
      ? https.createServer(serverTlsOptions(this.config.tls), handler)
      : http.createServer(handler);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.server.address();
  }

  async close() {
    for (const run of this.runs.values()) {
      try {
        await run.adapter?.cancel();
        await run.adapter?.close?.();
      } catch {
        /* ignore */
      }
      for (const res of run.clients) res.end();
    }
    this.stopOpencodeServer();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

export async function runRunner(argv = []) {
  const args = parseArgs(argv);
  const config = loadConfig(args.config || "config/runner.json");
  const runner = new Runner(config);
  const address = await runner.listen();
  const scheme = runner.config.tls?.cert ? "https" : "http";
  log(`runner listening on ${scheme}://${config.host}:${address.port}`);
  log(`workRoot=${runner.config.workRoot}`);
  log(`jobObject=${runner.useJobObject ? "on" : "off"}`);
  return runner;
}

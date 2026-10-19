import http from "node:http";
import https from "node:https";
import {
  now,
  log,
  sendJson,
  sendText,
  readBody,
  authOk,
  sseHead,
  sseSend,
  sseComment,
  createSseParser,
  parseArgs,
  loadConfig,
  sleep,
} from "./util.mjs";
import { request, requestJson, requestStatus, serverTlsOptions } from "./http.mjs";
import { Store, TERMINAL_STATES } from "./store.mjs";

const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  token: "",
  dataDir: "./data",
  runner: { url: "http://127.0.0.1:8788", token: "" },
};

function runnerHeaders(runner) {
  const headers = { "content-type": "application/json" };
  if (runner?.token) headers["x-bridge-token"] = runner.token;
  return headers;
}

export class Gateway {
  constructor(config) {
    this.config = { ...DEFAULTS, ...config };
    this.runners = { ...(config.runners || {}) };
    if (config.runner?.url) {
      this.runners.local = { ...config.runner, ...(this.runners.local || {}) };
    }
    this.store = new Store(this.config.dataDir);
    this.server = null;
    this.globalClients = new Set();
    this.taskClients = new Map();
  }

  runnerFor(name) {
    return this.runners[name] || null;
  }

  async init() {
    await this.store.init();
  }

  async submit(task) {
    const runner = this.runnerFor(task.target.runner);
    if (!runner) {
      const message = `unknown runner: ${task.target.runner}`;
      this.store.updateTask(task.id, { state: "failed", error: message });
      this.store.addEvent(task.id, "error", { message });
      this.store.addEvent(task.id, "done", { state: "failed", error: message });
      return;
    }
    this.store.updateTask(task.id, { state: "queued" });
    try {
      const payload = await requestJson(`${runner.url}/v1/run`, {
        method: "POST",
        headers: runnerHeaders(runner),
        body: { task },
        tls: runner.tls,
      });
      this.store.updateTask(task.id, {
        runnerRunId: payload.runId,
        state: payload.state || "running",
        workdir: payload.workdir,
      });
      this.store.addEvent(task.id, "submitted", {
        runnerRunId: payload.runId,
        workdir: payload.workdir,
      });
      this.relay(task.id, payload.runId, runner).catch((error) =>
        log("relay stopped:", error.message),
      );
    } catch (error) {
      this.store.updateTask(task.id, { state: "failed", error: error.message });
      this.store.addEvent(task.id, "error", { message: error.message });
      this.store.addEvent(task.id, "done", { state: "failed", error: error.message });
    }
  }

  broadcast(event) {
    for (const res of this.globalClients) sseSend(res, event.type, event, event.seq);
    const clients = this.taskClients.get(event.taskId);
    if (clients) for (const res of clients) sseSend(res, event.type, event, event.seq);
  }

  applyEvent(taskId, event) {
    const stored = this.store.addEvent(taskId, event.type, event.data);
    this.broadcast(stored);
    const task = this.store.getTask(taskId);
    if (!task) return;

    switch (event.type) {
      case "state":
        if (event.data?.state) this.store.updateTask(taskId, { state: event.data.state });
        break;
      case "question":
        this.store.addQuestion(taskId, event.data, false);
        break;
      case "usage":
        this.store.updateTask(taskId, { usage: event.data });
        break;
      case "error":
        this.store.updateTask(taskId, { error: event.data?.message || "error" });
        break;
      case "done": {
        const state = event.data?.state || "completed";
        this.store.updateTask(taskId, {
          state,
          summary: event.data?.summary || task.summary,
          error: event.data?.error || task.error,
          usage: event.data?.usage || task.usage,
          workdir: event.data?.workdir || task.workdir,
        });
        break;
      }
      default:
        break;
    }
  }

  async relay(taskId, runId, runner) {
    let after = 0;
    let failures = 0;

    while (true) {
      const task = this.store.getTask(taskId);
      if (!task || TERMINAL_STATES.has(task.state)) return;

      try {
        const response = await request(
          `${runner.url}/v1/runs/${encodeURIComponent(runId)}/events?after=${after}`,
          { headers: runnerHeaders(runner), tls: runner.tls },
        );
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

        let stop = false;
        const parser = createSseParser(({ event, data }) => {
          if (data && typeof data.seq === "number") after = Math.max(after, data.seq);
          this.applyEvent(taskId, { type: event, data: data?.data ?? data });
          const current = this.store.getTask(taskId);
          if (current && TERMINAL_STATES.has(current.state)) stop = true;
        });

        for await (const chunk of response.stream) {
          parser.push(chunk.toString("utf8"));
          if (stop) break;
        }
        if (stop) {
          response.stream.destroy();
          return;
        }
        failures = 0;
      } catch (error) {
        failures += 1;
        this.store.addEvent(taskId, "log", {
          message: `relay reconnect ${failures}: ${error.message}`,
        });
        if (failures > 60) {
          this.store.updateTask(taskId, { state: "failed", error: error.message });
          const event = this.store.addEvent(taskId, "done", {
            state: "failed",
            error: `lost contact with runner: ${error.message}`,
          });
          this.broadcast(event);
          return;
        }
        await sleep(Math.min(15000, 500 * failures));
      }
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (pathname === "/health") {
      return sendJson(res, 200, { ok: true, tasks: this.store.listTasks().length });
    }
    if (!authOk(req, this.config.token)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "POST" && pathname === "/v1/sessions") {
      const body = await readBody(req);
      if (!body?.target?.runner || !body?.target?.harness) {
        return sendJson(res, 400, { error: "target.runner and target.harness required" });
      }
      if (!this.runnerFor(body.target.runner)) {
        return sendJson(res, 400, {
          error: `unknown runner: ${body.target.runner}`,
          known: Object.keys(this.runners),
        });
      }
      const session = this.store.createSession(body.target);
      return sendJson(res, 201, session);
    }

    if (req.method === "GET" && pathname === "/v1/sessions") {
      return sendJson(res, 200, { sessions: this.store.listSessions() });
    }

    if (req.method === "GET" && pathname === "/v1/inbox") {
      return sendJson(res, 200, { questions: this.store.listInbox() });
    }

    if (req.method === "POST" && pathname === "/v1/tasks") {
      const body = await readBody(req);
      if (!body?.goal) return sendJson(res, 400, { error: "goal required" });
      const sessionId = body.sessionId || req.headers["x-session-id"];
      const session = this.store.getSession(sessionId);
      if (!session) return sendJson(res, 404, { error: `unknown session: ${sessionId}` });

      const task = this.store.createTask(session, body);
      this.submit(task);
      return sendJson(res, 202, {
        taskId: task.id,
        sessionId: session.id,
        target: task.target,
        state: "queued",
      });
    }

    if (req.method === "GET" && pathname === "/v1/tasks") {
      return sendJson(res, 200, { tasks: this.store.listTasks() });
    }

    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
    if (req.method === "GET" && taskMatch) {
      const task = this.store.getTask(taskMatch[1]);
      if (!task) return sendJson(res, 404, { error: "task not found" });
      return sendJson(res, 200, task);
    }

    const eventsMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const task = this.store.getTask(eventsMatch[1]);
      if (!task) return sendJson(res, 404, { error: "task not found" });
      const after = Number(url.searchParams.get("after") || 0);
      sseHead(res);
      for (const event of this.store.getEvents(task.id, after)) {
        sseSend(res, event.type, event, event.seq);
      }
      if (TERMINAL_STATES.has(task.state)) {
        res.end();
        return;
      }
      let clients = this.taskClients.get(task.id);
      if (!clients) {
        clients = new Set();
        this.taskClients.set(task.id, clients);
      }
      clients.add(res);
      const heartbeat = setInterval(() => sseComment(res), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/events") {
      sseHead(res);
      this.globalClients.add(res);
      const heartbeat = setInterval(() => sseComment(res), 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        this.globalClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && pathname === "/v1/snapshot") {
      const selected = url.searchParams.get("task");
      return sendJson(res, 200, this.store.snapshot(selected));
    }

    const answerMatch = pathname.match(/^\/v1\/questions\/([^/]+)\/answer$/);
    if (req.method === "POST" && answerMatch) {
      const question = this.store.getQuestion(answerMatch[1]);
      if (!question) return sendJson(res, 404, { error: "question not found" });
      if (question.answer) return sendJson(res, 409, { error: "already answered" });
      const task = this.store.getTask(question.taskId);
      if (!task?.runnerRunId) return sendJson(res, 409, { error: "task has no active run" });
      const runner = this.runnerFor(task.target.runner);
      if (!runner) return sendJson(res, 409, { error: `unknown runner: ${task.target.runner}` });
      const body = (await readBody(req)) || {};
      const decision = body.decision || "approve";
      const text =
        body.text ||
        (decision === "deny"
          ? "The human denied this action. Stop and explain what is blocked."
          : "Approved. Continue.");
      // Optimistic transition before the runner call. The runner may complete
      // while handling `input`, and a late update here would overwrite `completed`.
      this.store.updateTask(task.id, { state: "running", questionId: null });
      try {
        await requestJson(
          `${runner.url}/v1/runs/${encodeURIComponent(task.runnerRunId)}/input`,
          {
            method: "POST",
            headers: runnerHeaders(runner),
            body: {
              kind: decision === "deny" ? "deny" : "answer",
              text,
              actor: body.actor || "tui",
              questionId: question.id,
            },
            tls: runner.tls,
          },
        );
      } catch (error) {
        this.store.updateTask(task.id, { state: "waiting", questionId: question.id });
        return sendJson(res, 502, { error: `runner rejected answer: ${error.message}` });
      }
      this.store.answerQuestion(question.id, {
        decision,
        text,
        actor: body.actor || "tui",
      });
      const event = this.store.addEvent(task.id, "answered", {
        questionId: question.id,
        decision,
        actor: body.actor || "tui",
      });
      this.broadcast(event);
      return sendJson(res, 200, { ok: true });
    }

    const resumeMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/resume$/);
    if (req.method === "POST" && resumeMatch) {
      const task = this.store.getTask(resumeMatch[1]);
      if (!task?.runnerRunId) return sendJson(res, 409, { error: "task has no active run" });
      const runner = this.runnerFor(task.target.runner);
      if (!runner) return sendJson(res, 409, { error: `unknown runner: ${task.target.runner}` });
      const body = (await readBody(req)) || {};
      const previousState = task.state;
      this.store.updateTask(task.id, { state: "running", error: null });
      try {
        await requestJson(
          `${runner.url}/v1/runs/${encodeURIComponent(task.runnerRunId)}/resume`,
          {
            method: "POST",
            headers: runnerHeaders(runner),
            body: { text: body.text },
            tls: runner.tls,
          },
        );
      } catch (error) {
        this.store.updateTask(task.id, { state: previousState });
        return sendJson(res, 502, { error: error.message });
      }
      const event = this.store.addEvent(task.id, "resumed", { actor: body.actor || "tui" });
      this.broadcast(event);
      return sendJson(res, 200, { ok: true });
    }

    const steerMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/steer$/);
    if (req.method === "POST" && steerMatch) {
      const task = this.store.getTask(steerMatch[1]);
      if (!task?.runnerRunId) return sendJson(res, 404, { error: "task not running" });
      const runner = this.runnerFor(task.target.runner);
      if (!runner) return sendJson(res, 409, { error: `unknown runner: ${task.target.runner}` });
      const body = (await readBody(req)) || {};
      if (!body.text) return sendJson(res, 400, { error: "text required" });
      try {
        await requestJson(
          `${runner.url}/v1/runs/${encodeURIComponent(task.runnerRunId)}/input`,
          {
            method: "POST",
            headers: runnerHeaders(runner),
            body: { kind: "steer", text: body.text, actor: body.actor || "tui" },
            tls: runner.tls,
          },
        );
      } catch (error) {
        return sendJson(res, 502, { error: error.message });
      }
      const event = this.store.addEvent(task.id, "steer", {
        text: body.text,
        actor: body.actor || "tui",
      });
      this.broadcast(event);
      return sendJson(res, 200, { ok: true });
    }

    const cancelMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const task = this.store.getTask(cancelMatch[1]);
      if (!task) return sendJson(res, 404, { error: "task not found" });
      if (task.runnerRunId) {
        const runner = this.runnerFor(task.target.runner);
        if (runner) {
          await requestStatus(
            `${runner.url}/v1/runs/${encodeURIComponent(task.runnerRunId)}/cancel`,
            { method: "POST", headers: runnerHeaders(runner), tls: runner.tls },
          ).catch(() => {});
        }
      }
      this.store.updateTask(task.id, { state: "canceled" });
      const event = this.store.addEvent(task.id, "done", { state: "canceled" });
      this.broadcast(event);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not found" });
  }

  async listen() {
    await this.init();
    const handler = (req, res) => {
      this.handle(req, res).catch((error) => {
        log("gateway error:", error);
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
    for (const res of this.globalClients) res.end();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

export async function runGateway(argv = []) {
  const args = parseArgs(argv);
  const config = loadConfig(args.config || "config/gateway.json");
  const gateway = new Gateway(config);
  const address = await gateway.listen();
  const scheme = gateway.config.tls?.cert ? "https" : "http";
  log(`gateway listening on ${scheme}://${config.host}:${address.port}`);
  log(`runners=${Object.keys(gateway.runners).join(",")}`);
  return gateway;
}

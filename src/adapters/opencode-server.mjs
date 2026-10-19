import { createSseParser, truncate } from "../util.mjs";
import { request, requestJson, requestStatus } from "../http.mjs";

const GATE_RE = /^\s*```(?:json)?\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*```\s*$|^\s*<<<GATE\s*(\{[\s\S]*?\})\s*>>>\s*$/;

/**
 * Drives a long-lived `opencode serve` over its HTTP API.
 *
 * Differences from the one-shot adapter:
 *  - one server process for the runner, sessions are created per task;
 *  - the session survives a gate, so resuming does not need `--session`;
 *  - permission requests from opencode are forwarded to the human inbox;
 *  - abort is a real API call instead of killing a process tree.
 */
export class OpencodeServerAdapter {
  constructor(options) {
    this.cwd = options.cwd;
    this.model = options.model || null;
    this.agent = options.agent || null;
    this.serverUrl = options.serverUrl;
    this.permissionRules = options.permissionRules || null;
    this.sessionId = options.sessionId || null;
    this.onEvent = options.onEvent;
    this.longLived = true;
    this.lastText = "";
    this.gate = null;
    this.permission = null;
    this.currentRun = null;
    this.eventStream = null;
    this.permTimer = null;
    this.canceled = false;
    this.seenTools = new Map();
  }

  get directory() {
    return encodeURIComponent(this.cwd);
  }

  #modelRef(target) {
    if (!this.model) return null;
    const [providerID, ...rest] = this.model.split("/");
    const modelID = rest.join("/");
    if (!providerID || !modelID) return null;
    return target === "session"
      ? { providerID, id: modelID }
      : { providerID, modelID };
  }

  async #ensureSession() {
    if (this.sessionId) return this.sessionId;
    const body = { title: `agent-bridge ${new Date().toISOString()}` };
    if (this.agent) body.agent = this.agent;
    if (this.permissionRules) body.permission = this.permissionRules;
    const model = this.#modelRef("session");
    if (model) body.model = model;

    const session = await requestJson(
      `${this.serverUrl}/session?directory=${this.directory}`,
      { method: "POST", body },
    );
    this.sessionId = session.id;
    this.onEvent("status", { phase: "session_created", sessionId: session.id });
    return session.id;
  }

  #subscribe() {
    if (this.eventStream) return;
    const url = `${this.serverUrl}/event?directory=${this.directory}`;
    request(url, { headers: { accept: "text/event-stream" } })
      .then(async (response) => {
        if (response.status !== 200) {
          this.onEvent("log", { message: `event stream HTTP ${response.status}` });
          return;
        }
        this.eventStream = response.stream;
        const parser = createSseParser(({ data }) => this.#handleEvent(data));
        try {
          for await (const chunk of response.stream) parser.push(chunk.toString("utf8"));
        } catch (error) {
          if (!this.canceled) this.onEvent("log", { message: `event stream: ${error.message}` });
        } finally {
          this.eventStream = null;
        }
      })
      .catch((error) => this.onEvent("log", { message: `event stream: ${error.message}` }));
  }

  #handleEvent(event) {
    if (!event || event.properties?.sessionID !== this.sessionId) return;
    const properties = event.properties || {};

    switch (event.type) {
      case "message.part.delta": {
        if (properties.field !== "text" || !properties.delta) return;
        this.lastText += properties.delta;
        this.onEvent("delta", { text: properties.delta });
        return;
      }
      case "message.part.updated": {
        const part = properties.part || {};
        if (part.type === "text" && part.text) {
          this.lastText = part.text;
        }
        if (part.type === "tool") {
          const state = part.state || {};
          const key = part.callID || part.id;
          const previous = this.seenTools.get(key);
          if (previous === state.status) return;
          this.seenTools.set(key, state.status);
          this.onEvent("tool", {
            tool: part.tool,
            callId: key,
            status: state.status,
            title: state.title,
            input: state.input,
            output: truncate(state.output, 4000),
          });
        }
        if (part.type === "step-finish") {
          this.onEvent("usage", {
            tokens: part.tokens || null,
            cost: part.cost ?? null,
            reason: part.reason || null,
          });
        }
        return;
      }
      case "session.status":
        this.onEvent("status", { phase: properties.status?.type || "unknown" });
        return;
      case "session.idle":
        this.#checkGate(this.lastText);
        this.onEvent("status", { phase: "idle" });
        return;
      case "permission.asked": {
        if (properties.sessionID !== this.sessionId) return;
        if (this.permission?.id === properties.id) return;
        this.permission = properties;
        const patterns = (properties.patterns || []).join(", ");
        this.onEvent("gate", {
          kind: "approval",
          title: `${properties.permission || "permission"}${patterns ? `: ${patterns}` : ""}`,
          detail: properties,
          options: ["approve", "deny"],
          permissionId: properties.id,
        });
        return;
      }
      case "permission.replied":
        if (this.permission?.id === properties.id) this.permission = null;
        return;
      default:
        return;
    }
  }

  #startPermissionPolling() {
    if (this.permTimer) return;
    this.permTimer = setInterval(() => this.#pollPermissions(), 1200);
    this.permTimer.unref?.();
  }

  async #pollPermissions() {
    if (!this.sessionId || this.permission) return;
    try {
      const list = await requestJson(`${this.serverUrl}/permission`);
      const request = list.find((item) => item.sessionID === this.sessionId);
      if (!request) return;
      this.permission = request;
      this.onEvent("gate", {
        kind: "approval",
        title: request.title || request.permission || "opencode permission request",
        detail: request,
        options: ["approve", "deny"],
        permissionId: request.id,
      });
    } catch {
      /* server may be busy */
    }
  }

  async #sendMessage(text) {
    const sessionId = await this.#ensureSession();
    const body = {
      parts: [{ type: "text", text }],
    };
    const model = this.#modelRef("message");
    if (model) body.model = model;
    if (this.agent) body.agent = this.agent;

    const response = await requestJson(
      `${this.serverUrl}/session/${sessionId}/message?directory=${this.directory}`,
      { method: "POST", body },
    );

    const info = response.info || {};
    if (info.error) {
      const message = info.error?.data?.message || info.error?.name || "opencode request failed";
      this.onEvent("error", { message });
      return { code: 1, sessionId, lastText: this.lastText, gate: this.gate };
    }

    for (const part of response.parts || []) {
      if (part.type === "text" && part.text) this.lastText = part.text;
      if (part.type === "tool") {
        const state = part.state || {};
        this.onEvent("tool", {
          tool: part.tool,
          callId: part.callID || part.id,
          status: state.status,
          title: state.title,
          input: state.input,
          output: truncate(state.output, 4000),
        });
      }
      if (part.type === "step-finish") {
        this.onEvent("usage", {
          tokens: part.tokens || null,
          cost: part.cost ?? null,
          reason: part.reason || null,
        });
      }
    }
    this.#checkGate(this.lastText);
    if (this.lastText) this.onEvent("message", { role: "assistant", text: this.lastText });
    return { code: 0, sessionId, lastText: this.lastText, gate: this.gate };
  }

  async run(prompt) {
    this.canceled = false;
    this.#subscribe();
    this.#startPermissionPolling();
    this.currentRun = this.#sendMessage(prompt);
    return this.currentRun;
  }

  async respond(text) {
    if (this.permission) {
      const request = this.permission;
      this.permission = null;
      const reply = /deny|reject/i.test(text) ? "reject" : "once";
      await requestJson(
        `${this.serverUrl}/session/${this.sessionId}/permission/${request.id}/reply`,
        {
          method: "POST",
          body: { reply, message: text },
        },
      );
      this.onEvent("status", { phase: "permission_replied", reply });
      return this.currentRun || { code: 0, sessionId: this.sessionId, lastText: this.lastText };
    }

    this.gate = null;
    this.lastText = "";
    this.currentRun = this.#sendMessage(text);
    return this.currentRun;
  }

  async steer(text) {
    this.onEvent("log", { message: "steer queued for the next turn", text });
    this.pendingSteer = text;
  }

  async cancel() {
    this.canceled = true;
    try {
      this.eventStream?.destroy();
    } catch {
      /* ignore */
    }
    if (this.permTimer) {
      clearInterval(this.permTimer);
      this.permTimer = null;
    }
    if (this.sessionId) {
      await requestStatus(`${this.serverUrl}/session/${this.sessionId}/abort`, {
        method: "POST",
      }).catch(() => {});
    }
  }

  async close() {
    try {
      this.eventStream?.destroy();
    } catch {
      /* ignore */
    }
    if (this.permTimer) {
      clearInterval(this.permTimer);
      this.permTimer = null;
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

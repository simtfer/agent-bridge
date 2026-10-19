/**
 * Echo adapter: deterministic harness used by tests and by `agent-bridge demo`.
 * It never executes anything; it just emits a few events and optionally a gate.
 */
export class EchoAdapter {
  constructor(options) {
    this.options = options;
    this.sessionId = options.sessionId || null;
    this.canceled = false;
    this.delay = Math.max(0, Number(options.task?.delayMs) || 60);
    this.onEvent = options.onEvent;
  }

  async run(prompt) {
    const goal = this.options.task?.goal || prompt;
    this.onEvent("status", { phase: "starting" });
    await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.canceled) return { code: 130, sessionId: this.sessionId, lastText: "" };

    this.onEvent("message", { role: "assistant", text: `echo: ${goal}` });
    this.onEvent("tool", {
      tool: "echo",
      status: "completed",
      title: "echo",
      input: { prompt },
      output: `echo: ${prompt}`,
    });
    await new Promise((resolve) => setTimeout(resolve, this.delay));

    if (/\[gate\]/i.test(this.options.task?.rawRequest || this.options.task?.goal || "")) {
      this.onEvent("gate", {
        kind: "approval",
        title: "Echo adapter requests approval",
        detail: { goal, rawRequest: this.options.task?.rawRequest || null },
        options: ["approve", "deny"],
      });
      return { code: 0, sessionId: this.sessionId, lastText: `echo: ${goal}` };
    }

    this.onEvent("usage", { input: 1, output: 1, total: 2 });
    return { code: 0, sessionId: this.sessionId, lastText: `echo: ${goal}` };
  }

  async respond(text) {
    this.onEvent("status", { phase: "resumed" });
    this.onEvent("message", { role: "assistant", text: `answer accepted: ${text}` });
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { code: 0, sessionId: this.sessionId, lastText: `answer accepted: ${text}` };
  }

  async steer(text) {
    this.onEvent("message", { role: "human", text: `steer: ${text}` });
  }

  async cancel() {
    this.canceled = true;
    this.onEvent("status", { phase: "canceled" });
  }
}

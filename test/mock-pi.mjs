#!/usr/bin/env node
// Minimal pi RPC-compatible harness used to test the B-side pi adapter
// without a provider login. It is not a model: it echoes the prompt.
let buffer = "";

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function settle(aborted = false) {
  send({ type: "agent_settled", aborted });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      send({
        id: command.id,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "mock-session",
          sessionFile: "mock-session.jsonl",
        },
      });
      return;
    case "prompt": {
      send({
        id: command.id,
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "started" },
      });
      const message = String(command.message || "");
      const text = /\[gate\]/i.test(message)
        ? '<<<GATE {"kind":"approval","title":"Mock pi gate","detail":{"command":"echo hi"}}>>>'
        : `mock-pi: ${message.split("\n").filter(Boolean).pop() || ""}`;
      setTimeout(() => {
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text },
        });
        send({
          type: "message_update",
          assistantMessageEvent: { type: "text_end", content: text },
        });
        settle(false);
      }, 40);
      return;
    }
    case "steer":
      send({
        id: command.id,
        type: "response",
        command: "steer",
        success: true,
        data: { disposition: "queued" },
      });
      return;
    case "abort":
      send({ id: command.id, type: "response", command: "abort", success: true });
      settle(true);
      return;
    default:
      send({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: `mock-pi: unsupported command ${command.type}`,
      });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "").trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      send({ type: "response", command: "parse", success: false, error: error.message });
    }
  }
});
process.stdin.on("end", () => process.exit(0));

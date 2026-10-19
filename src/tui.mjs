import readline from "node:readline";
import {
  displayWidth,
  padDisplay,
  wrapDisplay,
  truncateDisplay,
  stripAnsi,
} from "./util.mjs";
import { requestJson } from "./http.mjs";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  inverse: "\x1b[7m",
};

const STATE_COLOR = {
  queued: C.gray,
  running: C.cyan,
  waiting: C.yellow,
  completed: C.green,
  failed: C.red,
  canceled: C.gray,
  interrupted: C.magenta,
};

const STATE_ICON = {
  queued: "○",
  running: "●",
  waiting: "!",
  completed: "✓",
  failed: "✗",
  canceled: "-",
  interrupted: "!",
};

function padColored(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

function clip(text, width) {
  let out = "";
  let used = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\x1b") {
      const match = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        out += match[0];
        index += match[0].length;
        continue;
      }
    }
    const char = text[index];
    const w = displayWidth(char);
    if (used + w > width) {
      out += `…${C.reset}`;
      return out;
    }
    out += char;
    used += w;
    index += 1;
  }
  return out;
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s*\r?\n\s*/g, " · ")
    .trim();
}

function elapsed(iso) {  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export async function runTui(config, options = {}) {
  const gateway = config.gateway;
  const actor = config.actor || "tui";
  const refreshMs = config.refreshMs || 800;

  const state = {
    snapshot: null,
    selectedId: null,
    mode: "normal",
    inputKind: null,
    input: "",
    questionId: null,
    status: "connecting",
    error: null,
    notice: null,
    noticeUntil: 0,
    running: true,
  };

  const headers = { "content-type": "application/json" };
  if (gateway.token) headers["x-bridge-token"] = gateway.token;

  async function api(path, options = {}) {
    return requestJson(`${gateway.url}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      tls: gateway.tls,
    });
  }

  function selectedTask() {
    return state.snapshot?.tasks.find((task) => task.id === state.selectedId) || null;
  }

  function selectedQuestion() {
    const task = selectedTask();
    if (!task) return null;
    return (
      state.snapshot?.questions.find(
        (question) => question.taskId === task.id && !question.answer,
      ) || null
    );
  }

  async function refresh() {
    try {
      const query = state.selectedId ? `?task=${encodeURIComponent(state.selectedId)}` : "";
      const snapshot = await api(`/v1/snapshot${query}`);
      state.snapshot = snapshot;
      state.status = "connected";
      state.error = null;
      if (!state.selectedId || !snapshot.tasks.some((task) => task.id === state.selectedId)) {
        const waiting = snapshot.questions[0]?.taskId;
        state.selectedId = waiting || snapshot.tasks[0]?.id || null;
      }
    } catch (error) {
      state.status = "disconnected";
      state.error = error.message;
    }
    render();
  }

  function notice(text) {
    state.notice = text;
    state.noticeUntil = Date.now() + 2500;
  }

  function nextWaiting() {
    const tasks = state.snapshot?.tasks || [];
    const waiting = tasks.filter((task) => task.state === "waiting");
    if (waiting.length === 0) return;
    const index = waiting.findIndex((task) => task.id === state.selectedId);
    state.selectedId = waiting[(index + 1) % waiting.length].id;
    refresh();
  }

  function move(delta) {
    const tasks = state.snapshot?.tasks || [];
    if (tasks.length === 0) return;
    const index = tasks.findIndex((task) => task.id === state.selectedId);
    const next = Math.min(tasks.length - 1, Math.max(0, index + delta));
    state.selectedId = tasks[next].id;
    refresh();
  }

  async function resumeSelected() {
    const task = selectedTask();
    if (!task) return notice("没有选中任务");
    if (task.state !== "interrupted") return notice("当前任务不是 interrupted 状态");
    try {
      await api(`/v1/tasks/${task.id}/resume`, {
        method: "POST",
        body: JSON.stringify({ text: "", actor }),
      });
      notice(`已恢复 ${task.id}`);
      await refresh();
    } catch (error) {
      notice(`恢复失败: ${error.message}`);
    }
  }

  async function decide(decision) {    const question = selectedQuestion();
    if (!question) return notice("当前任务没有待答问题");
    try {
      await api(`/v1/questions/${question.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ decision, actor }),
      });
      notice(`${decision === "deny" ? "已拒绝" : "已批准"} ${question.id}`);
      await refresh();
    } catch (error) {
      notice(`失败: ${error.message}`);
    }
  }

  function startInput(kind) {
    const task = selectedTask();
    if (!task) return notice("没有选中任务");
    if (kind === "answer" && !selectedQuestion()) return notice("当前任务没有问题需要回答");
    state.mode = "input";
    state.inputKind = kind;
    state.input = "";
    render();
  }

  async function submitInput() {
    const text = state.input.trim();
    const kind = state.inputKind;
    state.mode = "normal";
    state.input = "";
    state.inputKind = null;
    if (!text) return render();

    try {
      if (kind === "steer") {
        const task = selectedTask();
        await api(`/v1/tasks/${task.id}/steer`, {
          method: "POST",
          body: JSON.stringify({ text, actor }),
        });
        notice("已插话");
      } else {
        const question = selectedQuestion();
        await api(`/v1/questions/${question.id}/answer`, {
          method: "POST",
          body: JSON.stringify({ decision: "approve", text, actor }),
        });
        notice("已回复");
      }
      await refresh();
    } catch (error) {
      notice(`失败: ${error.message}`);
      render();
    }
  }

  function render() {
    if (!state.running) return;
    const cols = process.stdout.columns || 110;
    const rows = process.stdout.rows || 32;
    const headerRows = 1;
    const footerRows = 2;
    const bodyH = Math.max(5, rows - headerRows - footerRows);
    const leftW = Math.min(40, Math.max(28, Math.floor(cols * 0.33)));
    const rightW = Math.max(20, cols - leftW - 1);

    const tasks = state.snapshot?.tasks || [];
    const task = selectedTask();
    const question = selectedQuestion();
    const lines = [];

    lines.push(
      renderHeader(cols, tasks, state),
    );

    const left = [];
    left.push(`${C.bold} TASKS${C.reset} ${C.gray}(${tasks.length})${C.reset}`);
    for (const item of tasks) {
      const color = STATE_COLOR[item.state] || C.white;
      const icon = STATE_ICON[item.state] || "?";
      const selected = item.id === state.selectedId;
      const title = truncateDisplay(oneLine(item.goal), leftW - 8);
      const selector = selected ? `${C.inverse}>` : " ";
      left.push(
        `${selector}${color}${icon}${C.reset} ` +
          `${selected ? C.inverse : ""}${title}${C.reset}`,
      );
      left.push(`${C.gray}   ${item.state} ${elapsed(item.updatedAt)}${C.reset}`);
    }

    const right = [];
    if (!task) {
      right.push(`${C.gray}no task selected${C.reset}`);
    } else {
      const color = STATE_COLOR[task.state] || C.white;
      right.push(
        `${C.bold}${task.id}${C.reset}  ${color}${task.state}${C.reset}` +
          `  ${C.gray}${elapsed(task.createdAt)}${C.reset}`,
      );
      for (const line of wrapDisplay(task.goal, rightW - 2).slice(0, 2)) {
        right.push(`${C.white}${line}${C.reset}`);
      }
      right.push(
        `${C.gray}target ${task.target?.runner}/${task.target?.harness}` +
          `${task.target?.model ? ` · ${task.target.model}` : ""}` +
          `${task.repo ? ` · ${task.repo}@${task.baseRef || "HEAD"}` : ""}${C.reset}`,
      );
      right.push(`${C.gray}${"─".repeat(Math.max(4, rightW - 2))}${C.reset}`);

      const events = state.snapshot?.events?.[task.id] || [];
      for (const event of events) {
        const rendered = renderEvent(event, rightW - 2);
        if (rendered?.length) right.push(...rendered);
      }

      if (task.error) right.push(`${C.red}error: ${task.error}${C.reset}`);
      if (task.summary && task.state === "completed") {
        right.push(`${C.green}summary: ${truncateDisplay(oneLine(task.summary), rightW - 12)}${C.reset}`);
      }

      if (question) {
        right.push("");
        right.push(`${C.yellow}${C.bold}┌ 需要人工处理 ${"─".repeat(Math.max(2, rightW - 18))}${C.reset}`);
        for (const line of wrapDisplay(oneLine(question.title), rightW - 4).slice(0, 3)) {
          right.push(`${C.yellow}│ ${line}${C.reset}`);
        }
        if (question.detail) {
          const detail =
            typeof question.detail === "string"
              ? question.detail
              : JSON.stringify(question.detail);
          for (const line of wrapDisplay(detail, rightW - 4).slice(0, 4)) {
            right.push(`${C.gray}│ ${line}${C.reset}`);
          }
        }
        right.push(
          `${C.yellow}│ ${C.reset}${C.green}[a]${C.reset} 批准  ` +
            `${C.red}[d]${C.reset} 拒绝  ${C.cyan}[r]${C.reset} 回答`,
        );
        right.push(`${C.yellow}└${"─".repeat(Math.max(2, rightW - 2))}${C.reset}`);
      }
    }

    const body = [];
    const visibleLeft = left.slice(0, bodyH);
    const visibleRight = right.slice(-bodyH);
    for (let i = 0; i < bodyH; i++) {
      const leftLine = visibleLeft[i] ?? "";
      const rightLine = visibleRight[i] ?? "";
      const row =
        clip(padColored(leftLine, leftW), leftW) +
        `${C.gray}│${C.reset}` +
        clip(padColored(rightLine, rightW), rightW);
      body.push(row);
    }

    for (const line of body) lines.push(line);

    const footer =
      state.mode === "input"
        ? `${C.cyan}${state.inputKind === "steer" ? "插话" : "回答"}>${C.reset} ` +
          `${state.input}${C.inverse} ${C.reset}   ${C.gray}Enter 发送  Esc 取消${C.reset}`
        : `${C.gray}j/k 选择  Tab 下一个待答  a 批准  d 拒绝  s 插话  r 回答  R 恢复  q 退出${C.reset}`;
    lines.push(clip(footer, cols));
    const hint =
      Date.now() < state.noticeUntil
        ? `${C.yellow}${state.notice}${C.reset}`
        : `${C.gray}${state.status}${state.error ? `: ${state.error}` : ""}  ` +
          `actor=${actor}  gateway=${gateway.url}${C.reset}`;
    lines.push(clip(hint, cols));

    draw(lines, rows, cols);
  }

  function renderEvent(event, width) {
    const data = event.data || {};
    switch (event.type) {
      case "message": {
        const text = data.text || "";
        return wrapDisplay(text, width).slice(0, 6).map((line) => `${C.white}${line}${C.reset}`);
      }
      case "delta":
        return null;
      case "tool": {
        const title = oneLine(data.title || data.tool || "tool");
        const status = data.status || "";
        return [
          `${C.magenta}▶ ${truncateDisplay(title, width - 12)}${C.reset}` +
            ` ${C.gray}${status}${C.reset}`,
        ];
      }
      case "usage": {
        const tokens = data.tokens?.total ?? data.total ?? "-";
        return [`${C.gray}usage tokens=${tokens}${C.reset}`];
      }
      case "status":
        return [`${C.gray}status ${data.phase || JSON.stringify(data)}${C.reset}`];
      case "state":
        return [`${C.gray}state ${data.state}${C.reset}`];
      case "error":
        return [`${C.red}error ${oneLine(data.message)}${C.reset}`];
      case "log":
        return [
          `${C.gray}${truncateDisplay(
            oneLine(data.line || data.message || JSON.stringify(data)),
            width,
          )}${C.reset}`,
        ];
      case "done":
        return [`${C.green}done ${data.state || ""}${C.reset}`];
      case "question":
        return [`${C.yellow}question: ${data.title}${C.reset}`];
      case "submitted":
        return [`${C.gray}submitted ${data.runnerRunId}${C.reset}`];
      default:
        return null;
    }
  }

  function renderHeader(cols, tasks, state) {
    const stats = state.snapshot?.stats || {};
    const left = `${C.bold}agent-bridge${C.reset} ${C.gray}·${C.reset} ` +
      `${C.cyan}${state.status}${C.reset}`;
    const right = `${C.gray}running ${stats.running || 0}  waiting ${stats.waiting || 0}  ` +
      `tasks ${stats.total || 0}${C.reset}`;
    return clip(padColored(left, cols - displayWidth(right)) + right, cols);
  }

  function draw(lines, rows, cols) {
    let output = "\x1b[H";
    for (let i = 0; i < rows; i++) {
      const line = lines[i] ?? "";
      output += line + "\x1b[K";
      if (i < rows - 1) output += "\r\n";
    }
    process.stdout.write(output);
  }

  function cleanup() {
    state.running = false;
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  }
  readline.emitKeypressEvents(process.stdin);

  process.stdin.on("keypress", (str, key) => {
    if (!state.running) return;
    if (key.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }

    if (state.mode === "input") {
      if (key.name === "escape") {
        state.mode = "normal";
        state.input = "";
        state.inputKind = null;
        render();
        return;
      }
      if (key.name === "return") {
        submitInput();
        return;
      }
      if (key.name === "backspace") {
        state.input = state.input.slice(0, -1);
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        state.input += str;
        render();
      }
      return;
    }

    if (key.shift && key.name === "r") {
      resumeSelected();
      return;
    }

    switch (key.name) {
      case "q":        cleanup();
        process.exit(0);
        break;
      case "j":
      case "down":
        move(1);
        break;
      case "k":
      case "up":
        move(-1);
        break;
      case "tab":
        nextWaiting();
        break;
      case "a":
        decide("approve");
        break;
      case "d":
        decide("deny");
        break;
      case "s":
        startInput("steer");
        break;
      case "r":
      case "return":
        startInput("answer");
        break;
      case "R":
        resumeSelected();
        break;
      case "g":
        state.selectedId = state.snapshot?.tasks?.[0]?.id || null;
        refresh();
        break;
      default:
        break;
    }
  });

  process.stdout.on("resize", render);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  await refresh();
  if (options.once) {
    cleanup();
    return;
  }
  const timer = setInterval(refresh, refreshMs);
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!state.running) {
        clearInterval(timer);
        clearInterval(check);
        resolve();
      }
    }, 200);
  });
}

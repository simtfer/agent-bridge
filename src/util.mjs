import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const now = () => new Date().toISOString();
export const uid = (prefix) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export function log(...args) {
  console.error("[bridge]", ...args);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      if (attempt === 5) {
        await fsp.unlink(tmp).catch(() => {});
        throw error;
      }
      // Windows/Defender can briefly lock the target; retry with backoff.
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid JSON body");
  }
}

export function authOk(req, token) {
  if (!token) return true;
  const header = req.headers["authorization"] || "";
  const supplied = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.headers["x-bridge-token"];
  if (typeof supplied !== "string" || supplied.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
  } catch {
    return false;
  }
}

export function sseHead(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");
}

export function sseSend(res, event, data, id) {
  if (res.writableEnded || res.destroyed) return;
  if (id !== undefined && id !== null) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function sseComment(res, text = "ping") {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: ${text}\n\n`);
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

function charWidth(code) {
  if (code === 0x200d) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(s) {
  let width = 0;
  for (const ch of stripAnsi(s)) width += charWidth(ch.codePointAt(0));
  return width;
}

export function truncateDisplay(s, width) {
  s = String(s ?? "");
  if (displayWidth(s) <= width) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = charWidth(ch.codePointAt(0));
    if (used + w > Math.max(0, width - 1)) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

export function padDisplay(s, width) {
  const text = truncateDisplay(s, width);
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function wrapDisplay(text, width) {
  const lines = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    if (rawLine === "") {
      lines.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const ch of rawLine) {
      const w = charWidth(ch.codePointAt(0));
      if (used + w > width && line !== "") {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += ch;
      used += w;
    }
    lines.push(line);
  }
  return lines;
}

export function truncate(s, max = 2000) {
  s = String(s ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} chars truncated)`;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, ...rest] = key.split("=");
        out[k] = rest.join("=");
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        out[key] = argv[++i];
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

export function loadConfig(file) {
  const config = readJson(file, null);
  if (!config) throw new Error(`config not found or invalid: ${file}`);
  return config;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSseParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let event = "message";
        let id;
        const dataLines = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;
        let data;
        try {
          data = JSON.parse(dataLines.join("\n"));
        } catch {
          data = dataLines.join("\n");
        }
        onEvent({ event, id, data });
      }
    },
  };
}

export function isWindows() {
  return process.platform === "win32";
}

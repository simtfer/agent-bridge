import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const cache = new Map();

function readFileOnce(file) {
  if (!file) return undefined;
  if (cache.has(file)) return cache.get(file);
  const data = fs.readFileSync(file);
  cache.set(file, data);
  return data;
}

export function tlsOptions(tls = {}) {
  const options = {};
  if (tls.ca) options.ca = readFileOnce(tls.ca);
  if (tls.cert) options.cert = readFileOnce(tls.cert);
  if (tls.key) options.key = readFileOnce(tls.key);
  if (tls.passphrase) options.passphrase = tls.passphrase;
  if (tls.rejectUnauthorized !== undefined) options.rejectUnauthorized = tls.rejectUnauthorized;
  if (tls.servername) options.servername = tls.servername;
  return options;
}

export function isHttps(url) {
  return new URL(url).protocol === "https:";
}

/**
 * Low-level request. Resolves with the response stream so callers can consume
 * SSE incrementally. Supports a CA / client certificate via `tls`.
 */
export function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    tls = {},
    timeoutMs = 0,
  } = options;

  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const req = transport.request(
      target,
      { method, headers, ...tlsOptions(tls) },
      (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res }),
    );

    req.on("error", reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    }

    if (body !== undefined && body !== null) {
      req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    }
    req.end();
  });
}

export async function readAll(stream, limit = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new Error("response body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function requestJson(url, options = {}) {
  const response = await request(url, options);
  const text = await readAll(response.stream);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(
      `HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

export async function requestStatus(url, options = {}) {
  const response = await request(url, options);
  await readAll(response.stream);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.status;
}

/** Build https.createServer options from a config `tls` block. */
export function serverTlsOptions(tls = {}) {
  return tlsOptions(tls);
}

// Read-only registry mirror for Bumpsmith sandboxes (PRD §10 "Registry proxy: read-only").
//
// Sandboxes resolve the registry hostnames to this server (pinned in /etc/hosts) and trust
// a CA whose only certificates are for those hostnames (its private key is destroyed after
// issuing them). Unlike a CONNECT tunnel, this server sees each request, so it can enforce:
//   - GET and HEAD only: no publish, login, token or audit endpoints (closes the
//     "npm publish the customer's code with an attacker's token" exfiltration path);
//   - known registry hosts only (by SNI and Host, which must agree);
//   - no credentials in or out: Authorization/Cookie are stripped;
//   - per-client rate limits, response size cap.

import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

const HOSTS = new Set(
  (
    process.env.MIRROR_HOSTS ??
    "registry.npmjs.org,registry.yarnpkg.com,repo.yarnpkg.com,pypi.org,files.pythonhosted.org"
  )
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const CERT_DIR = process.env.MIRROR_CERT_DIR ?? "/etc/bumpsmith-mirror";
const PORT = Number(process.env.MIRROR_PORT ?? 443);
const MAX_BYTES = Number(process.env.MIRROR_MAX_BYTES ?? 512 * 1024 * 1024);
const RATE_PER_MIN = Number(process.env.MIRROR_RATE_PER_MIN ?? 6000);
const MAX_CONCURRENT = Number(process.env.MIRROR_MAX_CONCURRENT ?? 64);

const log = (event, detail) =>
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...detail })}\n`);

const buckets = new Map(); // ip -> { minute, count, inflight, waiting: [] }
/**
 * Admit a request: over the per-minute budget it is refused (abuse protection); over the
 * concurrency limit it waits for a slot (package managers open many parallel downloads,
 * and refusing them fails whole installs). Resolves to a release function, or null.
 */
function admit(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const b = buckets.get(ip) ?? { minute, count: 0, inflight: 0, waiting: [] };
  buckets.set(ip, b);
  if (b.minute !== minute) {
    b.minute = minute;
    b.count = 0;
  }
  if (b.count >= RATE_PER_MIN) return Promise.resolve(null);
  b.count += 1;
  const release = () => {
    b.inflight -= 1;
    const next = b.waiting.shift();
    if (next) next();
  };
  if (b.inflight < MAX_CONCURRENT) {
    b.inflight += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      b.waiting = b.waiting.filter((w) => w !== go);
      resolve(null);
    }, 120000);
    const go = () => {
      clearTimeout(timer);
      b.inflight += 1;
      resolve(release);
    };
    b.waiting.push(go);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Upstream fetch that retries rate limits, server errors and network failures. */
async function fetchUpstream(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(300000) });
      if (!RETRY_STATUS.has(r.status) || attempt >= 5) return r;
      const after = Number(r.headers.get("retry-after"));
      await r.body?.cancel();
      log("upstream_retry", { url: url.slice(0, 200), status: r.status, attempt });
      await sleep(
        Math.min(20000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** attempt),
      );
    } catch (err) {
      if (attempt >= 5) throw err;
      log("upstream_retry", {
        url: url.slice(0, 200),
        error: String(err?.message ?? err).slice(0, 120),
        attempt,
      });
      await sleep(1000 * 2 ** attempt);
    }
  }
}
setInterval(() => {
  const minute = Math.floor(Date.now() / 60000);
  for (const [ip, b] of buckets) if (b.minute < minute - 5 && b.inflight === 0) buckets.delete(ip);
}, 60000).unref();

const PASS_HEADERS = [
  "accept",
  "accept-encoding",
  "if-none-match",
  "if-modified-since",
  "user-agent",
  "npm-command",
  "pnpm-version",
];
const RETURN_HEADERS = ["content-type", "etag", "last-modified", "cache-control", "location"];

async function handle(req, res) {
  const host = String(req.headers.host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
  const sni = (req.socket.servername ?? "").toLowerCase();
  const ip = req.socket.remoteAddress ?? "unknown";
  if (!HOSTS.has(host) || (sni && sni !== host)) {
    log("deny_host", { host, sni, ip });
    res.writeHead(421, { "content-type": "text/plain" }).end("host not served\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    log("deny_method", { host, method: req.method, path: req.url?.slice(0, 200), ip });
    res
      .writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" })
      .end("bumpsmith mirror is read-only\n");
    return;
  }
  const release = await admit(ip);
  if (!release) {
    res.writeHead(429, { "retry-after": "5", "content-type": "text/plain" }).end("slow down\n");
    return;
  }
  try {
    const headers = {};
    for (const h of PASS_HEADERS) if (req.headers[h]) headers[h] = String(req.headers[h]);
    const upstream = await fetchUpstream(`https://${host}${req.url}`, {
      method: req.method,
      headers,
      redirect: "manual",
    });
    const out = {};
    for (const h of RETURN_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    }
    // Redirects may only point at hosts this mirror serves.
    if (out.location) {
      const target = new URL(out.location, `https://${host}`);
      if (!HOSTS.has(target.hostname)) {
        res.writeHead(502).end("redirect to unserved host\n");
        return;
      }
    }
    res.writeHead(upstream.status, out);
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }
    let size = 0;
    const body = Readable.fromWeb(upstream.body);
    body.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) body.destroy(new Error("response too large"));
    });
    body.on("error", () => res.destroy());
    body.pipe(res);
    await new Promise((r) => res.on("close", r));
  } catch (err) {
    log("upstream_error", { host, error: String(err?.message ?? err).slice(0, 200) });
    if (!res.headersSent) res.writeHead(502).end("upstream error\n");
    else res.destroy();
  } finally {
    release();
  }
}

const server = https.createServer(
  {
    key: readFileSync(`${CERT_DIR}/mirror.key`),
    cert: readFileSync(`${CERT_DIR}/mirror.crt`),
    minVersion: "TLSv1.2",
  },
  handle,
);
server.headersTimeout = 30000;
server.requestTimeout = 600000;
server.listen(PORT, "0.0.0.0", () => log("listening", { port: PORT, hosts: [...HOSTS] }));

// Plain-HTTP health endpoint for orchestration (no proxying on this port).
http
  .createServer((_q, r) => r.writeHead(200).end("ok"))
  .listen(Number(process.env.MIRROR_HEALTH_PORT ?? 8081), "0.0.0.0");

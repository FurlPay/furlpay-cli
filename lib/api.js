"use strict";
// HTTP client for the FurlPay API. Zero-dep: node http/https only.
// Auth = the same `furlpay_session` cookie the web app uses, captured during
// `furlpay login` and stored per-environment in ~/.furlpay/config.json.

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { loadConfig, saveConfig } = require("./util");

const DEFAULT_BASES = {
  // apps/web dev server binds to 8787 (see .env.local); override with
  // `furlpay config set sandboxUrl http://localhost:<port>`.
  sandbox: "http://localhost:8787",
  live: "https://furlpay.com",
};
const SESSION_COOKIE = "furlpay_session";

function currentEnv(cfg, flags) {
  return flags.env || cfg.env || "sandbox";
}

function apiBase(cfg, flags) {
  if (flags["api-base"]) return String(flags["api-base"]).replace(/\/$/, "");
  const env = currentEnv(cfg, flags);
  const override = env === "live" ? cfg.liveUrl : cfg.sandboxUrl;
  return (override || DEFAULT_BASES[env] || DEFAULT_BASES.sandbox).replace(/\/$/, "");
}

function sessionCookie(cfg, flags) {
  const sessions = cfg.sessions || {};
  return sessions[currentEnv(cfg, flags)];
}

function storeSession(flags, cookieValue) {
  const cfg = loadConfig();
  const sessions = cfg.sessions || {};
  sessions[currentEnv(cfg, flags)] = cookieValue;
  saveConfig({ ...cfg, sessions });
}

function clearSession(flags) {
  const cfg = loadConfig();
  const sessions = cfg.sessions || {};
  delete sessions[currentEnv(cfg, flags)];
  saveConfig({ ...cfg, sessions });
}

/** Raw request. Resolves { status, headers, body(parsed json | string) }. */
function rawRequest(method, path, { flags = {}, body, headers = {} } = {}) {
  const cfg = loadConfig();
  const base = apiBase(cfg, flags);
  const target = new URL(path.startsWith("http") ? path : base + path);
  const lib = target.protocol === "https:" ? https : http;
  const cookie = sessionCookie(cfg, flags);
  const payload = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": "furlpay-cli",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* non-JSON (HTML error page etc.) — return the raw string */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED") {
        reject(new Error(`Cannot reach ${base} — is the ${currentEnv(cfg, flags)} API running? (furlpay env live to target production)`));
      } else {
        reject(e);
      }
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Request that throws a friendly error on non-2xx and returns the JSON body. */
async function call(method, path, opts = {}) {
  const res = await rawRequest(method, path, opts);
  if (res.status >= 200 && res.status < 300) return res.body;
  const msg =
    (res.body && typeof res.body === "object" && (res.body.error || res.body.message)) ||
    `HTTP ${res.status}`;
  const err = new Error(res.status === 401 ? `${msg} — run \`furlpay login\` first` : msg);
  err.status = res.status;
  err.body = res.body;
  throw err;
}

/** Extract the furlpay_session value from a Set-Cookie header array. */
function extractSession(setCookieHeader) {
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader].filter(Boolean);
  for (const c of cookies) {
    const m = /furlpay_session=([^;]+)/.exec(c);
    if (m && m[1]) return m[1];
  }
  return null;
}

module.exports = {
  DEFAULT_BASES,
  SESSION_COOKIE,
  currentEnv,
  apiBase,
  sessionCookie,
  storeSession,
  clearSession,
  rawRequest,
  call,
  extractSession,
};

"use strict";

// `furlpay login` device authorization (RFC 8628).
// The access token is stored by api.storeSession and is never printed.

const { spawn } = require("child_process");
const os = require("os");
const api = require("./api");
const { c, loadConfig, saveConfig } = require("./util");
const out = require("./output");

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const CLIENT_ID = "furlpay-cli";

function browserUrlAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (!parsed.pathname.startsWith("/device-auth")) return false;
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:") return host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (parsed.protocol !== "https:") return false;
  return host === "furlpay.com" || host.endsWith(".furlpay.com");
}

function intervalSeconds(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : undefined;
}

/** Map a token-endpoint response to the next CLI step. Never returns the token. */
function interpretTokenResponse(status, body) {
  if (status >= 200 && status < 300 && body && typeof body.access_token === "string" && body.access_token.length > 0) {
    return {
      type: "approved",
      scope: typeof body.scope === "string" ? body.scope : "account:read",
      deviceSessionId: typeof body.device_session_id === "string" ? body.device_session_id : null,
    };
  }
  const error = body && typeof body === "object" ? body.error : undefined;
  const interval = body && typeof body === "object" ? intervalSeconds(body.interval) : undefined;
  if (error === "authorization_pending") return { type: "pending", interval };
  if (error === "slow_down") return { type: "slow_down", interval };
  if (error === "access_denied") return { type: "denied" };
  if (error === "expired_token") return { type: "expired" };
  if (error === "invalid_grant") return { type: "invalid" };
  if (status === 429 || status === 503) return { type: "backoff", interval: interval || 5 };
  return { type: "network", status };
}

function openBrowser(url) {
  if (!browserUrlAllowed(url)) return false;
  if (process.env.FURLPAY_NO_BROWSER === "1" || process.env.CI) return false;
  // The URL is an argv entry, never a shell string. On Windows, rundll32
  // hands it to the default browser without cmd.exe metacharacter parsing.
  const platform = process.platform;
  const cmd = platform === "win32" ? "rundll32" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function sleep(ms, shouldStop) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (shouldStop() || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 150);
  });
}

function printWaiting({ url, userCode, opened }) {
  const line = "─".repeat(46);
  console.log("");
  console.log(c.cyan(`╭${line}╮`));
  console.log(c.cyan("│") + c.bold("              FurlPay CLI                     ") + c.cyan("│"));
  console.log(c.cyan("│") + "          Secure Device Authorization         " + c.cyan("│"));
  console.log(c.cyan(`╰${line}╯`));
  console.log("");
  console.log("  Starting device authorization...");
  console.log("");
  console.log("  Open your browser:");
  console.log(`  ${c.cyan(url)}`);
  console.log("");
  console.log("  Your device code:");
  console.log(`  ${c.bold(userCode)}`);
  console.log("");
  console.log("  Waiting for authorization...");
  console.log("");
  console.log(`  ${c.green("[✓]")} Authorization request created`);
  console.log(`  ${opened ? c.green("[✓] Browser opened") : c.yellow("[!] Open the URL above — the browser did not launch")}`);
  console.log(`  ${c.cyan("[●]")} Waiting for approval`);
  console.log("");
  console.log(c.dim("  Approve this device in your browser. Ctrl+C cancels."));
  console.log("");
}

async function printSuccess(flags) {
  let account = null;
  try {
    account = await api.call("GET", "/api/cli/whoami", { flags });
  } catch {
    account = null;
  }
  const email = account && account.email ? account.email : "signed in";
  const device = os.hostname();
  console.log("");
  console.log(c.green("✓ Successfully authenticated with FurlPay."));
  console.log("");
  console.log(`  Account: ${c.bold(email)}`);
  console.log(`  Device:  ${device}`);
  console.log(`  Status:  ${c.green("Connected")}`);
  console.log("");
  console.log("  You can now use FurlPay CLI.");
  console.log(c.dim("  Transaction signing was not granted."));
  console.log("");
  console.log(c.dim("  Run `furlpay --help` to get started."));
  console.log("");
}

async function deviceLogin(flags) {
  const version = require("../package.json").version;
  let started;
  try {
    started = await api.call("POST", "/api/auth/device/code", {
      flags,
      body: {
        client_id: CLIENT_ID,
        scope: "account:read",
        device_name: os.hostname(),
        os: `${os.type()} ${os.release()}`,
        cli_version: version,
      },
    });
  } catch (error) {
    out.fail(error.message || "Could not start device authorization.");
    return;
  }

  const url = started.verification_uri_complete || started.verification_uri;
  if (!browserUrlAllowed(url)) {
    out.fail("The server returned a verification URL this CLI will not open.");
    return;
  }
  const opened = flags["no-browser"] ? false : openBrowser(url);
  if (flags.json || flags.quiet) {
    console.log(JSON.stringify({
      verification_uri: started.verification_uri,
      user_code: started.user_code,
      expires_in: started.expires_in,
      interval: started.interval,
      browser_opened: opened,
    }));
  } else {
    printWaiting({ url, userCode: started.user_code, opened });
  }

  let intervalMs = (intervalSeconds(started.interval) || 5) * 1000;
  const deadline = Date.now() + (Number(started.expires_in) || 600) * 1000;
  let stopped = false;
  const onSigint = () => {
    stopped = true;
  };
  process.once("SIGINT", onSigint);

  try {
    while (!stopped && Date.now() < deadline) {
      await sleep(intervalMs, () => stopped);
      if (stopped) break;
      let res;
      try {
        res = await api.rawRequest("POST", "/api/auth/device/token", {
          flags,
          body: { grant_type: GRANT_TYPE, device_code: started.device_code, client_id: CLIENT_ID },
        });
      } catch (error) {
        if (!flags.quiet) console.error(c.dim(`  Still trying to reach the API (${error.message}).`));
        continue;
      }
      const step = interpretTokenResponse(res.status, res.body);
      if (step.type === "approved") {
        api.storeSession(flags, res.body.access_token);
        if (step.deviceSessionId) {
          const cfg = loadConfig();
          const deviceSessions = { ...(cfg.deviceSessions || {}) };
          deviceSessions[api.currentEnv(cfg, flags)] = step.deviceSessionId;
          saveConfig({ ...cfg, deviceSessions });
        }
        if (flags.json) {
          console.log(JSON.stringify({
            status: "authorized",
            scope: step.scope,
            signing: false,
          }));
        } else {
          await printSuccess(flags);
        }
        return;
      }
      if (step.type === "pending") continue;
      if (step.type === "slow_down" || step.type === "backoff") {
        intervalMs = (step.interval || 5) * 1000;
        continue;
      }
      if (step.type === "denied") return out.fail("Authorization denied.");
      if (step.type === "expired") return out.fail("The device code expired. Run furlpay login again.");
      if (step.type === "invalid") return out.fail("The device code is no longer valid.");
      return out.fail(`Authorization failed${step.status ? ` (HTTP ${step.status})` : ""}.`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  if (stopped) {
    try {
      await api.rawRequest("POST", "/api/auth/device/cancel", {
        flags,
        body: { device_code: started.device_code, client_id: CLIENT_ID },
      });
    } catch {
      /* the grant expires on its own */
    }
    out.fail("Cancelled.");
    return;
  }
  out.fail("Timed out waiting for authorization.");
}

module.exports = {
  deviceLogin,
  browserUrlAllowed,
  interpretTokenResponse,
};

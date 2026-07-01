#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { c, loadConfig, saveConfig, sign, parseFlags } = require("../lib/util");
const { SAMPLES, buildEvent } = require("../lib/events");

const [, , command, ...rest] = process.argv;
const flags = parseFlags(rest);

function post(targetUrl, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      { method: "POST", headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function help() {
  console.log(`
${c.bold("Furlpay CLI")} ${c.dim("v0.1.0")}

${c.bold("Usage")}
  furlpay <command> [options]

${c.bold("Commands")}
  login --key <sk_...>              Store your API/webhook secret locally
  listen --forward-to <url>         Stream sandbox webhooks to your local server
  trigger <event> [--forward-to u]  Emit a signed test event
  logs --tail                       Stream live API request/response cycles
  events                            List triggerable event types

${c.bold("Examples")}
  furlpay login --key sk_sandbox_123
  furlpay listen --forward-to localhost:3000/api/webhooks
  furlpay trigger card.transaction.authorized
`);
}

async function main() {
  const cfg = loadConfig();
  const secret = flags.secret || cfg.secret || cfg.key || "whsec_sandbox_bridge";

  switch (command) {
    case "login": {
      if (!flags.key) return console.error(c.red("Error: --key is required"));
      saveConfig({ ...cfg, key: flags.key, secret: flags.secret || flags.key });
      console.log(c.green("✓ ") + "Credentials saved to ~/.furlpay/config.json");
      break;
    }

    case "events": {
      console.log(c.bold("Triggerable events:"));
      Object.keys(SAMPLES).forEach((e) => console.log("  " + c.cyan(e)));
      break;
    }

    case "trigger": {
      const type = rest.find((a) => !a.startsWith("--"));
      if (!type || !SAMPLES[type]) {
        console.error(c.red("Unknown event. Run `furlpay events` to list them."));
        process.exit(1);
      }
      const base = flags["forward-to"] || cfg.forwardTo;
      if (!base) {
        console.error(c.red("Provide --forward-to <url> or run `furlpay listen` first."));
        process.exit(1);
      }
      const { route, event } = buildEvent(type);
      const body = JSON.stringify(event);
      const target = normalize(base) + route;
      const header = sign(body, secret, event.created);
      try {
        const res = await post(target, body, { "furlpay-signature": header });
        const ok = res.status >= 200 && res.status < 300;
        console.log(`${ok ? c.green("✓") : c.red("✗")} ${c.bold(type)} → ${target}  ${c.dim(res.status)}`);
        if (res.body) console.log(c.dim("  " + res.body.slice(0, 200)));
      } catch (e) {
        console.error(c.red("✗ " + e.message));
      }
      break;
    }

    case "listen": {
      const forwardTo = flags["forward-to"];
      if (!forwardTo) return console.error(c.red("Error: --forward-to <url> is required"));
      saveConfig({ ...cfg, forwardTo: normalize(forwardTo) });
      console.log(c.green("✓ ") + `Ready — forwarding sandbox webhooks to ${c.cyan(normalize(forwardTo))}`);
      console.log(c.dim("  Signing with secret " + secret.slice(0, 12) + "…  (Ctrl+C to stop)\n"));

      const types = Object.keys(SAMPLES).filter((t) => SAMPLES[t].route);
      let i = 0;
      const tick = async () => {
        const type = types[i++ % types.length];
        const { route, event } = buildEvent(type);
        const body = JSON.stringify(event);
        const header = sign(body, secret, event.created);
        try {
          const res = await post(normalize(forwardTo) + route, body, { "furlpay-signature": header });
          console.log(`${new Date().toLocaleTimeString()}  ${c.cyan("-->")} ${type}  ${c.dim("[" + res.status + "]")}`);
        } catch (e) {
          console.log(`${new Date().toLocaleTimeString()}  ${c.red("xxx")} ${type}  ${c.dim(e.message)}`);
        }
      };
      setInterval(tick, 4000);
      tick();
      break;
    }

    case "logs": {
      console.log(c.dim("Streaming live logs (Ctrl+C to stop)…\n"));
      const lines = [
        "200 POST /api/wallets/transfer  gasSponsored=true",
        "202 POST /api/webhooks/marqeta  jit_funding.approved=true",
        "403 POST /api/wallets/transfer  blocked_by_aml",
        "200 GET  /api/investing/portfolio",
        "200 POST /api/swaps  route=USDT->USDC base",
      ];
      let n = 0;
      setInterval(() => {
        const line = lines[n++ % lines.length];
        const code = line.slice(0, 3);
        const paint = code.startsWith("2") ? c.green : code.startsWith("4") ? c.yellow : c.red;
        console.log(`${c.dim(new Date().toLocaleTimeString())}  ${paint(line)}`);
      }, 1500);
      break;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;

    default:
      console.error(c.red(`Unknown command: ${command}`));
      help();
      process.exit(1);
  }
}

function normalize(url) {
  return /^https?:\/\//.test(url) ? url : "http://" + url;
}

main();

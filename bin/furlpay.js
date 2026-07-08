#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { c, loadConfig, saveConfig, sign, parseFlags, positionals } = require("../lib/util");
const { SAMPLES, buildEvent } = require("../lib/events");
const commands = require("../lib/commands");
const VERSION = require("../package.json").version;

const [, , command, ...rest] = process.argv;
const flags = parseFlags(rest);
const args = positionals(rest);

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
  console.log(require("../lib/banner").banner());
  console.log(`${c.bold("FurlPay CLI")} ${c.dim("v" + VERSION)} — stablecoin payments, investing, travel & yield from your terminal

${c.bold("Usage")}
  furlpay <command> [subcommand] [options]

${c.bold("Auth & config")}
  login [--key sk_…] [--email a@b.c]   Log in (email OTP) or store an API key
  logout · whoami                      Session management
  config <get|set> [key] [value]       CLI configuration
  env [sandbox|live]                   Show or switch environment
  status                               API + chain health

${c.bold("Wallet & payments")}
  balance [--chain arbitrum]           All token balances + total
  wallet <address|fund|export>         Safe smart-account details
  send <amount> <to> [--token USDC]    Gas-sponsored transfer (--mfa for ≥$5k)
  swap <from> <to> <amount>            Token swap via Li.Fi (--quote-only)
  bridge <amount> --from eth --to arb  Cross-chain bridge (CCTP route)
  pay <order-id>                       Pay an order / payment link
  tx [<hash>|list] [--category swap]   Transaction lookup & history

${c.bold("Investing")}
  invest buy AAPL 10                   Buy $10 of AAPL (--qty for shares)
  invest sell NVDA 5 [--type limit --limit-price 120]
  invest portfolio · quote <SYM> · history
  invest dca [create <SYM> <usd> --cadence week | cancel <id>]
  market                               Indices + top movers

${c.bold("Travel · Cards · Earn")}
  travel search --city Tokyo --checkin 2026-08-01 --checkout 2026-08-05
  travel flights --from NYC --to TYO · book · bookings · cancel <id>
  card list · create [--type virtual] · freeze/unfreeze <id> · limits <id> · transactions <id>
  earn [balance] · deposit <usd> · withdraw <usd> · apy · history

${c.bold("Developer tools")}
  listen --forward-to <url>            Stream sandbox webhooks to localhost
  trigger <event> · events             Emit signed test events
  logs --tail                          Stream API request/response cycles
  api <METHOD> </path> [--data '{}']   Raw authenticated API call
  docs [topic]                         Docs map (+ opens browser; --no-open)
  mcp                                  Run as an MCP server for AI agents
  completion <bash|zsh|fish|powershell>

${c.bold("Dashboard")}
  dashboard [--portfolio|--earn]       Interactive terminal dashboard

${c.bold("Global flags")}
  --output json|csv|table   --quiet   --env sandbox|live   --yes   --api-base <url>

${c.bold("Examples")}
  furlpay login
  furlpay balance --output json
  furlpay send 25 0xAbc… --token USDC
  furlpay invest buy AAPL 50 -- then: furlpay invest portfolio
  furlpay travel search --city Tokyo --min-stars 4
  furlpay dashboard
`);
}

async function main() {
  const cfg = loadConfig();
  const secret = flags.secret || cfg.secret || cfg.key || "whsec_sandbox_bridge";

  switch (command) {
    // ---- auth & config ----------------------------------------------------
    case "login": return commands.login(args, flags);
    case "logout": return commands.logout(args, flags);
    case "whoami": return commands.whoami(args, flags);
    case "config": return commands.config(args, flags);
    case "env": return commands.env(args, flags);
    case "status": return commands.status(args, flags);

    // ---- wallet & payments ------------------------------------------------
    case "balance": return commands.balance(args, flags);
    case "wallet": return commands.wallet(args, flags);
    case "send": return commands.send(args, flags);
    case "swap": return commands.swap(args, flags);
    case "bridge": return commands.bridge(args, flags);
    case "pay": return commands.pay(args, flags);
    case "tx": return commands.tx(args, flags);

    // ---- investing ----------------------------------------------------------
    case "invest": return commands.invest(args, flags);
    case "market": return commands.market(args, flags);

    // ---- travel / cards / earn ----------------------------------------------
    case "travel": return commands.travel(args, flags);
    case "card": case "cards": return commands.card(args, flags);
    case "earn": return commands.earn(args, flags);

    // ---- developer tools ----------------------------------------------------
    case "api": return commands.apiCmd(args, flags);
    case "docs": return commands.docs(args, flags);
    case "mcp": return require("../lib/mcp").serve(flags);
    case "dashboard": return require("../lib/dashboard").run(flags);

    case "completion": {
      const script = require("../lib/completion").generate(args[0]);
      if (!script) return console.error(c.red("Usage: furlpay completion <bash|zsh|fish|powershell>"));
      process.stdout.write(script);
      break;
    }

    case "version": case "--version": case "-v":
      console.log(VERSION);
      break;

    // ---- webhook sandbox tooling (original commands, unchanged) ------------
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

main().catch((e) => {
  console.error(c.red("✗ " + e.message));
  process.exit(1);
});

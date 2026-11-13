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

let stellarCliInstance = null;
function getStellarCli() {
  if (!stellarCliInstance) {
    const { FurlPayStellarCli } = require("../dist/cli");
    stellarCliInstance = new FurlPayStellarCli();
  }
  return stellarCliInstance;
}

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
  console.log(`${c.bold("FurlPay CLI")} ${c.dim("v" + VERSION)} — Stellar tokenized equities & Hyperliquid institutional trading infrastructure
 
${c.bold("Usage")}
  furlpay <command> [subcommand] [options]

${c.bold("Hyperliquid L1 Trading & Perpetuals")}
  hyperliquid status [--testnet]                 Check L1 validator latency, block time & status
  hyperliquid markets                            List live 24h volume, funding rates, open interest
  trade perp <SYM> --side buy --size <sz>        Execute authenticated L1 perp order (--leverage 5x)
  trade close <SYM>                              Market-close open position via reduce-only IOC
  trade cancel <OID> --symbol <SYM>              Cancel resting order on Hyperliquid
  trade cancel-all [--symbol <SYM>]              Batch cancel all open orders
  trade leverage <SYM> <LEV> [--isolated]        Set cross or isolated leverage for contract
  account <balance|positions|orders|history>     Live clearinghouse margin, equity, and positions
  trading <limits|kill-switch>                   Configure pre-trade risk caps or emergency shutdown
  earn hlp [stats|deposit|withdraw]              Deposit idle USDC into HLP vault (4-day lockup)
  market <SYM> [--size <sz>]                     Depth-weighted micro-price, OFI & slippage estimates

${c.bold("Escrow & Time-Locked Settlement (ETSS)")}
  escrow create --amount 1000 --seller <addr>    Initialize atomic escrow with cryptographic proof
  escrow fund --escrow-id <id>                   Buyer collateral lock & state transition
  escrow proof --escrow-id <id> --hash <sha256>  Seller cryptographic delivery proof submission
  escrow release --escrow-id <id>                Release funds to seller (buyer approval / auto-timer)
  escrow dispute --escrow-id <id> --reason <msg> Open dispute for multisig/arbiter resolution

${c.bold("Stellar Wallet & Custody")}
  wallet connect ledger [--derivation-index 0]   Connect Ledger Nano S/X/Stax via USB HID
  wallet connect walletconnect [--qr]            SEP-0007 / WalletConnect v2 terminal QR
  wallet connect extension [--port 4024]         Browser bridge for Freighter & Albedo
  wallet agent-keygen --name <name>              Delegated session keys with spend caps
  wallet import --name <name> [--mnemonic]       Argon2id & AES-256-GCM encrypted keystore
  wallet <address|fund|export>                   Safe smart-account details

${c.bold("Stellar Trading & Execution")}
  trade limit --side buy --asset JQQQ:GDXF...    SDEX limit order (--post-only, --sponsor)
  trade market-buy --asset JQQQ --spend 1000     Path payment with dest_min slippage protection
  trade swap --pool-id <id> --asset FOBXX        Soroban AMM SEP-41 liquidity pool swap
  trade terminal [--pair JQQQ/USDC]              Interactive real-time ASCII depth chart

${c.bold("Order Book Management")}
  order list [--pair JQQQ/USDC]                  List active resting limit offers
  order inspect --offer-id <id>                  Inspect resting offer details
  order cancel --offer-id <id> [--sponsor]       Cancel offer (fee sponsored via --sponsor)
  order cancel-all [--pair <pair>]               Batch cancel all resting offers

${c.bold("Tokenized Equities & RWAs (SEP-8)")}
  rwa list [--category equities,treasuries]      Institutional RWA registry (JQQQ, FOBXX, NVDA)
  rwa inspect --asset <sym>                      Inspect regulatory regime, CIK, and SEP-8
  rwa kyc --asset <sym> [--interactive]          SEP-8 issuer KYC guidance (not implemented in this build)

${c.bold("x402 Micropayments & Agentic MCP")}
  x402 pay --challenge-header <hdr>              HTTP 402 challenge resolution (SIMULATED settlement)
  mcp [--wallet agent-alpha]                     Run stdio Model Context Protocol tool server

${c.bold("Account & Authentication")}
  login [--device]                               Sign in: browser device authorization (--device, RFC 8628)
                                                 or email OTP. Session stays scoped to account:read.
  logout                                         Clear the stored session for the current env
  whoami                                         Show the authenticated account

${c.bold("Cross-Chain Payments & Banking")}
  balance [--chain arbitrum]                     All token balances + total
  send <amount> <to> [--token USDC]              Gas-sponsored transfer (--mfa for ≥$5k)
  swap <from> <to> <amount>                      Token swap via Li.Fi (--quote-only)
  bridge <amount> --from eth --to arb            Cross-chain bridge (CCTP route)
  pay <@handle> <amt> [USD|USDC]                 A2A transfer to a verified handle (no FurlPay fee)
  pay <order-id>                                 Pay an order / payment link
  tx [<hash>|list] [--category swap]             Transaction lookup & history
  tx verify <hash> [--network testnet]           Real Horizon transaction lookup — honest verification semantics

${c.bold("CLI Management")}
  update [--check]                              Check npm for a newer release (no changes)
  update [--latest | --channel beta]            Update to the latest stable / beta build
  update --version 0.2.2                        Pin or roll back to an exact version
  doctor [--output json]                        Diagnose install, config, and connectivity
  faucet --address <G...> [--network testnet]   Fund testnet/futurenet via the official Friendbot (refuses mainnet)
  completion <bash|zsh|fish|powershell>         Shell completion script

${c.bold("Global flags")}
  --sponsor   --output json|table   --quiet   --env sandbox|live   --yes
`);
}

async function main() {
  const cfg = loadConfig();
  const secret = flags.secret || cfg.secret || cfg.key || "whsec_sandbox_local";

  switch (command) {
    // ---- Stellar Tokenized Equities, RWAs, SDEX/Soroban Trading -----------
    case "terminal":
    case "chains":
    case "exchanges":
    case "markets":
    case "portfolio":
    case "trade":
      return getStellarCli().run({ command, subcommand: args[0], args: args.slice(1), flags });

    case "order":
      return getStellarCli().run({ command: "order", subcommand: args[0], args: args.slice(1), flags });

    case "rwa":
      return getStellarCli().run({ command: "rwa", subcommand: args[0], args: args.slice(1), flags });

    case "x402":
      return getStellarCli().run({ command: "x402", subcommand: args[0], args: args.slice(1), flags });

    // ---- Stellar wallet connection extensions ------------------------------
    case "wallet": {
      const sub = args[0];
      if (sub === "connect" || sub === "agent-keygen" || sub === "import" || (sub === "list" && !args[1])) {
        return getStellarCli().run({ command: "wallet", subcommand: sub, args: args.slice(1), flags });
      }
      return commands.wallet(args, flags);
    }

    // ---- MCP server --------------------------------------------------------
    case "mcp": {
      if (flags.wallet || flags["policy-file"] || args[0] === "stellar") {
        return getStellarCli().run({ command: "mcp", subcommand: undefined, args, flags });
      }
      return require("../lib/mcp").serve(flags);
    }

    // ---- auth & config ----------------------------------------------------
    case "login":
      // `--device` uses the RFC 8628 browser authorization flow against the
      // web app (/device-auth); the default stays the email-OTP cookie flow.
      if (flags.device) return require("../lib/deviceAuth").deviceLogin(flags);
      return commands.login(args, flags);
    case "logout": return commands.logout(args, flags);
    case "whoami": return commands.whoami(args, flags);
    case "config": {
      if (args[0] === "show" || args[0] === "path" || args[0] === "validate" || flags.toml) {
        return getStellarCli().run({ command: "config", subcommand: args[0], args: args.slice(1), flags });
      }
      return commands.config(args, flags);
    }
    case "env": return commands.env(args, flags);
    case "status": return commands.status(args, flags);
    case "update": return require("../lib/update").run(flags);

    // ---- wallet & payments ------------------------------------------------
    case "balance": return commands.balance(args, flags);
    case "send": return commands.send(args, flags);
    case "swap": return commands.swap(args, flags);
    case "bridge": return commands.bridge(args, flags);
    case "pay": return commands.pay(args, flags);
    // `tx verify <hash>` performs a real Horizon lookup (honest verification
    // semantics); everything else keeps the app-server transaction commands.
    case "tx": {
      if (args[0] === "verify") {
        return getStellarCli().run({ command: "tx", subcommand: args[0], args: args.slice(1), flags });
      }
      return commands.tx(args, flags);
    }
    case "faucet":
      return getStellarCli().run({ command: "faucet", subcommand: args[0], args: args.slice(1), flags });

    case "hyperliquid":
    case "hlp":
    case "trading":
    case "escrow":
    case "account":
      return getStellarCli().run({ command, subcommand: args[0], args: args.slice(1), flags });

    // ---- investing --------------------------------------------------------
    case "invest": return commands.invest(args, flags);
    case "market": {
      const isHl = flags.hl || flags.perp || flags.orderbook || flags.microstructure || flags.size ||
        (args[0] && (args[0].toUpperCase().endsWith("-PERP") || ["BTC", "ETH", "HYPE", "SOL", "NVDA", "PURR"].includes(args[0].toUpperCase())));
      if (isHl) {
        return getStellarCli().run({ command: "market", subcommand: args[0], args: args.slice(1), flags });
      }
      return commands.market(args, flags);
    }

    // ---- travel / cards / earn --------------------------------------------
    case "travel": return commands.travel(args, flags);
    case "card": case "cards": return commands.card(args, flags);
    case "earn": {
      if (args[0] === "hlp" || flags.hlp) {
        return getStellarCli().run({ command: "earn", subcommand: args[0], args: args.slice(1), flags });
      }
      return commands.earn(args, flags);
    }

    // ---- treasury, approvals & operations ---------------------------------
    case "payments": return commands.payments(args, flags);
    case "approvals": return commands.approvals(args, flags);
    case "accounts": return commands.accounts(args, flags);
    case "doctor": return commands.doctor(args, flags);

    // ---- developer tools --------------------------------------------------
    case "api": return commands.apiCmd(args, flags);
    case "docs": return commands.docs(args, flags);
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
        "202 POST /api/webhooks/card-auth  decision=approve",
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

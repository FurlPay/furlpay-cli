/**
 * FurlPay CLI Dispatcher — Stellar Tokenized Equities & Hyperliquid Trading Infrastructure
 */

// dotenv is a declared dependency that was never imported (2026-11-17
// gap-closure): load ./.env if present so the documented env vars below work
// without shell exports. Silently no-ops when the file is absent.
import "dotenv/config";

import { loadConfig, saveConfig, getConfigPath, DEFAULT_CONFIG } from "./config";
import { LedgerSigner } from "./wallet/ledger";
import { Sep7Connector } from "./wallet/walletconnect";
import { ExtensionLoopbackBridge } from "./wallet/extension";
import { KeystoreService } from "./wallet/keystore";
import { AgentKeyService } from "./wallet/agentKey";
import { KeypairSigner } from "./wallet/signer";
import { SdexTradingService } from "./trade/sdex";
import { PathPaymentService } from "./trade/pathPayment";
import { SorobanTradingService } from "./trade/soroban";
import { OrderManager } from "./order/manager";
import { RwaRegistry } from "./rwa/registry";
import { X402Engine } from "./x402/micropayments";
import { McpStdioServer } from "./mcp/server";
import { OrderBookTerminal } from "./tui/terminal";
import { FurlPayInteractiveTerminal, TerminalScreen } from "./tui/interactive-terminal";
import { InstitutionalWorkstation } from "./tui/institutional-workstation";
import { MarketDiscoveryService } from "./market/discovery";
import { HlpVaultService } from "./hyperliquid/hlp";
import { HyperliquidPerpService } from "./hyperliquid/perp";
import { HyperliquidClient } from "./hyperliquid/client";
import { MarketDataService } from "./services/market-data";
import { HyperliquidRiskEngine, defaultTurnoverLedgerPath } from "./hyperliquid/risk-engine";
import { EscrowStateMachine, EscrowTerms } from "./settlement/escrow";
import { EscrowStore } from "./settlement/escrowStore";
import { sanitizeTerminal } from "./tui/sanitize";
import { verifyTransaction, TxVerificationResult } from "./stellar/txVerify";
import { requestFunds, isValidStellarAddress, FaucetResult, FaucetNetwork } from "./stellar/faucet";
import { validateConfig } from "./config/validate";
import { BinanceAdapter } from "./binance/binance.adapter";
import { DurableEventStore, defaultBlotterPath } from "./blotter/durable-event-store";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import * as crypto from "crypto";
import * as readline from "readline";

export interface ParsedCliArgs {
  command: string;
  subcommand?: string;
  args: string[];
  flags: Record<string, any>;
}

/**
 * Read a secret (key material or password) from stdin without ever echoing
 * it into argv: `printf '%s\n%s\n' S... pw | furlpay wallet import` works in
 * CI and on every shell. A piped line ends at the first newline; a TTY user
 * is told the terminal echo stays on, so piping is recommended.
 */
/**
 * Read a secret from stdin. Piped input is read line-by-line as before.
 *
 * TTY input (audit P9, CWE-522) is read in RAW MODE with asterisk masking —
 * the old readline path echoed master seed phrases and private keys to the
 * screen character-by-character, exposing them to shoulder surfing, screen
 * recordings and session logs. Only masking happens here: the value never
 * appears in the terminal or in any log.
 */
async function readStdinSecret(): Promise<string | null> {
  if (process.stdin.isTTY) {
    console.log("(reading from the terminal — input is masked; pipe the value in to avoid typing it)");
    return readMaskedLine();
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed) return trimmed;
    }
    return null;
  } finally {
    rl.close();
  }
}

/** One masked line from a TTY: raw mode, per-keystroke asterisks, no echo. */
function readMaskedLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    let done = false;

    const finish = (result: string | null) => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(false);
      } catch {
        /* non-raw stdin */
      }
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };

    const onData = (chunk: string | Buffer) => {
      // Paste bursts and terminal escape sequences arrive as multi-char
      // chunks; single-char handling below stays correct because each char
      // is processed independently.
      for (const ch of String(chunk)) {
        if (done) return;
        if (ch === "\r" || ch === "\n") {
          finish(value.trim() || null);
          return;
        }
        if (ch === "\u0003") {
          // Ctrl-C in raw mode arrives as data, not SIGINT — abort cleanly.
          finish(null);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " " || ch === "\u001b") {
          continue; // ignore other control chars / ESC sequence heads
        }
        value += ch;
        process.stdout.write("*");
      }
    };

    try {
      stdin.setRawMode(true);
    } catch {
      /* stdin may not support raw mode — fall through, still no echo */
    }
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

export class FurlPayStellarCli {
  private keystore: KeystoreService;
  private agentKeys: AgentKeyService;
  private sdex: SdexTradingService;
  private pathPayment: PathPaymentService;
  private soroban: SorobanTradingService;
  private orders: OrderManager;
  private rwa: RwaRegistry;
  private x402: X402Engine;
  private hlp: HlpVaultService;
  private perp: HyperliquidPerpService;
  private marketData: MarketDataService;
  private hlClient: HyperliquidClient;
  private riskEngine: HyperliquidRiskEngine;

  constructor() {
    this.keystore = new KeystoreService();
    this.agentKeys = new AgentKeyService();
    this.sdex = new SdexTradingService();
    this.pathPayment = new PathPaymentService();
    this.soroban = new SorobanTradingService();
    this.orders = new OrderManager();
    this.rwa = new RwaRegistry();
    this.x402 = new X402Engine();
    this.hlp = new HlpVaultService();
    this.perp = new HyperliquidPerpService();
    this.marketData = new MarketDataService();
    this.hlClient = new HyperliquidClient();
    this.riskEngine = new HyperliquidRiskEngine(undefined, { turnoverLedgerPath: defaultTurnoverLedgerPath() });
  }

  async run(cliArgs: ParsedCliArgs): Promise<void> {
    const { command, subcommand, args, flags } = cliArgs;

    switch (command) {
      case "quant":
      case "terminal":
        await this.handleTerminal(subcommand, args, flags, command === "quant");
        break;

      case "chains":
        await this.handleChains(args, flags);
        break;

      case "exchanges":
        await this.handleExchanges(args, flags);
        break;

      case "markets":
        await this.handleMarkets(subcommand, args, flags);
        break;

      case "portfolio":
        await this.handlePortfolio(args, flags);
        break;

      case "wallet":
        await this.handleWallet(subcommand, args, flags);
        break;

      case "trade":
        await this.handleTrade(subcommand, args, flags);
        break;

      case "order":
        await this.handleOrder(subcommand, args, flags);
        break;

      case "rwa":
        await this.handleRwa(subcommand, args, flags);
        break;

      case "x402":
        await this.handleX402(subcommand, args, flags);
        break;

      case "mcp":
        await this.handleMcp(args, flags);
        break;

      case "earn":
      case "hlp":
        await this.handleEarn(subcommand, args, flags);
        break;

      case "hyperliquid":
        await this.handleHyperliquid(subcommand, args, flags);
        break;

      case "binance":
        await this.handleBinance(subcommand, args, flags);
        break;

      case "market":
        await this.handleMarket(subcommand, args, flags);
        break;

      case "account":
        await this.handleAccount(subcommand, args, flags);
        break;

      case "trading":
        await this.handleTrading(subcommand, args, flags);
        break;

      case "escrow":
        await this.handleEscrow(subcommand, args, flags);
        break;

      case "tx":
        await this.handleTx(subcommand, args, flags);
        break;

      case "faucet":
        await this.handleFaucet(subcommand, args, flags);
        break;

      case "config":
        await this.handleConfig(subcommand, args, flags);
        break;

      case "finance":
        await this.handleFinance(subcommand, args, flags);
        break;

      default:
        this.printHelp();
    }
  }

  private async handleWallet(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];

    if (sub === "connect") {
      const mode = args[0] === "connect" ? args[1] : args[0];

      if (mode === "ledger") {
        console.log("[+] Probing USB HID for Ledger devices...");
        const ledger = new LedgerSigner(flags["derivation-index"] ? parseInt(flags["derivation-index"]) : 0, flags["derivation-path"]);
        const info = await ledger.probe();
        console.log(`[+] Found ${info.model} (Firmware v${info.firmwareVersion}, Stellar App v${info.appVersion})`);
        console.log(`[+] Public Key: ${info.publicKey}`);
        // 2026-11-17 honesty fix: the old line printed a fabricated
        // "Balance: 14,500.00 USDC | 0.00 XLM (Sponsored Mode Active)" — no
        // balance was ever queried. A device probe proves reachability only.
        console.log(`[i] Device probe only — no balance was queried. Use a Horizon balance lookup for real funds.`);
        return;
      }

      if (mode === "walletconnect" || mode === "sep7") {
        const sep7 = new Sep7Connector();
        const uri = sep7.generateSep7Uri("SAMPLE_INIT_XDR");
        console.log(sep7.renderAsciiQr(uri));
        return;
      }

      if (mode === "extension") {
        const port = flags.port ? parseInt(flags.port) : 4024;
        const bridge = new ExtensionLoopbackBridge(port);
        console.log(`[+] Launching local loopback bridge on http://127.0.0.1:${port}`);
        console.log(`[+] Waiting for Freighter / Albedo authorization...`);
        return;
      }
    }

    if (sub === "agent-keygen") {
      const name = flags.name || args[0] || "agent-alpha";
      const dailyLimit = flags["daily-limit"] ? parseFloat(flags["daily-limit"]) : 25.0;
      const allowed = flags["allowed-assets"] ? flags["allowed-assets"].split(",") : ["USDC", "JQQQ"];
      const expiry = flags.expiry ? parseInt(flags.expiry) : 7;

      const generated = this.agentKeys.generateAgentKey({
        name,
        dailyLimit,
        allowedAssets: allowed,
        expiryDays: expiry,
      });

      console.log(`[+] Generated Delegated Agent Keypair: ${name}`);
      console.log(`    - Public Key:  ${generated.policy.publicKey}`);
      console.log(`    - Policy:      Daily spend cap \$${dailyLimit} USD, Assets: [${allowed.join(", ")}]`);
      console.log(`    - Expiry:      ${expiry} days (${new Date(generated.policy.expiryTimestamp).toISOString()})`);
      console.log(`    - Stored in:   ~/.furlpay/agent-policies/${name}.json (secret key sealed with AES-256-GCM)`);
      console.log(`[i] Revoke at any time: furlpay wallet agent-revoke ${name}`);
      return;
    }

    if (sub === "agent-list") {
      const keys = this.agentKeys.listAgentKeys();
      if (keys.length === 0) {
        console.log("No delegated agent keys found (create one: furlpay wallet agent-keygen --name <name>).");
        return;
      }
      console.log(`Delegated agent keys (${keys.length}):`);
      for (const k of keys) {
        const tag = k.revoked ? "[REVOKED]" : "[active]";
        console.log(`  ${k.name.padEnd(20)} ${k.publicKey}  ${tag}  expires ${k.expiresAt}`);
      }
      return;
    }

    if (sub === "agent-revoke") {
      const name = flags.name || args[0];
      const keys = this.agentKeys.listAgentKeys();
      if (!name) {
        console.log("Usage: furlpay wallet agent-revoke <name>");
        console.log(`Known agent keys: ${keys.map((k) => k.name).join(", ") || "(none)"}`);
        process.exitCode = 1;
        return;
      }
      const res = this.agentKeys.revokeAgentKey(name);
      if (!res) {
        console.error(`[!] No agent key named "${name}" exists. Known: ${keys.map((k) => k.name).join(", ") || "(none)"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`[✓] Agent key "${res.agentName}" revoked at ${res.revokedAt}.`);
      console.log(`    Public key: ${res.publicKey}`);
      console.log(`    Every spend validation fails from now on; the policy file is kept as an audit record.`);
      return;
    }

    if (sub === "import") {
      // The caller's key is what gets imported — never a generated stand-in.
      // BOTH the key and the encryption password arrive on stdin, never as
      // argv values: command arguments are visible to every local process via
      // the process table (ps -ef / Task Manager command line), persist in
      // shell history, and surface verbatim in crash reports. A hardcoded
      // default password would make the keystore decryptable by anyone with
      // read access to the file, so the password is mandatory.
      const name = flags.name || args[0] || "default";
      const secretKey = (await readStdinSecret()) || "";
      const password = (await readStdinSecret()) || "";
      if (!secretKey || !password) {
        console.log("Usage: furlpay wallet import --name <name>");
        console.log("  The secret key, then the encryption password, are read from two stdin lines:");
        console.log("    printf '%s\\n%s\\n' S... my-password | furlpay wallet import --name mykey");
        console.log("  Secrets are never accepted as command-line arguments: argv is exposed");
        console.log("  to every local process and retained in shell history.");
        return;
      }
      let entry;
      try {
        entry = this.keystore.importSecretKey(name, secretKey, password);
      } catch (e) {
        console.error(`[!] Import failed: ${(e as Error).message}`);
        return;
      }
      console.log(`[+] Account '${name}' imported into the encrypted keystore.`);
      console.log(`    - Public key: ${entry.publicKey}`);
      console.log("    The secret key itself is never displayed or logged.");
      return;
    }

    if (sub === "list") {
      const keys = this.keystore.listKeys();
      console.log(`Found ${keys.length} stored account(s) in keystore:`);
      for (const k of keys) {
        console.log(`  - ${k.name.padEnd(20)} ${k.publicKey} (${k.type})`);
      }
      return;
    }

    console.log("Usage: furlpay wallet <connect ledger|connect walletconnect|connect extension|agent-keygen|agent-list|agent-revoke|import|list>");
    console.log("  import: the secret key and password come from --secret-key/--password or stdin lines (never echoed, never logged).");
  }

  private async handleTrade(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];
    const dummyKeypair = Keypair.random();
    const signer = new KeypairSigner(dummyKeypair);

    if (sub === "terminal") {
      await this.handleTerminal(args[1], args.slice(1), flags);
      return;
    }

    if (sub === "buy" || sub === "sell") {
      const sym = (args[0] === sub ? args[1] : args[0]) || flags.symbol || flags.market || "HYPE";
      const clean = (sym || "HYPE").toUpperCase().replace(/-PERP$/i, "");
      const size = flags.size ? parseFloat(flags.size) : 1.0;
      const leverage = flags.leverage ? parseInt(flags.leverage) : 3;
      const price = flags.price ? parseFloat(flags.price) : undefined;
      const orderType = price ? "limit" : (flags["order-type"] || "market");

      if (clean === "JQQQ" || clean === "FOBXX" || clean === "XLM") {
        const result = await this.sdex.executeLimitOrder(signer, {
          side: sub,
          asset: clean === "JQQQ" ? "JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ" : `${clean}:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`,
          against: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          amount: size.toString(),
          price: (price || (clean === "JQQQ" ? 104.2 : 1.0)).toString(),
          sponsor: flags.sponsor !== false,
        });
        // Honesty first (external audit 2026-11-17b H-03): a simulated fill
        // is a labeled simulation, never a green checkmark claiming a real
        // broadcast. `result.simulated` is authoritative.
        if (result.simulated) {
          console.log(`[!] SIMULATED Stellar SDEX Trade — no transaction was built, signed or broadcast to Stellar.`);
          console.log(`[i] Simulated fill: ${result.filledAmount} ${clean} @ \$${result.price} | sim hash: ${result.txHash?.slice(0, 14) ?? "n/a"}…`);
        } else {
          console.log(`[✓] Stellar SDEX Trade Executed! Filled ${result.filledAmount} ${clean} @ \$${result.price}`);
        }
        return;
      } else {
        const result = await this.perp.executePerpOrder({
          symbol: `${clean}-PERP`,
          side: sub,
          size,
          price,
          leverage,
          orderType,
        });
        console.log(`[✓] Hyperliquid L1 Order Executed! Order ID: #${result.orderId} | Venue: ${result.venue}`);
        console.log(`    - Side:         ${result.side.toUpperCase()}`);
        console.log(`    - Size:         ${result.size} ${clean}`);
        console.log(`    - Fill Price:   \$${result.fillPrice} USD`);
        console.log(`    - Notional:     \$${result.notionalUsd} USD (${leverage}x Cross-Margin)`);
        console.log(`    - Margin Req:   \$${result.marginRequirementUsd} USD`);
        console.log(`    - Est. Liq:     \$${result.liquidationPriceEstimated} USD`);
        console.log(`    - Client OID:   ${result.txHash}`);
        return;
      }
    }

    if (sub === "limit") {
      const side = (flags.side || "buy").toLowerCase() as "buy" | "sell";
      const asset = flags.asset || "JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ";
      const against = flags.against || "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const amount = flags.amount || "25";
      const price = flags.price || "104.20";
      const sponsor = flags.sponsor !== false;

      const result = await this.sdex.executeLimitOrder(signer, {
        side,
        asset,
        against,
        amount,
        price,
        postOnly: Boolean(flags["post-only"]),
        sponsor,
      });

      console.log(`[!] SIMULATED — no transaction was built, signed or broadcast to Stellar.`);
      console.log(`[i] Simulated fill: Ledger #${result.ledgerNumber} | sim hash: ${result.txHash.slice(0, 14)}…`);
      console.log(`    - Filled:          ${result.filledAmount} ${asset.split(":")[0]} @ ${result.price} ${against.split(":")[0]}`);
      console.log(`    - Total Value:     ${result.totalCost} ${against.split(":")[0]}`);
      console.log(`    - Transaction Fee: ${result.feePaidUsd}`);
      return;
    }

    if (sub === "market-buy") {
      const asset = flags.asset || "JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ";
      const withAsset = flags.with || "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const spend = flags.spend || "1000.00";
      const slippage = flags.slippage ? parseFloat(flags.slippage) : 0.5;
      const sponsor = flags.sponsor !== false;

      const result = await this.pathPayment.executeMarketBuy(signer, {
        asset,
        with: withAsset,
        spend,
        slippage,
        sponsor,
      });

      console.log(`[!] SIMULATED — no path-payment transaction was broadcast.`);
      console.log(`[i] Simulated settlement: Ledger #${result.ledgerNumber} | sim hash: ${result.txHash.slice(0, 14)}…`);
      console.log(`    - Spent:     ${result.spentAmount} ${result.sourceAsset.split(":")[0]}`);
      console.log(`    - Received:  ${result.receivedAmount} ${result.targetAsset.split(":")[0]}`);
      console.log(`    - Multi-Hop: ${result.hopsCount} route segments (Stellar has no public mempool; ordering is validator-shuffled — not an MEV guarantee)`);
      console.log(`    - Fee:       ${result.feePaidUsd}`);
      return;
    }

    if (sub === "swap") {
      const poolId = flags["pool-id"] || "7c8e99...SOROBAN_AMM";
      const sellAsset = flags["sell-asset"] || "USDC";
      const sellAmount = flags["sell-amount"] || "500";
      const minReceive = flags["min-receive"] || "4.88";
      const asset = flags.asset || "FOBXX";

      const result = await this.soroban.executeSwap(signer, {
        poolId,
        sellAsset,
        sellAmount,
        minReceive,
        asset,
        sponsor: flags.sponsor !== false,
      });

      console.log(`[!] SIMULATED — no Soroban contract call was submitted on-chain.`);
      console.log(`[i] Simulated swap: Ledger #${result.ledgerNumber} | sim hash: ${result.txHash.slice(0, 14)}…`);
      console.log(`    - Pool:     ${result.poolId}`);
      console.log(`    - Swapped:  ${result.soldAmount} ${result.soldAsset} → ${result.receivedAmount} ${result.targetAsset}`);
      console.log(`    - CPU Gas:  ${result.simulation.cpuInstructions.toLocaleString()} instructions simulated`);
      return;
    }

    if (sub === "perp") {
      const symbol = flags.symbol || args[1] || "BTC-PERP";
      const side = (flags.side || "buy").toLowerCase() as "buy" | "sell";
      const size = flags.size ? parseFloat(flags.size) : 0.05;
      const leverage = flags.leverage ? parseInt(flags.leverage) : 5;
      const price = flags.price ? parseFloat(flags.price) : undefined;
      const reduceOnly = Boolean(flags["reduce-only"]);

      const res = await this.perp.executePerpOrder({
        symbol,
        side,
        size,
        leverage,
        price,
        orderType: price ? "limit" : "market",
        reduceOnly,
      });

      console.log(`[✓] Hyperliquid L1 Perp Execution Confirmed!`);
      console.log(`    - Venue:       Hyperliquid L1 Validator Network (${this.perp.getClient().getNetwork()})`);
      console.log(`    - Order ID:    #${res.orderId}`);
      console.log(`    - Status:      ${res.status}`);
      console.log(`    - Contract:    ${res.symbol}`);
      console.log(`    - Side/Size:   ${res.side.toUpperCase()} ${res.size} contracts @ \$${res.fillPrice.toFixed(2)} USD`);
      console.log(`    - Notional:    \$${res.notionalUsd.toFixed(2)} USD (${leverage}x Cross-Margin)`);
      console.log(`    - Margin Req:  \$${res.marginRequirementUsd.toFixed(2)} USDC`);
      console.log(`    - Est. Liq:    \$${res.liquidationPriceEstimated.toFixed(2)} USD`);
      console.log(`    - Client OID:  ${res.txHash}`);
      return;
    }

    if (sub === "close") {
      const symbol = flags.symbol || args[1] || "BTC";
      console.log(`[+] Closing active position for ${symbol.toUpperCase()}...`);
      const res = await this.perp.closePosition(symbol);
      console.log(`[✓] Position Closed! Order #${res.orderId} filled at \$${res.fillPrice.toFixed(2)} USD.`);
      return;
    }

    if (sub === "cancel") {
      const orderId = parseInt(flags["order-id"] || args[1] || "0");
      const symbol = flags.symbol || args[2] || "BTC";
      if (!orderId) {
        console.log("Error: Supply order ID via `furlpay trade cancel <order-id> --symbol <SYM>`");
        return;
      }
      await this.perp.cancelOrder(symbol, orderId);
      console.log(`[✓] Resting order #${orderId} for ${symbol.toUpperCase()} canceled.`);
      return;
    }

    if (sub === "cancel-all") {
      const symbol = flags.symbol || args[1];
      console.log(`[+] Canceling all resting orders ${symbol ? `for ${symbol}` : "across all markets"}...`);
      const res = await this.perp.cancelAllOrders(symbol);
      console.log(`[✓] Canceled ${res.canceledCount} resting order(s).`);
      return;
    }

    if (sub === "leverage") {
      const symbol = flags.symbol || args[1] || "BTC";
      const lev = parseInt(args[2] || flags.leverage || "10");
      const isCross = !flags.isolated;
      await this.perp.setLeverage(symbol, lev, isCross);
      console.log(`[✓] Leverage for ${symbol.toUpperCase()} updated to ${lev}x (${isCross ? "Cross-Margin" : "Isolated Margin"}).`);
      return;
    }

    if (sub === "terminal") {
      const pair = flags.pair || "BTC/USDC";
      const term = new OrderBookTerminal({ pair });
      term.renderOnce();
      return;
    }

    console.log("Usage: furlpay trade <limit|market-buy|swap|perp|close|cancel|cancel-all|leverage|terminal> [options]");
  }

  private async handleHyperliquid(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0] || "status";
    const isTestnet = Boolean(flags.testnet);
    const client = new HyperliquidClient(isTestnet ? "testnet" : "mainnet");

    if (sub === "status") {
      const start = Date.now();
      const meta = await client.getMeta();
      const latencyMs = Date.now() - start;

      console.log(`Hyperliquid L1 Validator Network Status:`);
      console.log(`  - Environment:    ${isTestnet ? "Testnet (api.hyperliquid-testnet.xyz)" : "Mainnet (api.hyperliquid.xyz)"}`);
      console.log(`  - Status:         ONLINE (HTTP 200)`);
      console.log(`  - API Latency:    ${latencyMs} ms`);
      console.log(`  - Active Markets: ${meta.universe.length} Perpetual Contracts`);
      console.log(`  - Consensus L1:   Zero Gas Execution Protocol (1337 L1 / EIP-712 Phantom Agent)`);
      console.log(`  - HLP Vault:      0xdfc24b077bc1425ad1dea75bcb6f8158e10df303 (Active)`);
      return;
    }

    if (sub === "markets") {
      const [meta, assetCtxs] = await client.getMetaAndAssetCtxs();
      console.log(`Top Hyperliquid Perpetual Markets (${meta.universe.length} total):`);
      console.log(`SYM       MARK PRICE     24H VOLUME        FUNDING (1h)    OPEN INTEREST    MAX LEV`);
      console.log(`-----------------------------------------------------------------------------------`);
      const sample = ["BTC", "ETH", "HYPE", "SOL", "NVDA", "PURR"];
      for (const sym of sample) {
        const idx = meta.universe.findIndex((u) => u.name.toUpperCase() === sym);
        if (idx !== -1) {
          const u = meta.universe[idx];
          const ctx = assetCtxs[idx];
          const px = parseFloat(ctx.markPx || ctx.midPx || "0").toFixed(2);
          const vlm = (parseFloat(ctx.dayNtlVlm || "0") / 1_000_000).toFixed(1) + "M";
          const funding = (parseFloat(ctx.funding || "0") * 100).toFixed(4) + "%";
          const oi = parseFloat(ctx.openInterest || "0").toFixed(2);
          console.log(
            `${u.name.padEnd(9)} \$${px.padEnd(12)} \$${vlm.padEnd(15)} ${funding.padEnd(15)} ${oi.padEnd(16)} ${u.maxLeverage}x`
          );
        }
      }
      return;
    }

    console.log("Usage: furlpay hyperliquid <status|markets> [--testnet]");
  }

  private async handleMarket(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const symbol = (args[0] || flags.symbol || "BTC").replace(/-PERP$/i, "").toUpperCase();
    console.log(`Fetching institutional microstructure for ${symbol}-PERP on Hyperliquid L1...`);

    const analytics = await this.marketData.getMicrostructureAnalytics(symbol);
    const book = await this.marketData.getOrderBook(symbol);

    console.log(`\n================== ${symbol}-PERP MARKET MICROSTRUCTURE ==================`);
    console.log(`  Mid Price:               \$${analytics.midPrice.toFixed(2)} USD`);
    console.log(`  Depth-Weighted Micro-Px: \$${analytics.microPrice.toFixed(2)} USD`);
    console.log(`  Volume-Weighted Spread:  \$${analytics.volumeWeightedSpread.toFixed(4)} USD`);
    console.log(`  Rolling OFI Delta:       ${analytics.rollingOfi >= 0 ? "+" : ""}${analytics.rollingOfi.toFixed(2)} contracts`);
    console.log(`  Liquidity HHI (0-1):     ${analytics.liquidityHhi.toFixed(4)} (${analytics.liquidityHhi < 0.15 ? "Deep Unconcentrated" : "Concentrated"})`);
    console.log(`  Total Bid / Ask Depth:   ${analytics.bidDepthTotal} / ${analytics.askDepthTotal} ${symbol}`);
    console.log(`  Feed Status:             ${analytics.isStale ? "STALE" : "LIVE & HEALTHY"}`);
    console.log(`---------------------------------------------------------------------`);
    console.log(`Top 5 L2 Depth Levels:`);
    console.log(`  BIDS (${symbol})               PRICE (USD)              ASKS (${symbol})`);
    for (let i = 0; i < 5; i++) {
      const b = book.levels[0][i] || { px: "-", sz: "-" };
      const a = book.levels[1][i] || { px: "-", sz: "-" };
      console.log(`  ${b.sz.padEnd(20)} \$${b.px.padEnd(15)} | \$${a.px.padEnd(15)} ${a.sz}`);
    }

    if (flags.size) {
      const sz = parseFloat(flags.size);
      const estBuy = await this.marketData.estimateSlippage(symbol, "buy", sz);
      const estSell = await this.marketData.estimateSlippage(symbol, "sell", sz);
      console.log(`---------------------------------------------------------------------`);
      console.log(`Execution Slippage Estimation for ${sz} ${symbol}:`);
      console.log(`  BUY:  Avg Price \$${estBuy.expectedAvgPrice.toFixed(2)} | Price Impact: +${estBuy.priceImpactPct.toFixed(2)}% | Slippage: \$${estBuy.slippageUsd.toFixed(2)}`);
      console.log(`  SELL: Avg Price \$${estSell.expectedAvgPrice.toFixed(2)} | Price Impact: -${estSell.priceImpactPct.toFixed(2)}% | Slippage: \$${estSell.slippageUsd.toFixed(2)}`);
    }
  }

  private async handleAccount(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0] || "balance";
    const address = flags.address || process.env.HYPERLIQUID_WALLET_ADDRESS || "0x0000000000000000000000000000000000000000";

    const state = await this.hlClient.getClearinghouseState(address);

    if (sub === "balance" || sub === "equity") {
      console.log(`Hyperliquid Clearinghouse Account: ${address}`);
      console.log(`  - Total Equity:       \$${parseFloat(state.marginSummary.accountValue).toFixed(2)} USD`);
      console.log(`  - Total Margin Used:  \$${parseFloat(state.marginSummary.totalMarginUsed).toFixed(2)} USD`);
      console.log(`  - Total Position Val: \$${parseFloat(state.marginSummary.totalNtlPos).toFixed(2)} USD`);
      console.log(`  - Withdrawable Cash:  \$${parseFloat(state.withdrawable).toFixed(2)} USDC`);

      const risk = this.riskEngine.evaluateAccountRisk(state);
      console.log(`  - Margin Ratio:       ${risk.marginRatioPct}% ${risk.isHighRisk ? "[WARNING: ELEVATED]" : "[HEALTHY]"}`);
      if (risk.warningMessage) console.log(`  - Alert:              ${risk.warningMessage}`);
      return;
    }

    if (sub === "positions") {
      const positions = await this.perp.getPositions(address);
      console.log(`Active Hyperliquid Positions (${positions.length}):`);
      if (positions.length === 0) {
        console.log(`  No open perpetual positions.`);
        return;
      }
      for (const p of positions) {
        console.log(`  # ${p.symbol}: ${p.size > 0 ? "LONG" : "SHORT"} ${Math.abs(p.size)} @ \$${p.entryPrice.toFixed(2)}`);
        console.log(`    Mark: \$${p.markPrice.toFixed(2)} | PnL: ${p.unrealizedPnlUsd >= 0 ? "+" : ""}\$${p.unrealizedPnlUsd.toFixed(2)} (${p.returnOnEquityPct}%)`);
        console.log(`    Est. Liquidation: \$${p.liquidationPrice.toFixed(2)} | Leverage: ${p.leverage}x`);
      }
      return;
    }

    if (sub === "orders") {
      const orders = await this.hlClient.getUserOpenOrders(address);
      console.log(`Active Resting Orders (${orders.length}):`);
      for (const o of orders) {
        console.log(`  Order #${o.oid} | ${o.side === "B" ? "BUY" : "SELL"} ${o.sz} ${o.coin} @ \$${o.limitPx}`);
      }
      return;
    }

    if (sub === "history") {
      const fills = await this.hlClient.getUserFills(address);
      console.log(`Recent Trade Fills (${fills.length}):`);
      for (const f of fills.slice(0, 10)) {
        console.log(`  [${new Date(f.time).toLocaleTimeString()}] ${f.side === "B" ? "BOUGHT" : "SOLD"} ${f.sz} ${f.coin} @ \$${f.px} (Fee: \$${f.fee})`);
      }
      return;
    }

    console.log("Usage: furlpay account <balance|positions|orders|history> [--address <0x...>]");
  }

  private async handleTrading(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0] || "limits";

    if (sub === "limits" || sub === "risk") {
      const lim = this.riskEngine.getLimits();
      console.log(`Unified Trading Pre-Trade Risk Guardrails:`);
      console.log(`  - Max Single Order:    \$${lim.maxSingleOrderUsd.toLocaleString()} USD`);
      console.log(`  - Max Position Size:   \$${lim.maxPositionNotionalUsd.toLocaleString()} USD`);
      console.log(`  - Daily Turnover Cap:  \$${lim.dailyTurnoverCapUsd.toLocaleString()} USD`);
      console.log(`  - Max Leverage Cap:    ${lim.maxLeverage}x`);
      console.log(`  - Fat-Finger Filter:   ${lim.maxFatFingerPct}% max deviation from mid`);
      console.log(`  - Protocol Min Size:   \$${lim.minOrderNotionalUsd} USD`);
      return;
    }

    if (sub === "kill-switch") {
      console.log(`[!] INITIATING EMERGENCY TRADING KILL SWITCH...`);
      // --symbol scopes the blast radius (external audit M-05): the panic
      // hotkey says "--symbol BTC" — the CLI must honor it, not liquidate
      // the whole book.
      const scope = flags.symbol || flags["symbol"];
      const res = await this.perp.triggerKillSwitch(undefined, scope);
      console.log(`[✓] KILL SWITCH COMPLETE${res.scopedTo ? ` (SCOPED TO ${res.scopedTo})` : " (ACCOUNT-WIDE)"}:`);
      console.log(`    - Canceled Orders:   ${res.canceledOrders}`);
      console.log(`    - Closed Positions:  [${res.closedPositions.join(", ") || "None"}]`);
      return;
    }

    console.log("Usage: furlpay trading <limits|kill-switch>");
  }

  /**
   * `furlpay binance` — spot surface over BinanceAdapter. Credentials come
   * from the environment only (the adapter refuses without them); the env is
   * explicit (FURLPAY_BINANCE_ENV, testnet default) and never silently
   * swapped. When --wallet <agent> is passed, every order rides the same
   * atomic agent policy ledger as the MCP surface — validated BEFORE any
   * request is signed.
   */
  private async handleBinance(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];
    const envRaw = String(process.env.FURLPAY_BINANCE_ENV || "testnet").toLowerCase();
    const env = envRaw === "mainnet" ? "mainnet" : "testnet";
    if (envRaw !== "mainnet" && envRaw !== "testnet") {
      console.error(`[!] Unknown FURLPAY_BINANCE_ENV "${envRaw}" — using testnet (explicit values: testnet, mainnet).`);
    }

    // Durable audit blotter (M-02): Binance intents/outcomes land in the
    // same hash-chained ledger as the Hyperliquid path. Creation failure
    // degrades to an in-memory blotter (best-effort audit, never a blocker).
    const binanceBlotter = (() => {
      try {
        return new DurableEventStore({ filePath: defaultBlotterPath() });
      } catch {
        return new DurableEventStore();
      }
    })();
    const adapter = new BinanceAdapter({ env, blotter: binanceBlotter });

    // Agent-trust gate: with a delegated policy, orders validate + record
    // spend through AgentKeyService before the adapter builds a request.
    // WITHOUT a delegated policy (external audit 2026-11-17b H-01) the old
    // gate silently auto-authorized — a live, uncapped market order from a
    // single command. Now: interactive humans confirm; non-interactive
    // callers must carry explicit --yes, or the order is refused.
    const walletName = flags.wallet || flags["wallet"];
    const requireUnmandatedConsent = async (what: string): Promise<void> => {
      if (walletName) return; // delegated policy authorizes below
      if (flags.yes === true || flags.y === true) {
        console.error(`[!] Unmandated ${what} executed with explicit --yes consent (no spend cap active).`);
        return;
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `UNMANDATED_EXECUTION_REFUSED: ${what} without --wallet <agent> would bypass every spend cap. ` +
            `Pass --yes to accept uncapped live execution explicitly, or create a delegated policy ` +
            `(\`furlpay wallet agent-keygen\`) and use --wallet <agent>.`
        );
      }
      // Interactive human: re-engage on the exact economics before money moves.
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => {
        rl.question(`Execute REAL-MONEY ${what}? Type "execute" to confirm: `, res);
      });
      rl.close();
      if (answer.trim().toLowerCase() !== "execute") {
        throw new Error(`Confirmation did not match — ${what} aborted.`);
      }
    };
    const mandateCheck = (intent: { symbol: string; side: string; notionalUsd: number }) => {
      if (!walletName) return { authorized: true };
      const gate = this.agentKeys.validateAndRecordSpend(walletName, intent.notionalUsd, "USDC");
      return gate.allowed
        ? { authorized: true as const }
        : { authorized: false as const, reason: gate.reason };
    };

    if (sub === "balances") {
      const balances = await adapter.balances();
      console.log(`Binance Spot (${env}) balances:`);
      for (const b of balances) {
        console.log(`  ${b.asset.padEnd(10)} free: ${b.free.padEnd(18)} locked: ${b.locked}`);
      }
      return;
    }

    if (sub === "ticker") {
      const symbol = args[1] || flags.symbol;
      if (!symbol) {
        console.log("Usage: furlpay binance ticker <SYMBOL>");
        return;
      }
      const t = await adapter.ticker(symbol);
      console.log(`${String(t.symbol).toUpperCase()} (${env}):`);
      console.log(`  Last: \$${t.lastPrice}  24h change: ${t.priceChangePercent}%  24h volume: ${t.quoteVolume}`);
      return;
    }

    if (sub === "spot") {
      const action = args[1];
      const symbol = args[2] || flags.symbol;
      if ((action !== "buy" && action !== "sell") || !symbol) {
        console.log("Usage: furlpay binance spot <buy|sell> <SYMBOL> [--quote <usd> | --qty <quantity>]");
        return;
      }
      if (action === "buy") {
        const quote = flags.quote !== undefined ? Number(flags.quote) : NaN;
        if (!Number.isFinite(quote) || quote <= 0) {
          throw new Error("Market buys require --quote <usd> (a positive quote amount).");
        }
        await requireUnmandatedConsent(`market BUY ${symbol.toUpperCase()} for $${quote} on Binance (${env})`);
        const res = await adapter.marketOrder(
          { symbol, side: "BUY", notionalUsd: quote, agentAddress: walletName || "cli" },
          mandateCheck
        );
        console.log(`[✓] Market BUY ${symbol.toUpperCase()} — ${res.status} (orderId ${res.orderId}, ${env})`);
        return;
      }
      const qty = flags.qty !== undefined ? String(flags.qty) : undefined;
      if (!qty) {
        throw new Error("Market sells require --qty <quantity> (an exact base quantity; never derived from a float price).");
      }
      await requireUnmandatedConsent(`market SELL ${symbol.toUpperCase()} x${qty} on Binance (${env})`);
      const res = await adapter.marketSell(symbol, qty, mandateCheck);
      console.log(`[✓] Market SELL ${symbol.toUpperCase()} — ${res.status} (orderId ${res.orderId}, ${env})`);
      return;
    }

    if (sub === "open-orders") {
      const orders = await adapter.openOrders(flags.symbol);
      console.log(`Binance ${env} open orders (${orders.length}):`);
      for (const o of orders) {
        console.log(`  #${o.orderId} ${o.symbol} ${o.side} ${o.origQty} @ ${o.price || "MARKET"} (${o.status})`);
      }
      return;
    }

    if (sub === "cancel") {
      const orderId = parseInt(flags["order-id"] || args[1] || "0");
      const symbol = flags.symbol || args[2];
      if (!orderId || !symbol) {
        console.log("Usage: furlpay binance cancel <orderId> --symbol <SYMBOL>");
        return;
      }
      await adapter.cancelOrder(symbol, orderId);
      console.log(`[✓] Canceled order #${orderId} for ${symbol.toUpperCase()} (${env}).`);
      return;
    }

    console.log("Usage: furlpay binance <balances|ticker|spot|open-orders|cancel> [options]");
    console.log("  Credentials: BINANCE_API_KEY / BINANCE_API_SECRET env vars (never argv).");
    console.log("  Network: FURLPAY_BINANCE_ENV=testnet|mainnet (default testnet).");
  }

  private async handleEscrow(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0] || "status";
    const store = new EscrowStore();
    const clean = (v: unknown): string => sanitizeTerminal(v) || "—";

    if (sub === "create") {
      const escrowId = `escrow_${crypto.randomBytes(6).toString("hex")}`;
      const buyer = flags.buyer || "0x1111111111111111111111111111111111111111";
      const seller = flags.seller || "0x2222222222222222222222222222222222222222";
      const amount = flags.amount || "1000.00";
      const token = flags.token || "USDC";

      if (!(parseFloat(amount) > 0)) {
        throw new Error("Escrow amount must be a positive number.");
      }

      // The delivery proof commitment is the SHA-256 hash of the agreed
      // deliverable. Honor --proof-hash if the parties pre-agreed on one;
      // otherwise generate a random commitment and say so.
      const proofHash: string | undefined = flags["proof-hash"] || flags.proofHash;
      if (proofHash && !/^0x[0-9a-fA-F]{64}$/.test(proofHash)) {
        throw new Error("Invalid --proof-hash: must be a 0x-prefixed 32-byte hex SHA-256 hash.");
      }
      const deliverySpecHash = proofHash || "0x" + crypto.randomBytes(32).toString("hex");

      const timeoutDays = flags["timeout-days"] || flags.timeoutDays
        ? parseFloat(flags["timeout-days"] || flags.timeoutDays)
        : 1;
      if (!(timeoutDays > 0) || !isFinite(timeoutDays)) {
        throw new Error("Invalid --timeout-days: must be a positive number.");
      }

      const arbiter = flags.arbiter ? String(flags.arbiter) : undefined;
      const terms: EscrowTerms = {
        escrowId,
        buyer,
        seller,
        arbiter,
        amount,
        token,
        network: flags.network || "arbitrum",
        expiryTimestamp: Math.floor(Date.now() / 1000) + Math.round(timeoutDays * 86400),
        autoReleaseSeconds: 3600,
        deliverySpecHash,
      };

      const sm = new EscrowStateMachine(terms);
      store.save(sm);
      console.log(`[+] Escrow Agreement Created!`);
      console.log(`    - Escrow ID:  ${clean(terms.escrowId)}`);
      console.log(`    - Buyer:      ${clean(terms.buyer)}`);
      console.log(`    - Seller:     ${clean(terms.seller)}`);
      if (terms.arbiter) console.log(`    - Arbiter:    ${clean(terms.arbiter)}`);
      console.log(`    - Amount:     ${clean(terms.amount)} ${clean(terms.token)}`);
      console.log(`    - Network:    ${clean(terms.network)}`);
      console.log(`    - Timeout:    ${timeoutDays} days (${new Date(terms.expiryTimestamp * 1000).toISOString()})`);
      console.log(`    - Proof Hash: ${clean(terms.deliverySpecHash)}${proofHash ? "" : " (random commitment — pass --proof-hash to pin one)"}`);
      console.log(`    - State:      ${sm.getState()}`);
      console.log(`    - Persisted:  ${clean(store.path)}`);
      console.log(`[i] Local escrow ledger (simulation) — no on-chain escrow contract was deployed.`);
      return;
    }

    if (sub === "fund") {
      const sm = store.loadMachine(flags["escrow-id"] || flags.escrowId || args[0]);
      const txHash = flags["tx-hash"] || flags.txHash;
      if (!txHash) {
        throw new Error("Funding requires a real on-chain deposit. Pass --tx-hash <hash> referencing your funding transaction; this CLI will not fabricate one.");
      }
      // The local operator is the buyer of record (the party that locks collateral).
      sm.fund(sm.getTerms().buyer, String(txHash));
      store.save(sm);
      console.log(`[✓] Escrow FUNDED (local ledger):`);
      console.log(`    - Escrow ID:  ${clean(sm.getEscrowId())}`);
      console.log(`    - Funding Tx: ${clean(String(txHash))}`);
      console.log(`    - Amount:     ${clean(sm.getTerms().amount)} ${clean(sm.getTerms().token)}`);
      console.log(`    - State:      ${sm.getState()}`);
      return;
    }

    if (sub === "proof" || sub === "submit-proof") {
      const sm = store.loadMachine(flags["escrow-id"] || flags.escrowId || args[0]);
      const proofHash = flags.hash || flags["proof-hash"] || flags.proofHash;
      if (!proofHash || !/^0x[0-9a-fA-F]{64}$/.test(String(proofHash))) {
        throw new Error("Invalid proof hash: pass --hash <0x-prefixed 32-byte hex SHA-256 of the delivered artifact>.");
      }
      const signature = flags.signature ? String(flags.signature) : undefined;
      if (!signature) {
        throw new Error(
          "Delivery proof requires --signature: the seller's EVM signature over the canonical " +
            `message furlpay-escrow-proof:${sm.getEscrowId()}:${String(proofHash).toLowerCase()} ` +
            "(e.g. an ethers Wallet.signMessage output). Unattested proofs are refused — the " +
            "CLI no longer records a local simulation string in place of a cryptographic " +
            "seller signature."
        );
      }
      // The local operator acts as the seller of record when submitting delivery proof.
      sm.submitProof(sm.getTerms().seller, {
        proofHash: String(proofHash),
        signature,
        deliverableUri: flags.uri ? String(flags.uri) : undefined,
        submittedAt: Math.floor(Date.now() / 1000),
      });
      store.save(sm);
      console.log(`[✓] Delivery Proof Submitted (local ledger):`);
      console.log(`    - Escrow ID:  ${clean(sm.getEscrowId())}`);
      console.log(`    - Proof Hash: ${clean(proofHash)}`);
      console.log(`    - State:      ${sm.getState()}`);
      const terms = sm.getTerms();
      console.log(`    - Auto-release in ${terms.autoReleaseSeconds}s unless the buyer intervenes.`);
      return;
    }

    if (sub === "release") {
      const sm = store.loadMachine(flags["escrow-id"] || flags.escrowId || args[0]);
      const txHash = flags["tx-hash"] || flags.txHash;
      if (!txHash) {
        throw new Error("Releasing escrow funds requires a real settlement transaction. Pass --tx-hash <hash>; this CLI will not fabricate one.");
      }
      // The local operator is the buyer of record (or auto-release timer applies).
      sm.release(sm.getTerms().buyer, String(txHash));
      store.save(sm);
      console.log(`[✓] Escrow RELEASED to seller (local ledger):`);
      console.log(`    - Escrow ID:    ${clean(sm.getEscrowId())}`);
      console.log(`    - Settlement Tx: ${clean(String(txHash))}`);
      console.log(`    - State:        ${sm.getState()}`);
      return;
    }

    if (sub === "dispute") {
      const sm = store.loadMachine(flags["escrow-id"] || flags.escrowId || args[0]);
      const reason = flags.reason || flags.r;
      if (!reason) {
        throw new Error("A dispute requires a reason. Pass --reason <message>.");
      }
      const safeReason = sanitizeTerminal(reason).slice(0, 500);
      // The local operator is a counterparty of record.
      sm.dispute(sm.getTerms().buyer, safeReason);
      store.save(sm);
      console.log(`[!] Escrow DISPUTED (local ledger):`);
      console.log(`    - Escrow ID:  ${clean(sm.getEscrowId())}`);
      console.log(`    - Reason:     ${clean(safeReason)}`);
      console.log(`    - State:      ${sm.getState()}`);
      console.log(`[i] Await arbiter resolution (furlpay escrow release after arbitration, or refund).`);
      return;
    }

    if (sub === "status" || sub === "list") {
      const escrows = store.list();
      if (!escrows.length) {
        console.log(`No escrows found in the local ledger (${clean(store.path)}).`);
        console.log(`Create one with: furlpay escrow create --amount 1000 --seller <address>`);
        return;
      }
      const targetId = flags["escrow-id"] || flags.escrowId;
      const shown = targetId
        ? escrows.filter((s) => s.terms.escrowId === String(targetId))
        : escrows;
      if (targetId && !shown.length) {
        throw new Error(`Escrow '${sanitizeTerminal(targetId)}' not found in the local ledger.`);
      }
      console.log(`Escrow Ledger (${shown.length}) — local store, not on-chain:`);
      for (const snap of shown) {
        console.log(`  ${clean(snap.terms.escrowId)} | ${snap.state} | ${clean(snap.terms.amount)} ${clean(snap.terms.token)} | expires ${new Date(snap.terms.expiryTimestamp * 1000).toISOString()}`);
        if (flags.verbose || flags.v) {
          for (const rec of snap.auditLog) {
            console.log(`      ${new Date(rec.timestamp * 1000).toISOString()} ${rec.fromState} -> ${rec.toState} (${clean(rec.actor)})${rec.reason ? `: ${clean(rec.reason)}` : ""}`);
          }
        }
      }
      return;
    }

    console.log("Usage: furlpay escrow <create|fund|proof|release|dispute|status> [options]");
    console.log("  create  --amount <usd> --seller <addr> [--buyer <addr>] [--arbiter <addr>] [--timeout-days 7] [--proof-hash 0x...]");
    console.log("  fund    --escrow-id <id> --tx-hash <funding tx>          (requires a real deposit transaction)");
    console.log("  proof   --escrow-id <id> --hash 0x<sha256> [--signature <sig>] [--uri <deliverable>]");
    console.log("  release --escrow-id <id> --tx-hash <settlement tx>       (requires a real settlement transaction)");
    console.log("  dispute --escrow-id <id> --reason <message>");
    console.log("  status  [--escrow-id <id>] [--verbose]");
  }

  private async handleEarn(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];

    if (sub === "hlp" || args[0] === "hlp" || !sub) {
      const action = args[0] === "hlp" ? args[1] : args[0];
      const fmtMoney = (v: number | null): string =>
        v === null ? "unavailable (live vault data did not include it)" : `$${v.toLocaleString("en-US")} USDC`;

      if (action === "deposit") {
        const amt = flags.amount ? parseFloat(flags.amount) : parseFloat(args[2] || "500");
        const res = await this.hlp.deposit(amt);
        console.log(`[✓] HLP Deposit Confirmed!`);
        console.log(`    - Deposited:     \$${res.amountDepositedUsd.toFixed(2)} USDC`);
        console.log(`    - Shares:        ${res.sharesMinted === null ? "n/a (determined by the exchange at settlement)" : `${res.sharesMinted} HLP`}`);
        console.log(`    - Effective NAV: ${res.effectiveSharePrice === null ? "n/a (live share price not published)" : `\$${res.effectiveSharePrice.toFixed(4)} USD`}`);
        console.log(`    - Trailing APY:  ${res.currentApyPct === null ? "unavailable" : `${res.currentApyPct}% Real APR`}`);
        console.log(`    - Lockup Expiry: ${res.lockupExpiry} (4-day withdrawal hold)`);
        console.log(`    - Tx Hash:       ${sanitizeTerminal(res.txHash)}`);
        return;
      }

      if (action === "withdraw") {
        const amt = flags.amount ? parseFloat(flags.amount) : parseFloat(args[2] || "0");
        if (!(amt > 0)) {
          throw new Error("HLP withdrawal requires a positive amount: furlpay earn hlp withdraw --amount <usd>");
        }
        const res = await this.hlp.withdraw(amt);
        console.log(`[✓] HLP Withdrawal Submitted!`);
        console.log(`    - Requested:     \$${res.usdReceived.toFixed(2)} USDC`);
        console.log(`    - Tx Hash:       ${sanitizeTerminal(res.txHash)}`);
        console.log(`[i] Hyperliquid enforces a mandatory 4-day withdrawal lockup on HLP capital.`);
        return;
      }

      const stats = await this.hlp.getHlpStats();
      console.log(`Hyperliquid Liquidity Provider (HLP) Clearinghouse Vault:`);
      console.log(`  - Vault Address: ${stats.vaultAddress}`);
      console.log(`  - Total Equity:  ${fmtMoney(stats.totalEquityUsd)}`);
      console.log(`  - Share Price:   ${stats.sharePriceUsd === null ? "unavailable (live share price not published)" : `\$${stats.sharePriceUsd.toFixed(4)} USD`}`);
      console.log(`  - Trailing APY:  ${stats.trailing30dApyPct === null ? "unavailable" : `${stats.trailing30dApyPct}% Real APR`}`);
      console.log(`  - All-Time PnL:  ${stats.allTimePnlUsd === null ? "unavailable" : `+\$${(stats.allTimePnlUsd / 1_000_000).toFixed(1)}M USD`}`);
      console.log(`  - Lockup Period: 4 days (345,600s mandatory deposit cooldown)`);
      console.log(`  - Deposits:      ${stats.rawVault && stats.rawVault.allowDeposits ? "OPEN" : "UNKNOWN/PAUSED"}`);
      return;
    }

    console.log("Usage: furlpay earn hlp [deposit|withdraw|stats] [--amount <usd>]");
  }

  private async handleOrder(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];
    const dummyKeypair = Keypair.random();
    const signer = new KeypairSigner(dummyKeypair);

    if (sub === "list") {
      const pair = flags.pair;
      const list = await this.orders.listOrders("dummy_account", pair);
      console.log(`Active SDEX resting limit orders (${list.length}):`);
      for (const ord of list) {
        console.log(`  #${ord.id} | Selling ${ord.amount} ${ord.selling.code} for ${ord.buying.code} @ \$${ord.price}`);
      }
      return;
    }

    if (sub === "inspect") {
      const offerId = flags["offer-id"] || args[0] || "8829104";
      const ord = await this.orders.inspectOrder(offerId);
      if (!ord) {
        console.log(`Order #${offerId} not found.`);
        return;
      }
      console.log(`Order #${ord.id}:`);
      console.log(`  Selling: ${ord.amount} ${ord.selling.code}`);
      console.log(`  Buying:  ${ord.buying.code}`);
      console.log(`  Price:   ${ord.price}`);
      console.log(`  Ledger:  #${ord.lastModifiedLedger}`);
      return;
    }

    if (sub === "cancel") {
      const offerId = flags["offer-id"] || args[0] || "8829104";
      const res = await this.orders.cancelOrder(signer, offerId, flags.sponsor !== false);
      console.log(`[!] SIMULATED — no Manage Offer cancellation was broadcast to Stellar.`);
      console.log(`[i] Order #${res.offerId} marked canceled locally. (sim hash: ${res.txHash.slice(0, 14)}…)`);
      return;
    }

    if (sub === "cancel-all") {
      const pair = flags.pair;
      const res = await this.orders.cancelAllOrders(signer, pair);
      console.log(`[!] SIMULATED — no cancellations were broadcast to Stellar.`);
      console.log(`[i] ${res.canceledCount} resting order(s) marked canceled locally.`);
      return;
    }

    console.log("Usage: furlpay order <list|inspect|cancel|cancel-all> [options]");
  }

  private async handleRwa(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];

    if (sub === "list" || !sub) {
      const category = flags.category || "all";
      const list = this.rwa.list(category);
      console.log(`Institutional Tokenized Stocks & RWAs (${list.length}) — UNVERIFIED REFERENCE DATA:`);
      console.log(`  issuer addresses and regimes are catalog entries, not on-chain-verified facts.`);
      for (const a of list) {
        const sep8Tag = a.requiresSep8 ? "[SEP-8 issuer auth required]" : "[PERMISSIONLESS]";
        console.log(`  ${a.code.padEnd(8)} ${a.name.padEnd(35)} ${sep8Tag.padEnd(30)} ${a.regime}`);
      }
      return;
    }

    if (sub === "inspect") {
      const assetCode = flags.asset || args[0] || "JQQQ";
      const asset = this.rwa.inspect(assetCode);
      if (!asset) {
        console.log(`Asset '${assetCode}' not found in institutional registry.`);
        return;
      }
      console.log(`Asset Specification: ${asset.code}  (UNVERIFIED REFERENCE DATA)`);
      console.log(`  Name:             ${asset.name}`);
      console.log(`  Issuer:           ${asset.issuer}`);
      console.log(`  Category:         ${asset.category}`);
      console.log(`  Regime:           ${asset.regime}`);
      console.log(`  SEC CIK:          ${asset.cik || "N/A (verify on SEC EDGAR)"}`);
      console.log(`  Approval Server:  not bundled — resolve from the issuer's signed stellar.toml`);
      console.log(`  Description:      ${asset.description}`);
      return;
    }

    if (sub === "kyc") {
      const assetCode = flags.asset || args[0] || "JQQQ";
      // No KYC provider is integrated; the old output here fabricated an
      // "Accredited Tier 1 verified / Pre-Approval Granted" result with no
      // verification performed. Refuse honestly instead.
      const flow = this.rwa.startKycFlow(assetCode, Boolean(flags.interactive));
      console.log(`[!] ${flow.instructions}`);
      console.log(`[i] Status: NOT_IMPLEMENTED — nothing was verified and no approval exists.`);
      process.exitCode = 1;
      return;
    }

    console.log("Usage: furlpay rwa <list|inspect|kyc> [options]");
  }

  private async handleX402(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];

    if (sub === "pay") {
      const header = flags["challenge-header"] || 'WWW-Authenticate: x402 recipient="GBLX99API", amount="0.0005", token="USDC"';
      const maxCost = flags["max-cost"] ? parseFloat(flags["max-cost"]) : undefined;

      const challenge = this.x402.parseChallenge(header);
      const res = await this.x402.settleChallenge(challenge, undefined, maxCost);

      console.log(`[✓] HTTP 402 Micropayment Settled!`);
      console.log(`    - Tx ID:        ${res.txId}`);
      console.log(`    - Recipient:    ${res.recipient}`);
      console.log(`    - Amount:       ${res.amount} USDC`);
      console.log(`    - Settlement:   ${res.settlementType} (<$0.0001 cost)`);
      console.log(`    - Auth Header:  ${res.authorizationHeader}`);
      return;
    }

    console.log("Usage: furlpay x402 pay --challenge-header <header> [--max-cost <cost>]");
  }

  private async handleMcp(args: string[], flags: Record<string, any>): Promise<void> {
    const wallet = flags.wallet || "default-agent";
    // P7 DEFAULTS: read-only unless execution is EXPLICITLY enabled — and
    // execution mode additionally requires an already-configured agent
    // policy for the named wallet. A fresh install cannot move funds.
    const wantsExecution =
      flags["enable-execution"] === true || flags.mode === "execution" || flags["allow-execution"] === true;
    const server = new McpStdioServer(wallet, { mode: wantsExecution ? "execution" : "read-only" });
    if (wantsExecution) {
      if (!server.hasAgentPolicy()) {
        console.error(`[!] Execution mode refused: no agent policy named "${wallet}" is configured.`);
        console.error(`    Create one first: furlpay wallet agent-keygen --name ${wallet}`);
        console.error(`    A policy file is the spend-cap authority for execution mode — no policy, no execution.`);
        process.exitCode = 47;
        return;
      }
    }
    server.startStdio();
  }

  private async handleTerminal(
    subcommand: string | undefined,
    args: string[],
    flags: Record<string, any>,
    isQuantCmd: boolean = false
  ): Promise<void> {
    const isQuant =
      isQuantCmd ||
      Boolean(flags.quant) ||
      Boolean(flags.workstation) ||
      subcommand === "quant" ||
      subcommand === "workstation";
    const headless = Boolean(flags.headless);

    if (isQuant) {
      const workstation = new InstitutionalWorkstation({ headless });
      if (headless) {
        workstation.flush();
      } else {
        workstation.start();
      }
      return;
    }

    const market = flags.market || subcommand || args[0] || "HYPE";
    const mode = (flags.mode as TerminalScreen) || "dashboard";
    const terminal = new FurlPayInteractiveTerminal({
      initialMarket: market,
      initialMode: mode,
      headless,
    });
    if (headless) {
      console.log(terminal.renderFrame());
    } else {
      terminal.start();
    }
  }

  private async handleChains(args: string[], flags: Record<string, any>): Promise<void> {
    const discovery = new MarketDiscoveryService();
    const chains = await discovery.listChains();
    console.log("┌────────────────────────────────────────────────────────────────────────┐");
    console.log("│ FURLPAY MULTI-CHAIN REGISTRY                                           │");
    console.log("├────────────────────────────────────────────────────────────────────────┤");
    console.log("│ Chain ID         Name                  Type          Native   Status   │");
    console.log("│ ────────────────────────────────────────────────────────────────────── │");
    for (const c of chains) {
      console.log(`│ ${c.id.padEnd(16)} ${c.name.padEnd(21)} ${c.type.padEnd(13)} ${c.nativeToken.padEnd(8)} ${c.status.toUpperCase().padEnd(8)} │`);
    }
    console.log("└────────────────────────────────────────────────────────────────────────┘");
  }

  private async handleExchanges(args: string[], flags: Record<string, any>): Promise<void> {
    const discovery = new MarketDiscoveryService();
    const venues = await discovery.listExchanges();
    console.log("┌────────────────────────────────────────────────────────────────────────┐");
    console.log("│ FURLPAY CONNECTED VENUES & LIQUIDITY ADAPTERS                          │");
    console.log("├────────────────────────────────────────────────────────────────────────┤");
    console.log("│ Venue ID          Chain           Type          Maker/Taker   Status   │");
    console.log("│ ────────────────────────────────────────────────────────────────────── │");
    for (const v of venues) {
      const fees = `${v.makerFeeBps}/${v.takerFeeBps} bps`;
      console.log(`│ ${v.name.padEnd(17)} ${v.chain.padEnd(15)} ${v.type.padEnd(13)} ${fees.padEnd(13)} ${v.connectionStatus.toUpperCase().padEnd(8)} │`);
    }
    console.log("└────────────────────────────────────────────────────────────────────────┘");
  }

  private async handleMarkets(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const discovery = new MarketDiscoveryService();
    const isSearch = subcommand === "search" || args[0] === "search";
    const query = isSearch ? (args[0] === "search" ? args[1] : args[0]) : flags.search;

    if (query) {
      const isAllChains = Boolean(flags["all-chains"]);
      console.log(`[+] Searching markets matching '${query}' across ${isAllChains ? "ALL connected chains" : "primary venues"}...`);
      const results = isAllChains 
        ? await discovery.searchAssetAcrossAllChains(query)
        : await discovery.getMarkets({ query });

      console.log("┌────────────────────────────────────────────────────────────────────────┐");
      console.log(`│ SEARCH RESULTS: '${query.toUpperCase()}' (${results.length} markets discovered)`.padEnd(73) + "│");
      console.log("├────────────────────────────────────────────────────────────────────────┤");
      console.log("│ Symbol         Chain          Exchange        Last Px     Spread (bps) │");
      console.log("│ ────────────────────────────────────────────────────────────────────── │");
      for (const m of results) {
        const pxStr = m.lastPrice !== undefined ? `\$${m.lastPrice.toFixed(2)}` : "---";
        const spStr = m.spreadBps !== undefined ? m.spreadBps.toFixed(1) : "---";
        console.log(`│ ${m.symbol.padEnd(14)} ${m.chain.padEnd(14)} ${m.exchange.padEnd(15)} ${pxStr.padEnd(11)} ${spStr.padEnd(12)} │`);
      }
      console.log("└────────────────────────────────────────────────────────────────────────┘");
      return;
    }

    const allMarkets = await discovery.getMarkets();
    console.log("┌────────────────────────────────────────────────────────────────────────┐");
    console.log(`│ FURLPAY DISCOVERABLE MARKETS (${allMarkets.length} instruments active)`.padEnd(73) + "│");
    console.log("├────────────────────────────────────────────────────────────────────────┤");
    console.log("│ Symbol         Chain          Venue           Type           Last Price│");
    console.log("│ ────────────────────────────────────────────────────────────────────── │");
    for (const m of allMarkets) {
      const pxStr = m.lastPrice !== undefined ? `\$${m.lastPrice.toFixed(2)}` : "---";
      console.log(`│ ${m.symbol.padEnd(14)} ${m.chain.padEnd(14)} ${m.exchange.padEnd(15)} ${m.marketType.padEnd(14)} ${pxStr} │`);
    }
    console.log("└────────────────────────────────────────────────────────────────────────┘");
  }

  private async handlePortfolio(args: string[], flags: Record<string, any>): Promise<void> {
    // A portfolio view must never invent balances. Cross-chain aggregation
    // is not implemented in this build; the authenticated API suite has the
    // real thing. (This previously rendered a hardcoded $32,450.80 sample
    // table indistinguishable from live data — removed.)
    console.log(`[!] Cross-chain portfolio aggregation is not implemented in this build.`);
    console.log(`[i] No balances were queried and nothing below is real data.`);
    console.log(`[i] For live balances run: furlpay balance            (authenticated API, all chains)`);
    console.log(`    Hyperliquid clearinghouse: furlpay account balance  (live /info)`);
    console.log(`    Stellar market data:       furlpay market <SYM>     (live)`);
    process.exitCode = 1;
  }

  /**
   * `furlpay tx verify <hash>` — real Horizon lookup with honest semantics.
   * Exit codes: 0 confirmed-success; 1 for confirmed-failed (the transaction
   * is real but failed on-chain), not-found, invalid hash, and lookup
   * unavailable. JSON via --output json.
   */
  private async handleTx(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const positional = [subcommand, ...args].filter(
      (a) => a !== undefined && a !== "verify" && a !== "tx"
    );
    const isVerify = subcommand === "verify" || args[0] === "verify";

    if (!isVerify) {
      console.log("Usage: furlpay tx verify <hash> [--network mainnet|testnet] [--output json]");
      console.log("  Performs a real Horizon GET /transactions/{hash} lookup and reports");
      console.log("  exactly what was verified — an API lookup of finalized ledger history,");
      console.log("  not an independent cryptographic re-verification.");
      console.log("  (furlpay tx <hash> without 'verify' uses the FurlPay app-server lookup.)");
      process.exitCode = 1;
      return;
    }

    const hash = positional[0] ?? "";
    const network = String(flags.network || "mainnet").toLowerCase() === "testnet" ? "testnet" : "mainnet";
    const json = flags.output === "json" || flags.json;

    const result: TxVerificationResult = await verifyTransaction(hash, { network });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const label: Record<string, string> = {
        CONFIRMED_SUCCESS: "CONFIRMED (successful)",
        CONFIRMED_FAILED: "CONFIRMED (failed on-chain)",
        NOT_FOUND: "NOT FOUND",
        INVALID_HASH: "INVALID HASH",
        UNAVAILABLE: "LOOKUP UNAVAILABLE",
      };
      console.log(`Transaction: ${result.hash || "(none given)"}`);
      console.log(`Network:     ${result.network}  (Horizon: ${result.horizonUrl})`);
      console.log(`Status:      ${label[result.status] ?? result.status}`);
      if (result.found) {
        console.log(`  Successful:    ${result.found.successful}`);
        console.log(`  Ledger:        ${result.found.ledger ?? "?"}`);
        console.log(`  Created at:    ${result.found.createdAt ?? "?"}`);
        console.log(`  Source:        ${result.found.sourceAccount ?? "?"}`);
        console.log(`  Operations:    ${result.found.operationCount ?? "?"}`);
        console.log(`  Fee (stroops): ${result.found.feePaidStroops ?? "?"}`);
        console.log(`  Result XDR:    ${result.found.resultXdr ?? "?"}`);
      }
      if (result.error) console.log(`  Error:         ${result.error}`);
      console.log(`\nWhat was verified:    ${result.whatWasVerified}`);
      console.log(`What was NOT verified: ${result.whatWasNotVerified}`);
    }

    process.exitCode = result.status === "CONFIRMED_SUCCESS" ? 0 : 1;
  }

  /**
   * `furlpay faucet --address <G...> --network testnet|futurenet` — real
   * Friendbot funding. Mainnet is refused (no faucet exists there); funding
   * is only reported on an actual successful Friendbot response.
   */
  private async handleFaucet(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const address = flags.address || flags.addr || subcommand || args[0];
    const networkRaw = String(flags.network || "testnet").toLowerCase();
    const json = flags.output === "json" || flags.json;

    if (!address) {
      console.log("Usage: furlpay faucet --address <G...> [--network testnet|futurenet] [--output json]");
      console.log("  Funds a testnet/futurenet account via the official Stellar Friendbot.");
      console.log("  Mainnet is refused: real XLM cannot be fabricated.");
      process.exitCode = 1;
      return;
    }

    if (networkRaw === "mainnet") {
      const msg = "Refused: the Stellar mainnet has no faucet. Friendbot only exists on testnet and futurenet — real XLM cannot be fabricated.";
      if (json) console.log(JSON.stringify({ address, network: networkRaw, funded: false, error: msg }, null, 2));
      else console.error(`[!] ${msg}`);
      process.exitCode = 1;
      return;
    }

    if (networkRaw !== "testnet" && networkRaw !== "futurenet") {
      const msg = `Unknown network "${networkRaw}". Supported: testnet, futurenet.`;
      if (json) console.log(JSON.stringify({ address, network: networkRaw, funded: false, error: msg }, null, 2));
      else console.error(`[!] ${msg}`);
      process.exitCode = 1;
      return;
    }

    if (!isValidStellarAddress(String(address))) {
      const msg = "Invalid Stellar address — pass a valid G... public key (validated locally before any network request).";
      if (json) console.log(JSON.stringify({ address: String(address), network: networkRaw, funded: false, error: msg }, null, 2));
      else console.error(`[!] ${msg}`);
      process.exitCode = 1;
      return;
    }

    const result: FaucetResult = await requestFunds(String(address), { network: networkRaw as FaucetNetwork });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Faucet:    ${result.friendbotUrl}`);
      console.log(`Account:   ${result.address}`);
      console.log(`Network:   ${result.network}`);
      if (result.funded) {
        console.log(`Result:    FUNDED — Friendbot reported a successful funding transaction`);
        if (result.transactionHash) console.log(`  Tx hash:  ${result.transactionHash}`);
        if (result.ledger !== null) console.log(`  Ledger:   ${result.ledger}`);
        if (result.balanceVerified === true) console.log(`  Balance:  verified > 0 via Horizon account lookup`);
        else if (result.balanceVerified === false) console.log(`  Balance:  Horizon shows no native balance yet (history lag) — funding response was still successful`);
        else console.log(`  Balance:  verification unavailable (Horizon lookup did not complete)`);
        if (result.transactionHash) console.log(`  Verify:   furlpay tx verify ${result.transactionHash} --network ${result.network}`);
      } else {
        console.log(`Result:    NOT FUNDED — ${result.error}`);
      }
    }

    process.exitCode = result.funded ? 0 : 1;
  }

  private async handleConfig(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const sub = subcommand || args[0];
    const cfg = loadConfig();

    if (sub === "validate") {
      const json = flags.output === "json" || flags.json;
      const { valid, checks } = validateConfig(cfg);

      if (json) {
        console.log(JSON.stringify({ configPath: getConfigPath(), valid, checks }, null, 2));
      } else {
        console.log(`Validating configuration at ${getConfigPath()}\n`);
        for (const c of checks) {
          const mark = c.ok ? "[✓]" : c.severity === "error" ? "[✗]" : "[!]";
          console.log(`  ${mark} ${c.name.padEnd(42)} ${c.detail}`);
        }
        const failed = checks.filter((c) => !c.ok && c.severity === "error");
        console.log(
          valid
            ? `\nConfiguration is valid${checks.some((c) => !c.ok) ? " (warnings present)" : ""}.`
            : `\nConfiguration is INVALID — ${failed.length} error(s). Fix them before relying on network or risk settings.`
        );
      }
      process.exitCode = valid ? 0 : 1;
      return;
    }

    if (sub === "path") {
      console.log(getConfigPath());
      return;
    }

    if (sub === "show" || !sub) {
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }

    if (sub === "get") {
      const key = args[0] || args[1];
      console.log((cfg as any)[key] || "Key not found");
      return;
    }

    if (sub === "set") {
      const key = args[0] || args[1];
      const val = args[1] || args[2];
      (cfg as any)[key] = val;
      saveConfig(cfg);
      console.log(`[+] Configuration updated: ${key} = ${val}`);
      return;
    }

    console.log("Usage: furlpay config <show|path|get|set|validate>");
  }

  // ── Financial Operations Layer ─────────────────────────────────────────────
  //
  // `furlpay finance` is the local financial operations surface: a durable
  // double-entry ledger, idempotent payment records, fail-closed spend
  // limits, human-approved payment authorization, treasury views, billing
  // reports and signed financial events. Settlement capability is honest —
  // see `finance status`; nothing here claims an on-chain adapter it does
  // not have, and submission is never settlement.
  private async handleFinance(subcommand: string | undefined, args: string[], flags: Record<string, any>): Promise<void> {
    const { FinanceManager } = await import("./finance/manager");
    const { assertHumanApproval, HUMAN_APPROVAL_EXIT_CODE } = await import("./finance/humanGate");
    const money = await import("./finance/money");
    const fin = new FinanceManager({ webhookUrl: process.env.FURLPAY_FINANCE_WEBHOOK_URL?.trim() || undefined });
    const area = subcommand || args[0];
    const sub = subcommand ? args[0] : args[1];
    const rest = subcommand ? args.slice(1) : args.slice(2);

    const usageLine = () =>
      console.log(
        [
          "Usage: furlpay finance <area> <command> [flags]",
          "  init            --unit USDC [--network base]        create the standard account skeleton",
          "  status                                            accounts, limits, settlement capabilities",
          "  ledger          list|reconcile|export|inspect <id>",
          "  spend           show --unit USDC | set-limit <daily|weekly|monthly|total|per-transaction> <amount> --unit USDC | breakdown | history",
          "  approval        list | inspect <id> | approve <id> --amount --unit --destination [--network --fee] | deny <id> --reason",
          "  payment         create --amount 25 --unit USDC --destination <addr> [--network base --fee 0.01 --approval-id <id> --idempotency-key <k>]",
          "                  | inspect <id> | receipt <id> | history | cancel <id> --reason",
          "                  | confirm <id> --tx-hash <hash>      (attach real evidence)",
          "                  | settle <id>                        (only after confirm)",
          "  treasury        status | reconcile",
          "  billing         summary [--since ISO] | export [--out file.csv]",
          "  events          list | verify --seq <n>",
        ].join("\n")
      );

    switch (area) {
      case "init": {
        const unit = String(flags.unit ?? "USDC").toUpperCase();
        const network = flags.network ? String(flags.network).toLowerCase() : undefined;
        const ids = fin.ensureStandardAccounts(unit, network);
        console.log(`[+] Standard ${unit}${network ? ` (${network})` : ""} accounts ready:`);
        for (const [k, v] of Object.entries(ids)) console.log(`    ${k.padEnd(10)} ${v}`);
        return;
      }

      case "status": {
        const accounts = fin.ledger.listAccounts();
        console.log(`[i] Financial operations layer — ${accounts.length} account(s), ledger ${fin.ledger.filePathUsed}`);
        for (const a of accounts) {
          const b = fin.ledger.accountBalance(a.id);
          console.log(`    ${a.id.padEnd(34)} ${a.kind.padEnd(9)} ${a.unit.padEnd(5)} settled=${b.settledMinor} pending=${b.pendingMinor}`);
        }
        const caps = fin.payments.settlementCapabilities();
        console.log("[i] Settlement capabilities (honest):");
        for (const c of caps) console.log(`    ${c.network.padEnd(14)} ${c.mode.padEnd(10)} ${c.note}`);
        return;
      }

      case "ledger": {
        if (sub === "list" || !sub) {
          const txs = fin.ledger.listTransactions();
          if (!txs.length) {
            console.log("[i] Ledger is empty — `furlpay finance init` then `payment create`.");
            return;
          }
          for (const t of txs.slice(-20).reverse()) {
            console.log(`${t.id}  [${t.type}]  ${t.state}  seq=${t.seq}`);
            for (const e of t.entries) console.log(`    ${e.direction.padEnd(6)} ${String(e.minor).padStart(14)} ${e.unit}${e.network ? ":" + e.network : ""} → ${e.accountId}`);
          }
          return;
        }
        if (sub === "inspect") {
          const t = fin.ledger.getTransaction(rest[0] ?? "");
          if (!t) throw new Error(`Unknown ledger transaction ${rest[0]}`);
          console.log(JSON.stringify(t, null, 2));
          return;
        }
        if (sub === "reconcile") {
          const r = fin.ledger.reconcile();
          console.log(`[${r.chainValid ? "+" : "!"}] chain ${r.chainValid ? "valid" : "INVALID"} · ${r.balancedTransactions}/${r.checkedTransactions} balanced`);
          for (const d of r.discrepancies) console.log(`[!] ${d}`);
          if (!r.discrepancies.length) console.log("[i] Internally consistent. External on-chain reality is verified separately (tx verify / provider lookups) — never asserted here.");
          return;
        }
        if (sub === "export") {
          const csv = fin.billing.exportCsv();
          if (flags.out) {
            const fs = await import("fs");
            await fs.promises.writeFile(String(flags.out), csv, { mode: 0o600 });
            console.log(`[+] Exported to ${flags.out}`);
            return;
          }
          console.log(csv);
          return;
        }
        usageLine();
        return;
      }

      case "spend": {
        const unit = String(flags.unit ?? "USDC").toUpperCase();
        if (sub === "show" || !sub) {
          const u = fin.spend.usage(unit);
          const f = (v?: bigint) => (v === undefined ? "unlimited" : `${v} minor`);
          console.log(`[i] Spend usage (${unit}):`);
          console.log(`    today=${u.today}  week=${u.thisWeek}  month=${u.thisMonth}  total=${u.total}`);
          console.log(`    limits: per-tx=${f(u.limits.perTransactionMinor)} daily=${f(u.limits.dailyMinor)} weekly=${f(u.limits.weeklyMinor)} monthly=${f(u.limits.monthlyMinor)} total=${f(u.limits.totalMinor)}`);
          return;
        }
        if (sub === "set-limit") {
          const field = rest[0];
          const amount = rest[1];
          const allowed = ["daily", "weekly", "monthly", "total", "per-transaction"];
          if (!allowed.includes(field)) throw new Error(`Limit must be one of ${allowed.join(", ")}`);
          const minor = money.parseMinor(amount, money.tokenDecimals(unit));
          const key = ({ daily: "dailyMinor", weekly: "weeklyMinor", monthly: "monthlyMinor", total: "totalMinor", "per-transaction": "perTransactionMinor" } as const)[field as "daily"];
          fin.spend.setLimits({ [key]: minor } as never);
          console.log(`[+] ${field} spend limit for ${unit} set to ${minor} minor units.`);
          return;
        }
        if (sub === "breakdown") {
          const rows = fin.spend.breakdown();
          if (!rows.length) {
            console.log("[i] No spending recorded yet.");
            return;
          }
          for (const r of rows) console.log(`    ${r.unit.padEnd(6)} ${String(r.minor).padStart(14)} minor   ${r.transactions} tx(s)`);
          return;
        }
        if (sub === "history") {
          const rows = fin.spend.history(20);
          if (!rows.length) {
            console.log("[i] No spending recorded yet.");
            return;
          }
          for (const r of rows) console.log(`    ${r.at}  ${r.state.padEnd(10)} ${String(r.minor).padStart(12)} ${r.unit}  ${r.id}`);
          return;
        }
        usageLine();
        return;
      }

      case "approval": {
        if (sub === "list" || !sub) {
          const open = fin.approvals.list({ state: "open" });
          const all = open.length ? open : fin.approvals.list().slice(0, 10);
          if (!all.length) {
            console.log("[i] No approval requests.");
            return;
          }
          for (const r of all) {
            console.log(`    ${r.id}  ${r.state.padEnd(16)} ${r.params.minor} minor ${r.params.unit} → ${r.params.destination}${r.params.network ? ` (${r.params.network})` : ""}`);
            console.log(`        risk=${r.riskAssessment.level}  expires=${r.expiresAt}`);
          }
          return;
        }
        if (sub === "inspect") {
          const r = fin.approvals.get(rest[0] ?? "");
          if (!r) throw new Error(`Unknown approval ${rest[0]}`);
          console.log(JSON.stringify(r, null, 2));
          return;
        }
        if (sub === "approve") {
          const id = rest[0];
          const stored = fin.approvals.get(id ?? "");
          if (!stored) throw new Error(`Unknown approval ${id}`);
          // HUMAN APPROVAL MUST BE HUMAN (readiness P23): either an
          // interactive TTY with a typed challenge, or a separate approver
          // credential (FURLPAY_FINANCE_APPROVER_TOKEN) presented via
          // --approver. A non-interactive call with neither is refused with
          // exit code 46 — a scripted call is not a human decision.
          const gate = await assertHumanApproval(
            { minor: stored.params.minor, destination: stored.params.destination },
            {
              isTty: process.stdout.isTTY === true,
              approverToken: flags.approver ? String(flags.approver) : undefined,
              expectedToken: process.env.FURLPAY_FINANCE_APPROVER_TOKEN?.trim(),
              prompt: (question) => {
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                return new Promise<string>((res) => {
                  rl.question(question, res);
                  rl.close();
                });
              },
            },
          );
          if (!gate.ok) {
            console.error(`[!] ${gate.reason}`);
            process.exitCode = HUMAN_APPROVAL_EXIT_CODE;
            return;
          }
          // The human approves the STORED parameters exactly as `inspect`
          // showed them — reconstructed verbatim so the hash matches the
          // request. The binding that catches parameter substitution runs
          // again at execution time (reserve/assertBinding), where the
          // orchestrator re-presents the LIVE transaction parameters.
          const req = fin.approvals.approve(id, {
            minor: BigInt(stored.params.minor),
            unit: stored.params.unit,
            network: stored.params.network,
            destination: stored.params.destination,
            source: stored.params.source,
            type: stored.params.type,
            feeMinor: stored.params.feeMinor !== undefined ? BigInt(stored.params.feeMinor) : undefined,
          });
          await fin.events.emit("spend.approval_granted", { approvalId: req.id, params: req.params });
          console.log(`[+] Approved ${req.id} for ${req.params.minor} minor ${req.params.unit} → ${req.params.destination}${req.params.network ? ` (${req.params.network})` : ""}`);
          console.log(`    Re-run your payment create with --approval-id ${req.id} — the approval is bound to these exact parameters and is single-use.`);
          return;
        }
        if (sub === "deny") {
          const reason = String(flags.reason ?? "denied by user");
          const req = fin.approvals.deny(rest[0] ?? "", reason);
          await fin.events.emit("spend.approval_denied", { approvalId: req.id, reason });
          console.log(`[+] Denied ${req.id}.`);
          return;
        }
        usageLine();
        return;
      }

      case "payment": {
        if (sub === "create") {
          const unit = String(flags.unit ?? "USDC").toUpperCase();
          const network = flags.network ? String(flags.network).toLowerCase() : undefined;
          if (!flags.amount) throw new Error("--amount is required");
          const amount = network
            ? money.token(unit, network, String(flags.amount))
            : money.fiat(unit === "USD" ? "USD" : unit, String(flags.amount));
          const destination = String(flags.destination ?? "");
          if (!destination) throw new Error("--destination is required");
          const ids = fin.ensureStandardAccounts(
            amount.kind === "token" ? amount.asset : amount.currency,
            amount.kind === "token" ? amount.network : undefined
          );
          const feeMinor = flags.fee ? money.parseMinor(String(flags.fee), amount.kind === "token" ? amount.decimals : 2) : 0n;
          const result = fin.payments.createOutPayment({
            amount,
            destination,
            sourceAccountId: String(flags["source-account"] ?? ids.sourceId),
            destinationAccountId: ids.sourceId,
            counterAccountId: ids.counterId,
            feeAccountId: ids.feesId,
            feeMinor,
            idempotencyKey: flags["idempotency-key"] ? String(flags["idempotency-key"]) : undefined,
            approvalId: flags["approval-id"] ? String(flags["approval-id"]) : undefined,
            counterpartyRef: destination,
          });
          if ("paramsHash" in result) {
            const req = result as any;
            console.log(`[!] Human approval required. Request ${req.id} created:`);
            console.log(`    ${req.params.minor} minor ${req.params.unit} → ${req.params.destination}${req.params.network ? ` (${req.params.network})` : ""}`);
            console.log(`    Review: furlpay finance approval inspect ${req.id}`);
            console.log(`    Approve: furlpay finance approval approve ${req.id} --amount ${flags.amount} --unit ${unit}${network ? ` --network ${network}` : ""} --destination ${destination}${flags.fee ? ` --fee ${flags.fee}` : ""}`);
            console.log(`    Then re-run this create with --approval-id ${req.id}`);
            return;
          }
          const p = result as any;
          console.log(`[+] Payment ${p.id} recorded (${p.state}) — ${p.amount.minor} minor ${p.amount.unit}${p.amount.network ? ` (${p.amount.network})` : ""} → ${destination}`);
          if (!p.txHash) console.log("[i] No network evidence yet — `payment confirm <id> --tx-hash <real hash>` attaches it. Submission is never settlement.");
          return;
        }
        if (sub === "inspect" || sub === "status") {
          const p = fin.payments.get(rest[0] ?? "");
          if (!p) throw new Error(`Unknown payment ${rest[0]}`);
          console.log(JSON.stringify(p, null, 2));
          return;
        }
        if (sub === "receipt") {
          console.log(fin.payments.receipt(rest[0] ?? ""));
          return;
        }
        if (sub === "history") {
          const rows = fin.payments.history(20);
          if (!rows.length) {
            console.log("[i] No payments recorded.");
            return;
          }
          for (const p of rows) console.log(`    ${p.createdAt}  ${p.state.padEnd(10)} ${p.amount.minor.padStart(12)} ${p.amount.unit}  → ${p.destination ?? "?"}  ${p.id}`);
          return;
        }
        if (sub === "cancel") {
          const p = fin.payments.cancel(rest[0] ?? "", String(flags.reason ?? "cancelled by user"));
          console.log(`[+] Payment ${p.id} → ${p.state}.`);
          return;
        }
        if (sub === "confirm") {
          const txHash = String(flags["tx-hash"] ?? "");
          if (!txHash) throw new Error("--tx-hash with a REAL transaction hash is required — the ledger refuses fabricated references.");
          const submitted = fin.payments.markSubmitted(rest[0] ?? "", txHash);
          const confirmed = fin.payments.markConfirmed(submitted.id, "operator-asserted evidence attached");
          console.log(`[+] Payment ${confirmed.id} → ${confirmed.state} (evidence ${txHash.slice(0, 18)}…, operator_asserted).`);
          console.log(`[i] Settlement needs chain-verified evidence — a provider receipt check (destination, amount, success) is not wired in this build, so the payment stays CONFIRMED-unverified.`);
          return;
        }
        if (sub === "settle") {
          const p = fin.payments.markSettled(rest[0] ?? "");
          console.log(`[+] Payment ${p.id} → SETTLED.`);
          return;
        }
        usageLine();
        return;
      }

      case "treasury": {
        const s = fin.treasury.status();
        console.log("[i] Treasury balances (local ledger of record):");
        for (const b of s.balances) console.log(`    ${b.accountId.padEnd(34)} available=${b.availableMinor} reserved=${b.reservedMinor} total=${b.totalMinor}`);
        console.log(`[i] ${s.note}`);
        if (sub === "reconcile") {
          const r = fin.treasury.reconcile();
          console.log(`[${r.chainValid ? "+" : "!"}] chain ${r.chainValid ? "valid" : "INVALID"} · ${r.balancedTransactions}/${r.checkedTransactions} balanced · ${r.discrepancies.length} discrepancy(ies)`);
          for (const d of r.discrepancies) console.log(`[!] ${d}`);
        }
        return;
      }

      case "billing": {
        if (sub === "export") {
          const csv = fin.billing.exportCsv();
          if (flags.out) {
            const fs = await import("fs");
            await fs.promises.writeFile(String(flags.out), csv, { mode: 0o600 });
            console.log(`[+] Exported to ${flags.out}`);
            return;
          }
          console.log(csv);
          return;
        }
        const s = fin.billing.summary(flags.since ? String(flags.since) : undefined);
        const row = (o: Record<string, bigint>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)";
        console.log(`[i] Billing summary${s.windowStartIso ? ` (since ${s.windowStartIso})` : ""}:`);
        console.log(`    volume out: ${row(s.volumeOutMinorByUnit)}`);
        console.log(`    volume in : ${row(s.volumeInMinorByUnit)}`);
        console.log(`    fees      : ${row(s.feesMinorByUnit)}`);
        console.log(`    states    : settled=${s.settledCount} pending=${s.pendingCount} failed=${s.failedCount}`);
        return;
      }

      case "events": {
        if (sub === "verify") {
          const seq = Number(flags.seq ?? 0);
          const ev = fin.events.recent(1000).find((e) => e.seq === seq);
          if (!ev) throw new Error(`No event with seq ${seq} in the journal.`);
          const ok = fin.events.verifyEnvelope(ev, { allowAnyTimestamp: true, expectSeq: seq });
          console.log(ok ? `[+] Event ${seq} verifies (signature + payload hash).` : `[!] Event ${seq} FAILED verification.`);
          process.exitCode = ok ? 0 : 1;
          return;
        }
        const evs = fin.events.recent(20);
        if (!evs.length) {
          console.log("[i] No financial events recorded.");
          return;
        }
        for (const e of evs.reverse()) console.log(`    #${e.seq}  ${e.type.padEnd(28)} ${new Date(e.timestampMs).toISOString()}  sig=${e.signature.slice(0, 12)}…`);
        return;
      }

      default:
        usageLine();
    }
  }

  private printHelp(): void {
    console.log(`
FurlPay CLI — Stellar Tokenized Equities & Hyperliquid Trading Infrastructure
Minimum Cost, Maximum Results

COMMANDS:
  wallet       Manage Stellar accounts, keys, and hardware devices (ledger, sep7, extension, agent-keygen)
  trade        Spot SDEX/Soroban execution & Hyperliquid Perpetuals (limit, market-buy, swap, perp, close, cancel, leverage)
  hyperliquid  Query Hyperliquid validator status and live perpetual markets (status, markets)
  market       Institutional market microstructure analytics (L2 depth, micro-price, OFI, slippage)
  account      Hyperliquid clearinghouse balances, equity, margin, and open positions (balance, positions, orders, history)
  trading      Configure pre-trade risk controls and trigger emergency kill-switch (limits, kill-switch)
  earn / hlp   Deposit, withdraw, and inspect Hyperliquid HLP clearinghouse yield (stats, deposit, withdraw)
  escrow       Escrow & Time-Locked Settlement Scheme (ETSS) state machine (create, fund, proof, release, dispute)
  order        Query, monitor, and cancel active resting SDEX orders (list, inspect, cancel, cancel-all)
  rwa          Browse, verify compliance, and inspect tokenized stocks & RWAs (list, inspect, kyc)
  x402         Inspect and settle HTTP 402 agent micropayment challenges (pay)
  mcp          Launch local Model Context Protocol server for AI agent runtimes
  config       Display, update, and validate CLI network, RPC, and keyring settings (show, path, get, set, validate)
  finance      Local financial operations: double-entry ledger, payments, spend limits, approvals, treasury, billing (init, status, ledger, spend, approval, payment, treasury, billing, events)
  tx verify    Verify a real Stellar transaction against Horizon (honest lookup semantics, --output json)
  faucet       Fund a testnet/futurenet account via the official Stellar Friendbot (refuses mainnet)
`);
  }
}

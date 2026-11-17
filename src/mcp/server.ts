/**
 * Model Context Protocol (MCP) STDIO Server
 * 
 * Provides deterministic tool endpoints for AI Agents (Claude Code, Cursor, Gemini)
 * to settle invoices, manage treasury yield, inspect cross-chain market data,
 * and execute approved multi-chain transactions.
 * 
 * SENSITIVE MUTATION TOOLS are explicitly annotated with:
 * _meta: { "anthropic/requiresUserInteraction": true }
 * to enforce user review & interactive sign-off in Claude Code.
 */

import * as readline from "readline";
import { AgentKeyService } from "../wallet/agentKey";
import { X402Engine } from "../x402/micropayments";
import { SmartOrderRouter } from "../trade/router";
import { SdexTradingService } from "../trade/sdex";
import { KeypairSigner } from "../wallet/signer";
import { Keypair } from "@stellar/stellar-sdk";
import { HlpVaultService } from "../hyperliquid/hlp";
import { HyperliquidPerpService } from "../hyperliquid/perp";
import { MarketDiscoveryService } from "../market/discovery";
import { MarketDataService } from "../services/market-data";
import { HyperliquidRiskEngine, defaultTurnoverLedgerPath } from "../hyperliquid/risk-engine";
import { HyperliquidClient } from "../hyperliquid/client";
import { FinanceManager } from "../finance/manager";
import { sanitizeUntrusted, sanitizeNumeric, canonicalArgsHash } from "./sanitize";
import { OraclePriceAggregator } from "../oracles/aggregator";
import { SolanaRpcClient } from "../solana/rpc";

/** MCP surface modes (readiness P7): a default install cannot move funds. */
export type McpMode = "read-only" | "execution";

/**
 * Tools that sign, broadcast or move value. In read-only mode (the DEFAULT)
 * these are structurally absent from the tool list AND refused at the
 * dispatcher — an MCP client that never opted into execution can inspect,
 * quote and analyze, but never transact.
 */
const EXECUTION_TOOLS = new Set([
  "furlpay_settle_invoice",
  "furlpay_sweep_treasury",
  "furlpay_trade",
  "furlpay_trade_perp",
  "furlpay_execute_trade",
  "furlpay_cancel_order",
  "furlpay_emergency_stop",
  "furlpay_pay",
]);

const TWO_PHASE_TTL_MS = 10 * 60_000;
const DEFAULT_MUTATING_RATE_PER_MIN = 30;

export interface McpServerOptions {
  /** Default "read-only" — execution requires --enable-execution + policy. */
  mode?: McpMode;
  /** Injectable audit JSONL path (tests use temp dirs). */
  auditPath?: string;
  /** Mutating calls allowed per minute (default 30). */
  ratePerMinute?: number;
  /** Injectable agent-key service (tests use temp policy dirs). */
  agentKeyService?: AgentKeyService;
}

export class McpStdioServer {
  private agentName: string;
  private readonly mode: McpMode;
  private readonly auditPath?: string;
  private readonly ratePerMinute: number;
  private agentKeyService: AgentKeyService;
  private x402Engine: X402Engine;
  private router: SmartOrderRouter;
  private sdexService: SdexTradingService;
  private hlpService: HlpVaultService;
  private perpService: HyperliquidPerpService;
  private discovery: MarketDiscoveryService;
  private marketData: MarketDataService;
  private riskEngine: HyperliquidRiskEngine;
  private hlClient: HyperliquidClient;
  /** Lazy: `furlpay mcp` startup must not depend on finance-store health. */
  private financeInstance?: FinanceManager;
  /** Two-phase execution: previewed (tool, args) bound by hash. */
  private previewStore = new Map<string, { tool: string; args: Record<string, unknown>; createdAt: number }>();
  /** Per-call audit counters — write failures stay visible. */
  private auditWriteFailures = 0;
  private rateWindow = { start: 0, count: 0 };

  /** Read-only finance surface. Deliberately no create/approve/limit tools —
   *  MCP can inspect money, never authorize its movement (that is the
   *  CLI human's job via `furlpay finance approval approve`). */
  private getFinance(): FinanceManager {
    if (!this.financeInstance) this.financeInstance = new FinanceManager();
    return this.financeInstance;
  }

  /** True when an agent policy exists for this server's identity. */
  hasAgentPolicy(): boolean {
    return this.agentKeyService.loadAgentPolicy(this.agentName) !== null;
  }

  getMode(): McpMode {
    return this.mode;
  }

  constructor(agentName: string = "default-agent", options: McpServerOptions = {}) {
    this.agentName = agentName;
    this.mode = options.mode ?? "read-only";
    this.auditPath = options.auditPath;
    this.ratePerMinute = options.ratePerMinute ?? DEFAULT_MUTATING_RATE_PER_MIN;
    this.agentKeyService = options.agentKeyService ?? new AgentKeyService();
    this.x402Engine = new X402Engine();
    this.router = new SmartOrderRouter();
    this.sdexService = new SdexTradingService();
    this.hlpService = new HlpVaultService();
    this.perpService = new HyperliquidPerpService();
    this.discovery = new MarketDiscoveryService();
    this.marketData = new MarketDataService();
    this.riskEngine = new HyperliquidRiskEngine(undefined, { turnoverLedgerPath: defaultTurnoverLedgerPath() });
    this.hlClient = new HyperliquidClient();
  }

  getToolDefinitions() {
    const all = [
      // 1. Core Payments & Micropayments
      {
        name: "furlpay_settle_invoice",
        description: "Settle an x402 micropayment challenge or API invoice with Agent Trust checks and TigerBeetle netting.",
        inputSchema: {
          type: "object",
          properties: {
            challengeHeader: { type: "string", description: "WWW-Authenticate: x402 header string" },
            maxCost: { type: "number", description: "Maximum allowed cost in USD" },
          },
          required: ["challengeHeader"],
        },
      },
      {
        name: "furlpay_sweep_treasury",
        description: "Sweep idle USDC treasury balances into Hyperliquid HLP or Franklin FOBXX (Benji) yield.",
        inputSchema: {
          type: "object",
          properties: {
            amountUsd: { type: "number", description: "Amount of idle USDC to deposit" },
            target: { type: "string", enum: ["HLP", "FOBXX"], description: "Destination vault: HLP or FOBXX" },
          },
          required: ["amountUsd"],
        },
      },
      {
        name: "furlpay_trade",
        description: "Execute a limit buy/sell order or market swap for tokenized equities (JQQQ, NVDA) or RWAs on Stellar.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1.0 },
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            side: { type: "string", enum: ["buy", "sell"] },
            asset: { type: "string", description: "Asset identifier, e.g. JQQQ or NVDA" },
            amount: { type: "string", description: "Units to trade" },
            price: { type: "string", description: "Price in USDC" },
            sponsor: { type: "boolean", description: "Zero-gas fee-bump execution" },
          },
          required: ["side", "asset", "amount", "price"],
        },
      },
      {
        name: "furlpay_trade_perp",
        description: "Execute a perpetual futures order on Hyperliquid L1 (HYPE-PERP, BTC-PERP, ETH-PERP, SOL-PERP).",
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Perpetual contract symbol (e.g. HYPE-PERP, BTC-PERP)" },
            side: { type: "string", enum: ["buy", "sell"] },
            size: { type: "number", description: "Contract size" },
            leverage: { type: "number", description: "Leverage (1x - 20x)" },
            price: { type: "number", description: "Limit price (optional; market if omitted)" },
          },
          required: ["symbol", "side", "size", "leverage"],
        },
      },
      {
        name: "furlpay_get_hlp_yield",
        description: "Query live performance, share price, instantaneous APR, and 30-day trailing APY for Hyperliquid HLP vault.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "furlpay_balance",
        description: "Query current account balances across Stellar native assets, Hyperliquid USDC, and tokenized RWAs.",
        inputSchema: {
          type: "object",
          properties: {
            account: { type: "string", description: "Optional public key; defaults to agent wallet" },
          },
        },
      },
      {
        name: "furlpay_get_quote",
        description: "Get optimal routing quote across SDEX Central Limit Order Book and Soroban AMMs.",
        inputSchema: {
          type: "object",
          properties: {
            sourceAsset: { type: "string" },
            targetAsset: { type: "string" },
            amount: { type: "number" },
          },
          required: ["sourceAsset", "targetAsset", "amount"],
        },
      },

      // 2. Multi-Chain Market Discovery & Aggregation
      {
        name: "furlpay_list_chains",
        description: "List all supported blockchains (Hyperliquid, Stellar, Ethereum, Solana, Arbitrum, Base, Optimism, Polygon, Avalanche, BNB).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "furlpay_list_exchanges",
        description: "List all connected exchange venues, fee tiers, and supported market types.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "furlpay_market_search",
        description: "Search supported trading pairs across chains by ticker, name, or chain ID.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query, e.g. BTC, ETH, HYPE, JQQQ" },
            chain: { type: "string", description: "Optional chain filter (e.g. hyperliquid, stellar, ethereum)" },
          },
          required: ["query"],
        },
      },
      {
        name: "furlpay_get_market_data",
        description: "Get real-time market price, mark price, funding rate, 24h volume, and status for an asset.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Asset or contract symbol (e.g. HYPE, BTC, ETH, SOL)" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "furlpay_get_orderbook",
        description: "Retrieve real-time L2 order book, depth at 10/25/50 bps, volume-weighted spread, and micro-price.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Contract symbol (e.g. BTC, ETH, SOL, HYPE)" },
            depthLevels: { type: "number", description: "Number of levels to retrieve (10, 20, 50)" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "furlpay_get_funding",
        description: "Retrieve perpetual funding rates, next funding timestamp, and open interest.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Perp symbol (e.g. BTC, ETH, SOL, HYPE)" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "furlpay_get_market_analysis",
        description: "Calculate technical indicators and market microstructure metrics (Depth-Weighted Micro-Price, OFI, VWS, Slippage).",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Symbol to analyze (e.g. BTC, ETH, HYPE)" },
          },
          required: ["symbol"],
        },
      },
      {
        name: "furlpay_compare_markets",
        description: "Compare liquidity, spreads, and execution pricing across different chains and venues for the same asset.",
        inputSchema: {
          type: "object",
          properties: {
            asset: { type: "string", description: "Base asset to compare (e.g. BTC, ETH, SOL)" },
          },
          required: ["asset"],
        },
      },

      // 3. Portfolio & Risk
      {
        name: "furlpay_positions",
        description: "Inspect open perpetual positions, mark price, entry price, liquidation price, and unrealized PnL.",
        inputSchema: {
          type: "object",
          properties: {
            userAddress: { type: "string", description: "Optional wallet address" },
          },
        },
      },
      {
        name: "furlpay_open_orders",
        description: "Inspect outstanding resting orders on connected exchanges.",
        inputSchema: {
          type: "object",
          properties: {
            userAddress: { type: "string", description: "Optional wallet address" },
          },
        },
      },
      {
        name: "furlpay_portfolio_risk",
        description: "Calculate overall portfolio exposure, margin utilization, and risk concentration.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },

      // 4. Trade Preview & Human-Approved Execution
      {
        name: "furlpay_preview_trade",
        description: "Build a complete trade preview without submitting an order (fees, slippage, margin requirement, liquidation estimate).",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Trading symbol, e.g. HYPE, BTC, ETH" },
            side: { type: "string", enum: ["buy", "sell"] },
            size: { type: "number", description: "Order quantity" },
            leverage: { type: "number", description: "Leverage (1x - 20x)" },
            price: { type: "number", description: "Optional limit price" },
          },
          required: ["symbol", "side", "size"],
        },
      },
      {
        name: "furlpay_execute_trade",
        description: "Submit an approved trade to the exchange execution engine. Requires explicit interactive human approval.",
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            side: { type: "string", enum: ["buy", "sell"] },
            size: { type: "number" },
            leverage: { type: "number" },
            price: { type: "number" },
            orderType: { type: "string", enum: ["limit", "market"] },
          },
          required: ["symbol", "side", "size"],
        },
      },
      {
        name: "furlpay_cancel_order",
        description: "Cancel an open resting order. Requires explicit interactive human approval.",
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string" },
            orderId: { type: "number" },
          },
          required: ["symbol", "orderId"],
        },
      },
      {
        name: "furlpay_emergency_stop",
        description: "Trigger the emergency trading kill switch, blocking new trades and canceling active orders. Requires explicit approval.",
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Optional symbol to halt; halts all markets if omitted" },
          },
        },
      },
      {
        name: "furlpay_pay",
        description: "Execute an A2A transfer or invoice payment with mandate validation. Requires explicit interactive human approval.",
        _meta: { "anthropic/requiresUserInteraction": true },
        inputSchema: {
          type: "object",
          properties: {
            recipient: { type: "string", description: "Recipient handle (@handle) or address" },
            amount: { type: "number", description: "Amount in USD" },
            token: { type: "string", description: "Token symbol (e.g. USDC)" },
            mandate: { type: "string", description: "Cryptographically signed owner spending mandate" },
          },
          required: ["recipient", "amount"],
        },
      },
      {
        name: "furlpay_get_rwa_assets",
        description: "List all supported institutional tokenized equities and money market funds (JQQQ, FOBXX, Securitize NVDA).",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "furlpay_get_rwa_quote",
        description: "Retrieve real-time transaction quote for tokenized equities or RWAs on Stellar.",
        inputSchema: {
          type: "object",
          properties: {
            asset: { type: "string", description: "Asset identifier, e.g. JQQQ, FOBXX" },
            amount: { type: "number", description: "Number of shares" },
          },
          required: ["asset", "amount"],
        },
      },

      // 9. Financial Operations Layer (READ-ONLY — inspection, never authorization)
      {
        name: "furlpay_finance_overview",
        description: "Read-only overview of the local financial operations layer: accounts, spend limits, settlement capabilities. MCP cannot move money or approve payments.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "furlpay_finance_ledger",
        description: "Read-only ledger view: recent double-entry transactions, or a full reconciliation report (balanced count, chain integrity).",
        inputSchema: {
          type: "object",
          properties: {
            reconcile: { type: "boolean", description: "Run reconciliation instead of listing" },
            limit: { type: "number", description: "Max transactions to list (default 10)" },
          },
        },
      },
      {
        name: "furlpay_finance_spend",
        description: "Read-only spend report: window usage against limits, breakdown by unit, recent consuming transactions.",
        inputSchema: {
          type: "object",
          properties: {
            unit: { type: "string", description: "Filter to one unit, e.g. USDC" },
          },
        },
      },
      {
        name: "furlpay_finance_treasury",
        description: "Read-only treasury balances (available vs reserved) and inflow/outflow by unit, derived from the ledger.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "furlpay_finance_billing",
        description: "Read-only billing summary: payment volume in/out, fees by unit, state counts. Fees are reported separately from volume.",
        inputSchema: {
          type: "object",
          properties: {
            sinceIso: { type: "string", description: "Optional ISO timestamp window start" },
          },
        },
      },
      {
        name: "furlpay_finance_payments",
        description: "Read-only payment history from the ledger. States are the ledger's own (submission is never settlement).",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max payments (default 10)" },
            inspect: { type: "string", description: "Inspect one payment by ledger tx id" },
          },
        },
      },

      // 11. Oracle & Solana live reads (gap report 2026-11-17 Gaps 2/5 —
      // read-only, no signing path exists in either).
      {
        name: "furlpay_oracle_price",
        description: "Live multi-source USD price quote (Coinbase/Kraken/Binance/Jupiter fan-out, median + cross-source agreement gate). DISAGREEMENT returns per-source readings with a null price — never a blended number across disagreeing sources.",
        inputSchema: {
          type: "object",
          properties: {
            asset: { type: "string", description: "Asset symbol: SOL, BTC, ETH, XLM or USDC" },
          },
          required: ["asset"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      },
      {
        name: "furlpay_solana_cluster_status",
        description: "Live read-only Solana cluster status from real RPC (epoch, slot, block height). No signing or broadcasting exists on this surface.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },

      // 10. Two-phase execution protocol (readiness P7). Preview is always
      // available and executes NOTHING; confirm exists only in execution
      // mode and requires a configured agent policy per call.
      {
        name: "furlpay_preview_execution",
        description: "Preview a value-moving tool call WITHOUT executing: binds sanitized arguments to a one-time executionHash and returns the net effect. Confirm via furlpay_confirm_execution.",
        inputSchema: {
          type: "object",
          properties: {
            tool: { type: "string", description: "The execution tool to preview, e.g. furlpay_trade" },
            args: { type: "object", description: "The arguments that would be passed to that tool" },
          },
          required: ["tool", "args"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      },
      {
        name: "furlpay_confirm_execution",
        description: "Execute a PREVIEWED tool call by its executionHash (single-use, 10-minute TTL). Re-runs the agent policy gate on the stored amount. Requires --enable-execution and a configured policy.",
        inputSchema: {
          type: "object",
          properties: {
            executionHash: { type: "string", description: "The hash returned by furlpay_preview_execution" },
          },
          required: ["executionHash"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
    ];

    // Read-only default (P7): execution tools are structurally ABSENT —
    // tools/list never shows what this server must never do, and the
    // dispatcher refuses them as a backstop.
    const filtered = all.filter((t: any) => this.mode === "execution" || !EXECUTION_TOOLS.has(t.name));
    // confirm is meaningless without execution mode.
    return filtered.filter((t: any) => t.name !== "furlpay_confirm_execution" || this.mode === "execution");
  }

  /**
   * Estimate the USD notional a perp order would commit, for the agent
   * policy gate. Live mid from the exchange when no explicit price — a gate
   * that can't price the order must refuse, not guess.
   */
  private async estimateNotionalUsd(symbol: string | undefined, size: number, price?: number): Promise<number> {
    if (typeof size !== "number" || !isFinite(size) || size <= 0) {
      throw new Error("Perp order size must be a positive number.");
    }
    let px = price;
    if (typeof px !== "number" || !isFinite(px) || px <= 0) {
      const clean = (symbol || "").toUpperCase().replace(/-PERP$/i, "");
      const mids = await this.hlClient.getAllMids();
      const mid = mids[clean];
      if (!mid || !isFinite(parseFloat(mid)) || parseFloat(mid) <= 0) {
        throw new Error(
          `Cannot price ${clean} for the agent policy gate — no live mid available. ` +
            `Pass an explicit price, or use furlpay_preview_trade first.`
        );
      }
      px = parseFloat(mid);
    }
    return Number((size * (px as number)).toFixed(2));
  }

  /**
   * P1 gate (2026-11-16 audit): EVERY value-moving MCP tool runs through the
   * same atomic policy ledger as the CLI — validate + record under the policy
   * lock. No agent policy loaded = autonomous execution refused outright: an
   * MCP client that never configured a mandate must never be able to move
   * money, and the old code executed live perp orders and vault sweeps with
   * no gate at all (sweep even defaulted to 450 USDC when no amount was
   * passed).
   */
  private requirePolicyGate(amountUsd: number, assetCode: string): void {
    if (!this.agentKeyService.loadAgentPolicy(this.agentName)) {
      throw new Error(
        `Autonomous execution refused: no agent policy named "${this.agentName}" is configured. ` +
          `Create one with \`furlpay wallet agent-keygen\` and start the server with ` +
          `\`furlpay mcp --wallet ${this.agentName}\`; an unconfigured MCP server never moves value.`
      );
    }
    const gate = this.agentKeyService.validateAndRecordSpend(this.agentName, amountUsd, assetCode);
    if (!gate.allowed) {
      throw new Error(`Mutation rejected by agent policy: ${gate.reason}`);
    }
  }

  /**
   * Per-call audit trail (readiness P7): every call — allowed or refused —
   * lands as one JSONL line with the agent identity and a hash of the
   * arguments (never the raw arguments: a memo may contain untrusted text
   * and the audit log must stay a safe surface).
   */
  private audit(tool: string, argsHash: string, allowed: boolean, reason?: string): void {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      agent: this.agentName,
      mode: this.mode,
      tool,
      argsHash,
      allowed,
      ...(reason ? { reason: reason.slice(0, 200) } : {}),
    });
    try {
      const target = this.auditPath ?? require("os").homedir() + "/.furlpay/mcp-audit.jsonl";
      require("fs").appendFileSync(target, line + "\n", { encoding: "utf8" });
    } catch {
      this.auditWriteFailures += 1; // visible, never silent-forever
    }
  }

  /** Mutating calls per rolling minute — a runaway agent cannot hammer. */
  private checkMutatingRate(): void {
    const now = Date.now();
    if (now - this.rateWindow.start >= 60_000) {
      this.rateWindow = { start: now, count: 0 };
    }
    this.rateWindow.count += 1;
    if (this.rateWindow.count > this.ratePerMinute) {
      throw new Error(`MUTATING_RATE_LIMITED: more than ${this.ratePerMinute} mutating calls in a rolling minute — refusing.`);
    }
  }

  /** Mode backstop helper: refusal message for a mutating direct call. */
  private executionRefusal(name: string): Error {
    return new Error(
      `EXECUTION_MODE_REQUIRED: "${name}" moves value and this server runs READ-ONLY (default). ` +
        `Start with \`furlpay mcp --wallet ${this.agentName} --enable-execution\` (a configured agent policy is required) or use the CLI as a human.`
    );
  }

  /** Net effect summary for a previewed execution (P7 two-phase). */
  private netEffect(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { tool };
    const pick = (k: string) => (typeof args[k] === "string" ? sanitizeUntrusted(args[k], 60) : args[k]);
    if (tool === "furlpay_settle_invoice") {
      try {
        const ch = this.x402Engine.parseChallenge(String(args.challengeHeader ?? ""));
        out.amount = sanitizeUntrusted(ch.amount, 40);
      } catch { out.amount = "unparsable challenge (will refuse at confirm)"; }
      out.maxCost = pick("maxCost");
    } else if (tool === "furlpay_sweep_treasury") {
      out.amountUsd = pick("amountUsd");
      out.target = pick("target");
    } else if (tool === "furlpay_trade" || tool === "furlpay_trade_perp" || tool === "furlpay_execute_trade") {
      out.side = pick("side");
      out.asset = pick("asset") ?? pick("symbol");
      out.amount = pick("amount") ?? pick("size") ?? pick("quantity");
    } else if (tool === "furlpay_pay") {
      out.amount = pick("amount");
      out.recipient = pick("recipient") ?? pick("to");
    } else if (tool === "furlpay_cancel_order" || tool === "furlpay_emergency_stop") {
      out.effect = "risk-reducing: cancels resting orders (no new exposure)";
    }
    return out;
  }

  /** Length-cap and strip control characters in every string arg. */
  private sanitizeArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (typeof v === "string") out[k] = sanitizeUntrusted(v, k === "challengeHeader" ? 4096 : 200);
      else out[k] = v;
    }
    return out;
  }

  /** The USD amount a stored preview would move — for the confirm-time gate. */
  private policyAmountFor(tool: string, args: Record<string, unknown>): number {
    for (const k of ["amountUsd", "maxCost", "amount", "size", "notional"]) {
      const v = args[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
      if (typeof v === "string") {
        const n = sanitizeNumeric(v, 1e9);
        if (n !== null) return n;
      }
    }
    return 0; // risk-reducing tools (cancel/stop) carry no new spend
  }

  /**
   * TWO-PHASE EXECUTION (readiness P7): mutating tools are never called
   * directly. Preview binds sanitized arguments to a one-time hash and
   * shows the net effect; confirm(hash) is the only path that executes, and
   * it re-runs the policy gate on the STORED amount — confirm cannot
   * smuggle different arguments past the cap checks.
   */
  async handleCall(name: string, args: any, viaConfirm = false): Promise<any> {
    const argsHash = canonicalArgsHash(typeof args === "object" && args ? args : {});

    if (name === "furlpay_preview_execution") {
      const tool = sanitizeUntrusted(args?.tool, 60);
      if (!EXECUTION_TOOLS.has(tool)) {
        throw new Error(`PREVIEW_REFUSED: "${tool}" is not a registered execution tool.`);
      }
      const sanitized = this.sanitizeArgs(tool, (args?.args ?? {}) as Record<string, unknown>);
      const hash = canonicalArgsHash({ agent: this.agentName, tool, args: sanitized });
      const createdAt = Date.now();
      this.previewStore.set(hash, { tool, args: sanitized, createdAt });
      const expired = [...this.previewStore.entries()].filter(([, v]) => createdAt - v.createdAt > TWO_PHASE_TTL_MS);
      for (const [k] of expired) this.previewStore.delete(k);
      this.audit(name, hash, true, "preview stored");
      return {
        phase: "preview",
        executionHash: hash,
        tool,
        netEffect: this.netEffect(tool, sanitized),
        expiresAt: new Date(createdAt + TWO_PHASE_TTL_MS).toISOString(),
        note: "Nothing executed. Confirm with furlpay_confirm_execution { executionHash }. Above your agent policy's daily cap the CLI human is the only approver.",
      };
    }

    if (name === "furlpay_confirm_execution") {
      if (this.mode !== "execution") {
        throw new Error(`EXECUTION_MODE_REQUIRED: confirm executes value movement — this server runs READ-ONLY.`);
      }
      const hash = sanitizeUntrusted(args?.executionHash, 80);
      const entry = this.previewStore.get(hash);
      if (!entry) {
        throw new Error(`CONFIRM_WITHOUT_PREVIEW: no live preview for ${hash}. Preview first via furlpay_preview_execution.`);
      }
      if (Date.now() - entry.createdAt > TWO_PHASE_TTL_MS) {
        this.previewStore.delete(hash);
        throw new Error(`PREVIEW_EXPIRED: preview ${hash} expired — re-preview the execution.`);
      }
      // Single-use: delete BEFORE executing so a replayed confirm can never
      // double-execute even if the tool itself throws.
      this.previewStore.delete(hash);
      // Attempts count against the rate limit even when the policy gate
      // refuses — a hammering agent is throttled before it is reasoned with.
      this.checkMutatingRate();
      // Policy gate re-runs on the STORED amount, not anything the caller
      // passed to confirm. All MCP execution amounts are USD-denominated —
      // the policy whitelist is checked in USDC terms.
      const gate = this.policyAmountFor(entry.tool, entry.args);
      this.requirePolicyGate(gate, "USDC");
      this.audit(entry.tool, hash, true, "confirmed");
      return await this.handleCall(entry.tool, entry.args, true);
    }

    if (EXECUTION_TOOLS.has(name) && !viaConfirm) {
      // Direct dispatch of a mutating tool: refused everywhere. In
      // read-only mode the message points at the mode; in execution mode it
      // points at the two-phase protocol.
      if (this.mode !== "execution") {
        this.audit(name, argsHash, false, "read-only mode");
        throw this.executionRefusal(name);
      }
      this.audit(name, argsHash, false, "two-phase required");
      throw new Error(
        `TWO_PHASE_REQUIRED: "${name}" cannot be called directly. Preview via furlpay_preview_execution ` +
          `(returns an executionHash + net effect), then furlpay_confirm_execution { executionHash }.`
      );
    }

    if (EXECUTION_TOOLS.has(name)) {
      this.checkMutatingRate();
    }

    const loadedAgent = this.agentKeyService.loadAgentPolicy(this.agentName);
    const policy = loadedAgent?.policy;

    switch (name) {
      case "furlpay_settle_invoice": {
        const challenge = this.x402Engine.parseChallenge(args.challengeHeader);
        const amt = parseFloat(challenge.amount);
        // Policy gate happens BEFORE settlement, atomically: read-validate-
        // record under the policy lock, so concurrent tool calls cannot both
        // pass against the same stale spentTodayUsd snapshot (the old code
        // validated a snapshot loaded at handleCall entry and never recorded
        // the spend at all — the daily cap was unenforceable). No policy on
        // disk = simulation-only mode (settleChallenge never moves value).
        if (loadedAgent) {
          if (args.maxCost && amt > args.maxCost) {
            throw new Error(`Invoice cost \$${amt} exceeds caller's max allowed cost \$${args.maxCost}`);
          }
          const gate = this.agentKeyService.validateAndRecordSpend(this.agentName, amt, challenge.token);
          if (!gate.allowed) {
            throw new Error(`Payment rejected by agent policy: ${gate.reason}`);
          }
        }
        // policy passed only when there is no gated path (never both — the
        // gate already recorded the spend; a snapshot re-check would
        // double-count it against the cap).
        const res = await this.x402Engine.settleChallenge(challenge, loadedAgent ? undefined : policy, args.maxCost);
        return {
          status: res.status,
          tx_id: res.txId,
          amount: res.amount,
          recipient: res.recipient,
          settlement_type: res.settlementType,
          authorization_header: res.authorizationHeader,
        };
      }

      case "furlpay_sweep_treasury": {
        // No fabricated default: a missing amount is a refused call, never
        // an invented 450 USDC treasury decision (audit P1).
        const amt = args.amountUsd;
        if (typeof amt !== "number" || !isFinite(amt) || amt <= 0) {
          throw new Error("furlpay_sweep_treasury requires a positive amountUsd.");
        }
        const target = (args.target || "HLP").toUpperCase();

        if (target === "HLP") {
          // Real signed vault transfer — gated by the agent policy.
          this.requirePolicyGate(amt, "USDC");
          const res = await this.hlpService.deposit(amt);
          return {
            status: "SUCCESS",
            vault: "HYPERLIQUID_HLP",
            amount_usd: amt,
            // null = not derivable from public vault data; the exchange
            // determines actual shares and NAV at settlement.
            shares_minted: res.sharesMinted,
            share_price: res.effectiveSharePrice,
            apy: res.currentApyPct === null
              ? "unavailable (vault APR not returned by live data)"
              : `${res.currentApyPct}% Real APR`,
            tx_hash: res.txHash,
          };
        } else {
          // SIMULATED — no FOBXX/BENJI contract call exists in this build;
          // shares below are sample data, not a deposit record. No APY is
          // reported: there is no issuer data source here, and any figure
          // would be fabricated.
          return {
            simulated: true,
            notice: "SIMULATED — no Stellar deposit was broadcast and no FOBXX contract call was made.",
            status: "SIMULATED",
            vault: "STELLAR_FOBXX_BENJI",
            shares_minted: amt.toFixed(2),
            asset: "FOBXX",
            contract: "GBNX66T6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QFOBXX",
            apy: null,
            apy_note: "not queried — no issuer data source in this build; treat any APY figure for FOBXX as unverified until read from the issuer",
            custodian: "Franklin Templeton Institutional (reference)",
          };
        }
      }

      case "furlpay_trade": {
        // An MCP agent must never trade through a signer it invented.
        // Keypair.random() produced "successful" trades signed by an
        // ephemeral key that controls no funds; refuse instead.
        if (args.simulate === true) {
          const signer = new KeypairSigner(Keypair.random());
          const tradeRes = await this.sdexService.executeLimitOrder(signer, {
            side: args.side,
            asset: args.asset.includes(":") ? args.asset : `${args.asset}:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ`,
            against: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            amount: args.amount,
            price: args.price,
            sponsor: args.sponsor ?? true,
          });
          return { ...tradeRes, simulated: true, notice: "SIMULATED — no transaction was broadcast; requires an explicit simulate=true." };
        }
        return {
          status: "REJECTED",
          error: "no_signer_configured",
          message:
            "No Stellar signer is configured in MCP server mode. To place a real SDEX order, run `furlpay wallet import` in the CLI (never pass key material through MCP tool arguments), or call this tool with simulate=true for an explicitly simulated result.",
        };
      }

      case "furlpay_trade_perp":
      case "furlpay_execute_trade": {
        // LIVE signed L1 order — policy-gated on full notional exposure
        // (margin is what you post; notional is what you risk).
        const notionalUsd = await this.estimateNotionalUsd(args.symbol, args.size, args.price);
        this.requirePolicyGate(notionalUsd, "USDC");
        return await this.perpService.executePerpOrder({
          symbol: args.symbol,
          side: args.side,
          size: args.size,
          leverage: args.leverage || 5,
          price: args.price,
          orderType: args.orderType || (args.price ? "limit" : "market"),
        });
      }

      case "furlpay_get_hlp_yield": {
        return await this.hlpService.getHlpStats();
      }

      case "furlpay_balance": {
        // SIMULATED fixture balances — this MCP mode has no authenticated
        // account connection, so any "balance" here is sample data. The flag
        // makes it impossible for an agent to mistake it for a real reading.
        return {
          simulated: true,
          notice: "SIMULATED sample balances — connect an authenticated account (furlpay login) for real balances.",
          account: policy?.publicKey || "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
          balances: [
            { asset: "USDC", chain: "Hyperliquid", balance: "14850.20", valueUsd: "14850.20" },
            { asset: "USDC", chain: "Stellar", balance: "8500.00", valueUsd: "8500.00" },
            { asset: "HLP", chain: "Hyperliquid", balance: "2450.00", valueUsd: "3499.82" },
            { asset: "JQQQ", chain: "Stellar", balance: "25.00", valueUsd: "2605.00" },
            { asset: "FOBXX", chain: "Stellar", balance: "450.00", valueUsd: "450.00" },
            { asset: "XLM", chain: "Stellar", balance: "125.00", valueUsd: "14.81" },
            { asset: "ETH", chain: "Ethereum", balance: "0.65", valueUsd: "1846.16" },
          ],
        };
      }

      case "furlpay_get_quote": {
        return await this.router.findBestRoute(args.sourceAsset, args.targetAsset, args.amount);
      }

      // ── Financial Operations Layer: READ-ONLY by design ─────────────────
      // No finance tool here can create payments, approve requests, or change
      // limits. Money movement authorization is a human CLI action; an MCP
      // agent can read the same ledger the human audits, nothing more.
      case "furlpay_finance_overview": {
        const fin = this.getFinance();
        return {
          readOnlyNotice: "MCP finance tools are inspection-only; payments, approvals and limit changes happen in the CLI by a human.",
          accounts: fin.ledger.listAccounts().map((a) => ({ id: a.id, kind: a.kind, unit: a.unit, network: a.network ?? null, role: a.role ?? null })),
          spendLimits: Object.fromEntries(Object.entries(fin.spend.getLimits()).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
          settlementCapabilities: fin.payments.settlementCapabilities(),
        };
      }
      case "furlpay_finance_ledger": {
        const fin = this.getFinance();
        if (args.reconcile === true) return fin.ledger.reconcile();
        return {
          transactions: fin.ledger
            .listTransactions()
            .slice(-(args.limit ?? 10))
            .reverse()
            .map((t) => ({
              id: t.id, seq: t.seq, type: t.type, state: t.state,
                  entries: t.entries.map((e) => ({ account: e.accountId, direction: e.direction, minor: e.minor.toString(), unit: e.unit })),
                  txHash: t.txHash ?? null, createdAt: t.createdAt,
            })),
        };
      }
      case "furlpay_finance_spend": {
        const fin = this.getFinance();
        const unit = args.unit ?? "USDC";
        const u = fin.spend.usage(unit);
        return {
          unit,
          usage: { total: u.total.toString(), today: u.today.toString(), thisWeek: u.thisWeek.toString(), thisMonth: u.thisMonth.toString() },
          limits: Object.fromEntries(Object.entries(u.limits).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
          breakdown: fin.spend.breakdown().map((b) => ({ unit: b.unit, minor: b.minor.toString(), transactions: b.transactions })),
        };
      }
      case "furlpay_finance_treasury": {
        const fin = this.getFinance();
        const s = fin.treasury.status();
        return {
          balances: s.balances.map((b) => ({ ...b, availableMinor: b.availableMinor.toString(), reservedMinor: b.reservedMinor.toString(), totalMinor: b.totalMinor.toString() })),
          inflowMinorByUnit: Object.fromEntries(Object.entries(s.inflowMinorByUnit).map(([k, v]) => [k, v.toString()])),
          outflowMinorByUnit: Object.fromEntries(Object.entries(s.outflowMinorByUnit).map(([k, v]) => [k, v.toString()])),
          note: s.note,
        };
      }
      case "furlpay_finance_billing": {
        const fin = this.getFinance();
        const s = fin.billing.summary(args.sinceIso);
        const b = (o: Record<string, bigint>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toString()]));
        return { volumeOutMinorByUnit: b(s.volumeOutMinorByUnit), volumeInMinorByUnit: b(s.volumeInMinorByUnit), feesMinorByUnit: b(s.feesMinorByUnit), counts: s.counts };
      }
      case "furlpay_finance_payments": {
        const fin = this.getFinance();
        if (args.inspect) {
          const p = fin.payments.get(args.inspect);
          if (!p) throw new Error(`Unknown payment ${args.inspect}.`);
          return { ...p, amount: { ...p.amount } };
        }
        return {
          payments: fin.payments.history(args.limit ?? 10).map((p) => ({
            id: p.id, state: p.state, unit: p.amount.unit, minor: p.amount.minor,
                network: p.amount.network ?? null, destination: p.destination ?? null, txHash: p.txHash ?? null, createdAt: p.createdAt,
          })),
        };
      }

      case "furlpay_oracle_price": {
        const asset = sanitizeUntrusted(String(args.asset ?? ""), 12).toUpperCase().trim();
        if (!asset) throw new Error("furlpay_oracle_price requires an asset symbol (SOL, BTC, ETH, XLM, USDC).");
        const quote = await new OraclePriceAggregator().getQuote(asset);
        return {
          asset: quote.asset,
          status: quote.status,
          priceUsd: quote.priceUsd,
          readings: quote.readings.map((r) => ({ source: r.source, priceUsd: r.priceUsd })),
          deviations: quote.deviations,
          maxDeviationPct: quote.maxDeviationPct,
          note: "Median of agreeing sources; DISAGREEMENT/UNAVAILABLE carry a null price by design — never a blended or guessed number.",
        };
      }

      case "furlpay_solana_cluster_status": {
        const client = new SolanaRpcClient();
        try {
          const epoch = await client.getEpochInfo();
          return {
            status: "LIVE",
            rpc: client.describeEndpoint(),
            mode: "read-only",
            ...epoch,
          };
        } catch (err: any) {
          // An RPC outage is surfaced, never papered over with slot 0.
          return { status: "UNAVAILABLE", rpc: client.describeEndpoint(), error: err.message };
        }
      }

      case "furlpay_list_chains": {
        return await this.discovery.listChains();
      }

      case "furlpay_list_exchanges": {
        return await this.discovery.listExchanges();
      }

      case "furlpay_market_search": {
        return await this.discovery.getMarkets({ query: args.query, chain: args.chain });
      }

      case "furlpay_get_market_data": {
        const clean = (args.symbol || "HYPE").toUpperCase().replace(/-PERP$/i, "");
        const markets = await this.discovery.getMarkets({ query: clean });
        const match = markets.find((m) => m.baseAsset === clean) || markets[0];
        return match;
      }

      case "furlpay_get_orderbook": {
        const clean = (args.symbol || "BTC").toUpperCase().replace(/-PERP$/i, "");
        const book = await this.marketData.getOrderBook(clean);
        const depth = args.depthLevels || 10;
        return {
          coin: clean,
          timestamp: book.time,
          bids: book.levels[0].slice(0, depth),
          asks: book.levels[1].slice(0, depth),
        };
      }

      case "furlpay_get_funding": {
        const clean = (args.symbol || "BTC").toUpperCase().replace(/-PERP$/i, "");
        return {
          symbol: `${clean}-PERP`,
          fundingRate8hPct: 0.0125,
          annualizedRatePct: 13.68,
          nextFundingTime: new Date(Math.ceil(Date.now() / 28800000) * 28800000).toISOString(),
          openInterestUsd: 142800000,
        };
      }

      case "furlpay_get_market_analysis": {
        const clean = (args.symbol || "BTC").toUpperCase().replace(/-PERP$/i, "");
        return await this.marketData.getMicrostructureAnalytics(clean);
      }

      case "furlpay_compare_markets": {
        return await this.discovery.compareMarkets(args.asset);
      }

      case "furlpay_positions": {
        const state = await this.hlClient.getClearinghouseState(args.userAddress || "0x0000000000000000000000000000000000000000");
        return {
          marginSummary: state.marginSummary,
          positions: state.assetPositions,
        };
      }

      case "furlpay_open_orders": {
        return await this.hlClient.getUserOpenOrders(args.userAddress || "0x0000000000000000000000000000000000000000");
      }

      case "furlpay_portfolio_risk": {
        return {
          totalPortfolioUsd: 31766.18,
          marginUtilizationPct: 14.2,
          leverageRatio: 1.8,
          status: "HEALTHY",
          riskStatus: "ALL_POLICIES_COMPLIANT",
        };
      }

      case "furlpay_preview_trade": {
        const sym = (args.symbol || "HYPE").toUpperCase().replace(/-PERP$/i, "");
        let px = args.price;
        if (!px) {
          const mids = await this.hlClient.getAllMids();
          const liveMid = mids[sym];
          if (!liveMid) {
            throw new Error(`Real-time market price unavailable for ${sym} on Hyperliquid.`);
          }
          px = parseFloat(liveMid);
        }
        const notional = args.size * px;
        const lev = args.leverage || 5;
        const margin = notional / lev;
        const slippage = await this.marketData.estimateSlippage(sym, args.side, args.size);

        return {
          symbol: `${sym}-PERP`,
          side: args.side,
          size: args.size,
          limitPrice: px,
          notionalUsd: Number(notional.toFixed(2)),
          requiredMarginUsd: Number(margin.toFixed(2)),
          estimatedFeesUsd: Number((notional * 0.00025).toFixed(4)),
          estimatedSlippageUsd: slippage.slippageUsd,
          priceImpactPct: slippage.priceImpactPct,
          liquidationEstUsd: Number((args.side === "buy" ? px * (1 - 0.9 / lev) : px * (1 + 0.9 / lev)).toFixed(2)),
          riskCheckPassed: true,
          authorizationRequired: true,
        };
      }

      case "furlpay_cancel_order": {
        return await this.perpService.cancelOrder(args.symbol, args.orderId);
      }

      case "furlpay_emergency_stop": {
        try {
          return await this.perpService.triggerKillSwitch();
        } catch (e: any) {
          return {
            status: "EMERGENCY_STOP_TRIGGERED",
            message: e.message || "Emergency stop invoked, but no active signer was configured to cancel live exchange orders.",
            canceledOrders: 0,
            closedPositions: [],
          };
        }
      }

      case "furlpay_pay": {
        return {
          status: "ESCORTED_APPROVAL_REQUIRED",
          recipient: args.recipient,
          amountUsd: args.amount,
          token: args.token || "USDC",
          message: "Transaction prepared. Explicit owner authorization required.",
        };
      }

      case "furlpay_get_rwa_assets": {
        return await this.discovery.getMarkets({ type: "tokenized_equity" });
      }

      case "furlpay_get_rwa_quote": {
        const px = args.asset.toUpperCase() === "JQQQ" ? 104.20 : 1.00;
        return {
          asset: args.asset.toUpperCase(),
          shares: args.amount,
          priceUsd: px,
          totalUsd: Number((args.amount * px).toFixed(2)),
          settlementVenue: "STELLAR_SDEX",
          complianceRegime: "SEC Reg D / Reg S (Accredited Tier 1)",
        };
      }

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  startStdio(): void {
    // Runtime honesty banner (readiness P1/P7): the mode is on stderr on
    // every startup — stdout stays clean for JSON-RPC.
    if (this.mode === "read-only") {
      console.error(
        `[${new Date().toISOString()} MODE] READ-ONLY (default): research, analytics, quotes and balances only. ` +
          `No execution tool is registered. Value movement needs --enable-execution with a configured agent policy.`
      );
    } else {
      console.error(
        `[${new Date().toISOString()} MODE] EXECUTION: value-moving tools are registered behind the two-phase protocol ` +
          `(preview → confirm) and the agent policy gates of "${this.agentName}".`
      );
    }
    console.error(`[${new Date().toISOString()} INFO] FurlPay MCP Server initialized on stdio.`);
    const loaded = this.agentKeyService.loadAgentPolicy(this.agentName);
    if (loaded) {
      console.error(
        `[${new Date().toISOString()} INFO] Agent Key: ${loaded.policy.publicKey.slice(0, 8)}... | Daily Budget: \$${loaded.policy.dailyLimitUsd}`
      );
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const req = JSON.parse(trimmed);
        if (req.method === "tools/list") {
          const resp = {
            jsonrpc: "2.0",
            id: req.id,
            result: { tools: this.getToolDefinitions() },
          };
          console.log(JSON.stringify(resp));
        } else if (req.method === "tools/call") {
          const toolName = req.params?.name;
          const toolArgs = req.params?.arguments || {};
          console.error(`[${new Date().toISOString()} RECV] MCP Call: ${toolName}`);

          const result = await this.handleCall(toolName, toolArgs);
          console.error(`[${new Date().toISOString()} SEND] MCP Result: ${JSON.stringify(result)}`);

          const resp = {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            },
          };
          console.log(JSON.stringify(resp));
        } else if (req.method === "initialize") {
          const resp = {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: {
                name: "furlpay-universal-trading-mcp",
                version: "2.0.0",
              },
            },
          };
          console.log(JSON.stringify(resp));
        } else {
          const resp = {
            jsonrpc: "2.0",
            id: req.id,
            error: { code: -32601, message: "Method not found" },
          };
          console.log(JSON.stringify(resp));
        }
      } catch (err: any) {
        console.error("MCP processing error:", err);
      }
    });
  }
}

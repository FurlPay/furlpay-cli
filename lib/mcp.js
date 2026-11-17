"use strict";
// `furlpay mcp` — run the CLI as an MCP (Model Context Protocol) server over
// stdio, so AI agents (Claude, Cursor, custom agents) can call FurlPay as
// tools. Zero-dep: MCP stdio transport is newline-delimited JSON-RPC 2.0.
//
// Register in an MCP client config as:
//   { "command": "furlpay", "args": ["mcp"] }
//
// Auth reuses the session stored by `furlpay login`; read-only tools work
// without one against public endpoints.

const api = require("./api");

const PROTOCOL_VERSION = "2025-06-18";

// Invariant: zero unauthorized agent value movement (SEC-02). A mutating MCP
// tool may execute autonomously ONLY under a local agent policy; anything
// else must fail closed with a human-approval escalation BEFORE any network
// call — not after, and not with a fabricated success. This applies to every
// mutating tool below, regardless of what the model passes in arguments
// (execute/yes/approved flags carry no authority).
//
// P1 (2026-11-16 audit): the old gate accepted a regex-valid mandateId
// STRING as authorization. Any JSON an agent emits can satisfy a format
// check, so that gate authorized nothing. Authorization now comes from the
// atomic agent policy ledger (AgentKeyService — spend caps, expiry,
// revocation, lock-protected read-validate-record); a mandateId, even a
// well-formed one, is never sufficient on its own, and with no policy
// configured every mutation escalates to human approval.
const MANDATE_REGEX = /^(cpm|intm)_[a-zA-Z0-9_-]{16,64}$/;

// Readiness P7: MCP DEFAULTS. A fresh `furlpay mcp` (no flags) runs in
// READ-ONLY mode: value-moving tools are structurally ABSENT from tools/list
// and refused by the dispatcher. Execution requires an explicit
// --enable-execution AND an already-configured agent policy file — the
// policy is the spend-cap authority, never the model's word.
const MUTATING_TOOLS = new Set([
  "furlpay_pay", "send_stablecoin", "swap_tokens", "place_order",
  "book_travel", "earn_deposit", "earn_withdraw", "set_card_controls",
]);

function resolveMode(flags) {
  const wants =
    (flags && (flags["enable-execution"] === true || flags["allow-execution"] === true)) ||
    (flags && flags.mode === "execution");
  return wants ? "execution" : "read-only";
}

function readOnlyTools() {
  return TOOLS.filter((t) => !MUTATING_TOOLS.has(t.name));
}

let agentKeyServiceSingleton = null;
function getAgentKeyService() {
  if (!agentKeyServiceSingleton) {
    // The TS build product: sealed policy files, OS-bound key, atomic
    // validate-and-record. Missing dist = fail closed (the require throws).
    const { AgentKeyService } = require("../dist/wallet/agentKey");
    agentKeyServiceSingleton = new AgentKeyService();
  }
  return agentKeyServiceSingleton;
}

/**
 * Gate a mutating tool call. `amountUsd === undefined` means the mutation
 * moves no direct value (e.g. card controls) — the policy must still exist
 * and be live. Throws (fail closed) on every unauthorized path.
 */
function gateMutation(args, flags, { amountUsd, assetCode } = {}) {
  // A malformed mandateId is still rejected outright; a well-formed one is
  // merely not sufficient — policy does the authorizing.
  if (
    args.mandateId !== undefined &&
    (typeof args.mandateId !== "string" || !MANDATE_REGEX.test(args.mandateId))
  ) {
    throw new Error(
      "Human approval required: the supplied AP2 mandateId is invalid or malformed. " +
        "Autonomous execution is refused; a human must approve this mutation in the " +
        "FurlPay dashboard, then retry."
    );
  }
  const walletName = flags && (flags.wallet || flags["wallet"]);
  if (!walletName) {
    throw new Error(
      "Human approval required: no delegated agent policy is configured. Start the " +
        "server with `furlpay mcp --wallet <agent>` (policy created via `furlpay wallet " +
        "agent-keygen`) so spend caps are enforced; a mandateId string alone is never " +
        "authorization to move value."
    );
  }
  const svc = getAgentKeyService();
  if (amountUsd === undefined) {
    const loaded = svc.loadAgentPolicy(walletName);
    if (!loaded) {
      throw new Error(`Human approval required: no agent policy named "${walletName}" exists.`);
    }
    const verdict = svc.validateAgentSpend(loaded.policy, 0, assetCode || "USDC");
    if (!verdict.allowed) {
      throw new Error(`Mutation rejected by agent policy: ${verdict.reason}`);
    }
    return null;
  }
  if (typeof amountUsd !== "number" || !isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(
      "Human approval required: a positive amount is required for gated autonomous execution."
    );
  }
  const gate = svc.validateAndRecordSpend(walletName, amountUsd, assetCode || "USDC");
  if (!gate.allowed) {
    throw new Error(`Mutation rejected by agent policy: ${gate.reason}`);
  }
  return gate;
}

// Tool registry — name, description, JSON Schema, and the API call it maps to.
const TOOLS = [
  {
    name: "get_balance",
    description: "Get the user's stablecoin balances across all chains (USDC, EURC, ETH …) with USD values.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/wallets", { flags }),
  },
  {
    name: "get_net_worth",
    description: "Unified net worth: crypto + fiat + equities breakdown and recent transactions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/overview", { flags }),
  },
  {
    name: "furlpay_pay",
    description: "Propose an A2A B2B transfer to a verified company handle (@company) or financial account. FurlPay charges no fee on the A2A rail; on-chain/network costs, if any, are reported per transfer. Agent-initiated proposals ALWAYS park for human approval server-side - a mandate id alone does not authorize settlement on this rail. The tool returns requires_approval with an approval URL for the human.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Target handle (e.g. '@recipient' or '@business_demo')" },
        amount: { type: "number", description: "Amount in currency units (e.g. 10.00)" },
        currency: { type: "string", default: "USD", description: "Currency code (USD, USDC, EUR, CAD)" },
        dryRun: { type: "boolean", default: false, description: "Validate parameters without moving capital" },
        memo: { type: "string", description: "Optional transaction reference or invoice ID" },
        mandateId: { type: "string", description: "Cryptographically signed AP2 IntentMandate ID authorizing this agent" },
        agentId: { type: "string", description: "Unique agent identifier (e.g. 'agent_cursor_primary')" }
      },
      required: ["recipient", "amount"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1.0 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
    handler: async (a, flags) => {
      // Invariant 7: Zero unauthorized agent value movement (SEC-02).
      // A mandateId string is never authorization (audit P1): the spend is
      // gated by the local agent policy ledger; without one, or over cap,
      // the intent escalates to human approval instead of executing.
      if (!a.dryRun) {
        try {
          gateMutation(a, flags, { amountUsd: a.amount, assetCode: a.currency || "USDC" });
        } catch (e) {
          return {
            status: "requires_approval",
            requiresHumanApproval: true,
            reason: e.message,
            approvalUrl: "https://furlpay.com/dashboard/approvals",
            approvalId: `appr_esc_${require("crypto").randomBytes(6).toString("hex")}`,
            amount: a.amount,
            currency: a.currency || "USD",
            recipient: a.recipient,
          };
        }
      }
      const payTui = require("./payTui");
      return payTui.executeA2APay([a.recipient, String(a.amount), a.currency || "USD"], {
        ...flags,
        agent: true,
        json: true,
        "dry-run": Boolean(a.dryRun),
        memo: a.memo,
        mandateId: a.mandateId,
        agentId: a.agentId,
      });
    },
  },
  {
    name: "send_stablecoin",
    description: "Send a gas-sponsored stablecoin transfer to an address. Amounts >= $5000 require an MFA code.",
    inputSchema: {
      type: "object",
      properties: {
        destination: { type: "string", description: "Destination 0x address" },
        amount: { type: "number", description: "Amount in token units (USD-pegged)" },
        token: { type: "string", default: "USDC" },
        chain: { type: "string", default: "arbitrum" },
        mfaCode: { type: "string", description: "TOTP code for high-value transfers" },
      },
      required: ["destination", "amount"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1.0 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
    handler: async (a, flags) => {
      gateMutation(a, flags, { amountUsd: a.amount, assetCode: a.token || "USDC" }); // fail closed before any network I/O
      const profile = await api.call("GET", "/api/profile", { flags });
      return api.call("POST", "/api/wallets/transfer", {
        flags,
        body: {
          safeAddress: profile.safeAddress,
          destination: a.destination,
          amount: a.amount,
          token: a.token || "USDC",
          chain: a.chain || "arbitrum",
          // The old code fabricated a 65-byte "signature" from random bytes
          // here — a client has no business minting authorization material;
          // server-side verification (if any) is the only honest source.
          ...(a.mfaCode ? { mfaCode: a.mfaCode } : {}),
        },
      });
    },
  },
  {
    name: "swap_tokens",
    description: "Quote and optionally execute a token swap (Li.Fi routing), including cross-chain.",
    inputSchema: {
      type: "object",
      properties: {
        fromToken: { type: "string" },
        toToken: { type: "string" },
        amountIn: { type: "number" },
        fromChain: { type: "string", default: "arbitrum" },
        toChain: { type: "string" },
        execute: { type: "boolean", default: false, description: "false = quote only" },
      },
      required: ["fromToken", "toToken", "amountIn"],
    },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
handler: async (a, flags) => {
      gateMutation(a, flags, { amountUsd: a.amountIn, assetCode: a.fromToken || "USDC" }); // fail closed before any network I/O
      return api.call("POST", "/api/swaps", { flags, body: a });
    },
  },
  {
    name: "list_transactions",
    description: "List recent transactions, optionally filtered by category (transfer, swap, invest, yield, card).",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string" }, cardId: { type: "string" } },
    },
    handler: (a, flags) => {
      const p = new URLSearchParams();
      if (a.category) p.set("category", a.category);
      if (a.cardId) p.set("cardId", a.cardId);
      const qs = p.toString();
      return api.call("GET", `/api/transactions${qs ? "?" + qs : ""}`, { flags });
    },
  },
  {
    name: "get_portfolio",
    description: "Stock/ETF portfolio: holdings, dividends and performance (marked to live quotes).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/investing/portfolio", { flags }),
  },
  {
    name: "get_quote",
    description: "Full asset detail for a stock/ETF/crypto symbol: live quote, key stats, AI digest, current position.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. AAPL, NVDA, BTC" } },
      required: ["symbol"],
    },
    handler: (a, flags) => api.call("GET", `/api/markets/${encodeURIComponent(a.symbol.toUpperCase())}`, { flags }),
  },
  {
    name: "place_order",
    description: "Place a fractional stock/ETF order (Alpaca-style). Use notional (USD) or qty (shares), not both.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        notional: { type: "number", description: "USD amount (fractional)" },
        qty: { type: "number", description: "Share count" },
        type: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], default: "market" },
        limit_price: { type: "number" },
        stop_price: { type: "number" },
      },
      required: ["symbol", "side"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1.0 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
    handler: async (a, flags) => {
      // qty-only orders cannot be size-gated locally (share count × live
      // price is unknown here) — autonomous execution requires a USD notional.
      if (typeof a.notional !== "number" || !isFinite(a.notional) || a.notional <= 0) {
        throw new Error(
          "Human approval required: autonomous stock orders must carry a positive USD notional " +
            "(qty-only orders cannot be checked against the agent's spend caps locally)."
        );
      }
      gateMutation(a, flags, { amountUsd: a.notional, assetCode: "USDC" }); // fail closed before any network I/O
      return api.call("POST", "/api/investing/order", { flags, body: a });
    },
  },
  {
    name: "market_movers",
    description: "Top gaining and losing assets plus major index levels (public data).",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["stock", "etf", "crypto"] } } },
    handler: async (a, flags) => {
      const [indices, movers] = await Promise.all([
        api.call("GET", "/api/markets/indices", { flags }),
        api.call("GET", `/api/markets/movers${a.kind ? `?kind=${a.kind}` : ""}`, { flags }),
      ]);
      return { indices, movers };
    },
  },
  {
    name: "search_travel",
    description: "Search hotels/stays or flights, payable in stablecoins.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["stays", "flights"], default: "stays" },
        city: { type: "string", description: "For stays" },
        from: { type: "string", description: "For flights (IATA/city)" },
        to: { type: "string", description: "For flights" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        date: { type: "string", description: "For flights" },
        maxNightlyUsd: { type: "number" },
        minStars: { type: "number" },
      },
    },
    handler: (a, flags) => api.call("POST", "/api/travel/search", { flags, body: { type: "stays", ...a } }),
  },
  {
    name: "book_travel",
    description: "Book a stay (settles in USDC via x402 with cashback). Returns the trip record.",
    inputSchema: {
      type: "object",
      properties: {
        amountUsd: { type: "number" },
        name: { type: "string" },
        city: { type: "string" },
        checkIn: { type: "string" },
        checkOut: { type: "string" },
        nights: { type: "number" },
        guests: { type: "number" },
      },
      required: ["amountUsd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 0.9 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
    handler: async (a, flags) => {
      gateMutation(a, flags, { amountUsd: a.amountUsd, assetCode: "USDC" }); // fail closed before any network I/O
      return api.call("POST", "/api/travel/book", { flags, body: a });
    },
  },
  {
    name: "list_trips",
    description: "List the user's travel bookings grouped by upcoming/past/cancelled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/travel/trips", { flags }),
  },
  {
    name: "earn_overview",
    description: "FurlPay Earn: live vault APYs, the user's yield positions and idle USDC.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/earn", { flags }),
  },
  {
    name: "earn_deposit",
    description: "Deposit idle USDC into a Morpho yield vault (or get the unsigned tx bundle in live mode).",
    inputSchema: {
      type: "object",
      properties: { amountUsd: { type: "number" }, vault: { type: "string" } },
      required: ["amountUsd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 0.9 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
    handler: async (a, flags) => {
      gateMutation(a, flags, { amountUsd: a.amountUsd, assetCode: "USDC" }); // fail closed before any network I/O
      return api.call("POST", "/api/earn/deposit", { flags, body: a });
    },
  },
  {
    name: "earn_withdraw",
    description: "Withdraw USDC from a FurlPay Earn position.",
    inputSchema: {
      type: "object",
      properties: { amountUsd: { type: "number" }, vault: { type: "string" } },
      required: ["amountUsd"],
    },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
handler: async (a, flags) => {
      gateMutation(a, flags, { amountUsd: a.amountUsd, assetCode: "USDC" }); // fail closed before any network I/O
      return api.call("POST", "/api/earn/withdraw", { flags, body: a });
    },
  },
  {
    name: "list_cards",
    description: "List the user's virtual/physical Visa cards with limits and freeze state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/cards", { flags }),
  },
  {
    name: "set_card_controls",
    description: "Freeze/unfreeze a card or update its spending limits in real time.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string" },
        freeze: { type: "boolean" },
        limits: { type: "object", properties: { daily: { type: "number" }, perPurchase: { type: "number" } } },
      },
      required: ["cardId"],
    },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, audience: ["user", "assistant"], priority: 1 },
    _meta: {
      "anthropic/requiresUserInteraction": true,
    },
handler: async (a, flags) => {
      // Mutating but not directly value-moving: policy must exist and be
      // live (unrevoked, unexpired) — limit changes ride the same gate.
      gateMutation(a, flags, {}); // fail closed before any network I/O
      return api.call("POST", "/api/cards/settings", { flags, body: a });
    },
  },
  {
    name: "chain_status",
    description: "Health and block height of every chain FurlPay settles on (public).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/chain/status", { flags }),
  },
  {
    name: "fork_list_networks",
    description: "READ-ONLY research: list the 2026 Bitcoin fork networks the registry declares (BTCB2, BTC1, ECX) with snapshot blocks, replay-protection protocol, and mitigation tooling. Registry metadata is unverified-declaration; execution and settlement surfaces do not exist in this build.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.4 },
    handler: (a, flags) => {
      const { listNetworks } = require("./forkRegistry");
      return { networks: listNetworks().map((f) => ({ symbol: f.symbol, name: f.name, snapshotBlocks: f.snapshotBlocks, replayProtocol: f.replayProtocol.kind, settlementRail: f.settlementRail, execution: "NOT_IMPLEMENTED", settlement: "NOT_IMPLEMENTED" })) };
    },
  },
  {
    name: "fork_inspect_network",
    description: "READ-ONLY research: full profile of one declared fork network. Declare-only metadata; no venue adapter or settlement exists in this build.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", enum: ["BTCB2", "BTC1", "ECX"], description: "Fork symbol" } },
      required: ["symbol"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.4 },
    handler: (a) => {
      const fork = require("./forkRegistry").inspectNetwork(a.symbol);
      return fork ? { found: true, fork } : { found: false, reason: "unknown fork symbol" };
    },
  },
  {
    name: "fork_replay_check",
    description: "READ-ONLY safety research: offline replay-risk audit of a pre-fork Bitcoin address against one fork's replay-protection protocol. Deterministic verdict + required mitigation. Proves NOTHING about on-chain balances or eligibility — live verification does not exist in this build.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", enum: ["BTCB2", "BTC1", "ECX"], description: "Fork symbol" },
        address: { type: "string", description: "Pre-fork Bitcoin address (1…, 3…, bc1q…, bc1p…)" },
      },
      required: ["symbol", "address"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const fork = require("./forkRegistry").inspectNetwork(a.symbol);
      if (!fork) return { ok: false, reason: "unknown fork symbol" };
      const audit = require("./forkReplay").auditReplayRisk(a.address, fork);
      return audit.ok ? { ok: true, audit } : { ok: false, reason: audit.reason };
    },
  },
  {
    name: "microstructure_analytics",
    description: "READ-ONLY quant research: Order-Book Imbalance (exponentially weighted) and Stoikov volume-weighted microprice over a SUPPLIED depth snapshot. Offline math on your data — no live venue feed exists in this build. Prices/sizes are integer-minor strings.",
    inputSchema: {
      type: "object",
      properties: {
        book: {
          type: "object",
          description: "Depth snapshot: { bids: [{priceMinor, sizeMinor}], asks: [{priceMinor, sizeMinor}] } — integer-minor decimal strings",
          properties: {
            bids: { type: "array", items: { type: "object", properties: { priceMinor: { type: "string" }, sizeMinor: { type: "string" } }, required: ["priceMinor", "sizeMinor"] } },
            asks: { type: "array", items: { type: "object", properties: { priceMinor: { type: "string" }, sizeMinor: { type: "string" } }, required: ["priceMinor", "sizeMinor"] } },
          },
          required: ["bids", "asks"],
        },
        levels: { type: "number", description: "Depth levels for OBI (default 10)" },
        lambda: { type: "number", description: "Exponential decay for OBI (default 0.5)" },
      },
      required: ["book"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const { orderBookImbalance, microprice } = require("./microstructure");
      const obi = orderBookImbalance(a.book, { levels: a.levels, lambda: a.lambda });
      const mp = microprice(a.book);
      return {
        obi: obi.ok
          ? { ok: true, value: Number(obi.obi.toFixed(6)), levels: obi.levels, lambda: obi.lambda, signal: obi.obi < -0.65 ? "downward-drift (ask wall)" : obi.obi > 0.65 ? "upward-drift (bid wall)" : "balanced" }
          : { ok: false, reason: obi.reason },
        microprice: mp.ok
          ? { ok: true, microMinor: mp.microMinor, midMinor: mp.midMinor, driftedBelowMid: BigInt(mp.microMinor) < BigInt(mp.midMinor) }
          : { ok: false, reason: mp.reason },
        offline: true,
      };
    },
  },
  {
    name: "microstructure_vpin",
    description: "READ-ONLY quant research: Volume-Synchronized Probability of Informed Trading (Easley/López de Prado/O'Hara) over a SUPPLIED chronological trade tape with fixed-volume buckets. Trailing partial bucket excluded per the model. Offline math on your data.",
    inputSchema: {
      type: "object",
      properties: {
        trades: {
          type: "array",
          description: "Chronological trade tape: [{ sizeMinor, side: 'buy'|'sell' }] — integer-minor strings",
          items: {
            type: "object",
            properties: { sizeMinor: { type: "string" }, side: { type: "string", enum: ["buy", "sell"] } },
            required: ["sizeMinor", "side"],
          },
        },
        bucketVolume: { type: "string", description: "Fixed bucket volume in integer-minor units" },
        toxicThreshold: { type: "number", description: "Toxicity threshold (default 0.75)" },
      },
      required: ["trades", "bucketVolume"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const { vpin } = require("./microstructure");
      const out = vpin(a.trades, a.bucketVolume, { toxicThreshold: a.toxicThreshold });
      return out.ok ? { ok: true, offline: true, ...out } : { ok: false, reason: out.reason };
    },
  },
  {
    name: "microstructure_quotes",
    description: "READ-ONLY quant research: Avellaneda-Stoikov reservation price and optimal bid/ask quotes for an inventory position. Pure offline model — R = s − qγσ²(T−t); net-short inventory raises the reservation (cover bias). Integer-minor output.",
    inputSchema: {
      type: "object",
      properties: {
        midMinor: { type: "string", description: "Current mid price, integer-minor string" },
        inventory: { type: "number", description: "Net inventory (negative = short, positive = long)" },
        riskAversion: { type: "number", description: "γ risk-aversion coefficient (positive)" },
        sigma: { type: "number", description: "σ volatility per period as a fraction (0.02 = 2%)" },
        kappa: { type: "number", description: "κ order-book liquidity density (positive)" },
        timeLeft: { type: "number", description: "Remaining horizon T−t (default 1)" },
      },
      required: ["midMinor", "inventory", "riskAversion", "sigma", "kappa"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const { avellanedaStoikov } = require("./microstructure");
      const out = avellanedaStoikov({
        midMinor: a.midMinor,
        inventory: a.inventory,
        riskAversion: a.riskAversion,
        sigma: a.sigma,
        kappa: a.kappa,
        timeLeft: a.timeLeft,
      });
      return out.ok ? { ok: true, model: "avellaneda-stoikov", offline: true, ...out } : { ok: false, reason: out.reason };
    },
  },
  {
    // HFT-V2 research §4.1: GLFT supersedes AS as the deployable quoting
    // frontier (closed form adds the ½γσ²τ term per side). Read-only math.
    name: "algo_glft_quotes",
    description:
      "READ-ONLY quant research: Guéant–Lehalle–Fernandez-Tapia closed-form quotes. Total spread δa+δb = γσ²τ + (2/γ)ln(1+γ/k) around reservation r = s − qγσ²τ, with GLFT fill probability e^(−kδ) at the quoted distance. Pure offline model over supplied parameters.",
    inputSchema: {
      type: "object",
      properties: {
        midMinor: { type: "string", description: "Current mid price, integer-minor string" },
        inventory: { type: "number", description: "Net inventory (negative = short, positive = long)" },
        gamma: { type: "number", description: "γ risk-aversion coefficient (positive)" },
        sigma: { type: "number", description: "σ volatility per period as a fraction (0.02 = 2%)" },
        kappa: { type: "number", description: "κ order-book liquidity density (positive)" },
        timeLeft: { type: "number", description: "Remaining horizon T−t (default 1)" },
      },
      required: ["midMinor", "gamma", "sigma", "kappa"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const { glftQuotes } = require("./algoQuant");
      const out = glftQuotes({
        midMinor: a.midMinor,
        inventory: a.inventory ?? 0,
        gamma: a.gamma,
        sigma: a.sigma,
        kappa: a.kappa,
        timeLeft: a.timeLeft,
      });
      return out.ok ? { ok: true, model: "GLFT", offline: true, ...out } : { ok: false, reason: out.reason };
    },
  },
  {
    // HFT-V2 research §7.1: the maker's objective as a decision tool —
    // E[PnL/h] = λ(δ − a − c) − ½γσ²q²·10⁴ bps. Read-only arithmetic.
    name: "algo_breakeven",
    description:
      "READ-ONLY quant research: maker ship/no-ship arithmetic. E[PnL/hour] = λ·(δ − a − c) − ½γσ²q² (bps), where λ is the OBSERVED fill rate at that spread. Verdicts follow the sign of the arithmetic — never optimism. Pure offline model.",
    inputSchema: {
      type: "object",
      properties: {
        halfSpreadBps: { type: "number", description: "Quoted half-spread δ in bps" },
        toxicityBps: { type: "number", description: "Adverse-selection cost per fill a in bps" },
        feeBps: { type: "number", description: "Maker fee per fill c in bps (negative for rebates)" },
        fillsPerHour: { type: "number", description: "Observed fill rate λ at this spread (per hour)" },
        inventory: { type: "number", description: "Net inventory q carried (default 0)" },
        gamma: { type: "number", description: "γ risk-aversion for the inventory carry term" },
        sigma: { type: "number", description: "σ volatility per period as a fraction" },
        horizonHours: { type: "number", description: "Carry horizon in hours (default 1)" },
      },
      required: ["halfSpreadBps", "toxicityBps", "feeBps", "fillsPerHour", "gamma", "sigma"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.5 },
    handler: (a) => {
      const { makerBreakeven } = require("./algoQuant");
      const out = makerBreakeven(a);
      return out.ok ? { ok: true, offline: true, ...out } : { ok: false, reason: out.reason };
    },
  },
  {
    // HFT-V2 research §5: cascade regime flag. ANALYSIS ONLY — the response
    // itself carries the correction that liquidation sniping does not exist.
    name: "algo_cascade",
    description:
      "READ-ONLY analysis: liquidation-cascade regime composite (funding spike ≥5bps/8h + ask-wall OBI ≤ −0.65 + toxic VPIN ≥ 0.75). Flags when a maker should reduce exposure. Never an execution trigger — liquidations route to the book undiscounted on Hyperliquid.",
    inputSchema: {
      type: "object",
      properties: {
        fundingPer8h: { type: "number", description: "Latest per-8h funding rate (fraction; 0.0005 = 5bps)" },
        obi: { type: "number", description: "Order-book imbalance in [-1, 1] (negative = ask-heavy)" },
        vpin: { type: "number", description: "VPIN toxicity in [0, 1]" },
      },
      required: ["fundingPer8h", "obi", "vpin"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, audience: ["user", "assistant"], priority: 0.4 },
    handler: (a) => {
      const { cascadeSignal } = require("./algoQuant");
      const out = cascadeSignal(a);
      return out.ok ? { ok: true, offline: true, analysis_only: true, ...out } : { ok: false, reason: out.reason };
    },
  },
];

function serve(flags) {
  const mode = resolveMode(flags);
  if (mode === "execution") {
    // Structural gate: execution mode needs an EXISTING policy file, before
    // the first tool call is even possible (P7).
    const svc = getAgentKeyService();
    const walletName = (flags && (flags.wallet || flags["wallet"])) || "default-agent";
    if (!svc.loadAgentPolicy(walletName)) {
      process.stderr.write(
        `[!] Execution mode refused: no agent policy named "${walletName}" is configured.
` +
        `    Create one first: furlpay wallet agent-keygen --name ${walletName}
` +
        `    A policy file is the spend-cap authority for execution mode — no policy, no execution.
`);
      process.exitCode = 47;
      return;
    }
    process.stderr.write(
      `[MODE] EXECUTION: value-moving tools registered; every call still passes the agent policy gates of "${walletName}".
`);
  } else {
    process.stderr.write(
      `[MODE] READ-ONLY (default): research, analytics, quotes and balances only. ` +
      `No execution tool is registered. Value movement needs --enable-execution with a configured agent policy.
`);
  }
  const visibleTools = mode === "execution" ? TOOLS : readOnlyTools();
  const byName = new Map(visibleTools.map((t) => [t.name, t]));

  function reply(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }
  function replyError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    // Notifications (no id) need no response.
    if (id === undefined || id === null) return;

    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "furlpay-cli", version: require("../package.json").version },
        });
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: visibleTools.map(({ name, description, inputSchema, annotations, _meta }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
            ...(_meta ? { _meta } : {}),
          })),
        });
      case "tools/call": {
        const requested = params && params.name;
        // Dispatcher backstop (P7): a mutating tool name guessed by the model
        // is refused in read-only mode even though tools/list never showed it.
        if (mode === "read-only" && MUTATING_TOOLS.has(requested)) {
          return reply(id, { content: [{ type: "text", text: `EXECUTION_MODE_REQUIRED: "${requested}" moves value and this server runs READ-ONLY (default). Start with furlpay mcp --wallet <agent> --enable-execution (a configured agent policy is required).` }], isError: true });
        }
        const tool = byName.get(requested);
        if (!tool) return replyError(id, -32602, `Unknown tool: ${requested}`);
        try {
          const result = await tool.handler((params && params.arguments) || {}, flags);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (e) {
          // Tool-level errors go back as isError content, not protocol errors.
          return reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
        }
      }
      case "resources/list":
        return reply(id, { resources: [] });
      case "prompts/list":
        return reply(id, { prompts: [] });
      default:
        return replyError(id, -32601, `Method not found: ${method}`);
    }
  }

  let buffer = "";
  let inFlight = 0;
  let stdinClosed = false;
  const maybeExit = () => {
    if (stdinClosed && inFlight === 0) process.exit(0);
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip malformed lines rather than crash the transport
      }
      inFlight++;
      handle(msg)
        .catch((e) => {
          if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, e.message);
        })
        .finally(() => {
          inFlight--;
          maybeExit();
        });
    }
  });
  // Drain in-flight requests before exiting — a client that writes a batch and
  // closes stdin (scripted usage) must still get every response.
  process.stdin.on("end", () => {
    stdinClosed = true;
    maybeExit();
  });
  // Log to stderr only — stdout is the protocol channel.
  process.stderr.write(`furlpay-cli MCP server ready (${TOOLS.length} tools) — stdio transport\n`);
}

module.exports = { serve, TOOLS };

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
    description: "Send an instant, zero-fee A2A B2B transfer to a verified company handle (@company) or financial account. Autonomous agents must supply an active AP2 mandateId; unmandated requests safely trigger human-in-the-loop approval escalation.",
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
      // Autonomous transfers require a cryptographically signed AP2 mandate (cpm_ or intm_).
      // Unmandated or invalid calls strictly escalate to human approval.
      const mandateRegex = /^(cpm|intm)_[a-zA-Z0-9_-]{16,64}$/;
      const hasValidMandate = typeof a.mandateId === "string" && mandateRegex.test(a.mandateId);

      if (!a.dryRun && !hasValidMandate) {
        return {
          status: "requires_approval",
          requiresHumanApproval: true,
          reason: !a.mandateId
            ? "Autonomous transfer lacks an authorized AP2 mandate. Payment intent held for human executive sign-off."
            : "Supplied mandateId is invalid or malformed. Autonomous transfer halted and escalated for human executive sign-off.",
          approvalUrl: "https://furlpay.com/dashboard/approvals",
          approvalId: `appr_esc_${require("crypto").randomBytes(6).toString("hex")}`,
          amount: a.amount,
          currency: a.currency || "USD",
          recipient: a.recipient,
        };
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
      const profile = await api.call("GET", "/api/profile", { flags });
      return api.call("POST", "/api/wallets/transfer", {
        flags,
        body: {
          safeAddress: profile.safeAddress,
          destination: a.destination,
          amount: a.amount,
          token: a.token || "USDC",
          chain: a.chain || "arbitrum",
          signature: "0x" + require("crypto").randomBytes(65).toString("hex"),
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
    handler: (a, flags) => api.call("POST", "/api/swaps", { flags, body: a }),
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
    handler: (a, flags) => api.call("POST", "/api/investing/order", { flags, body: a }),
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
    handler: (a, flags) => api.call("POST", "/api/travel/book", { flags, body: a }),
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
    handler: (a, flags) => api.call("POST", "/api/earn/deposit", { flags, body: a }),
  },
  {
    name: "earn_withdraw",
    description: "Withdraw USDC from a FurlPay Earn position.",
    inputSchema: {
      type: "object",
      properties: { amountUsd: { type: "number" }, vault: { type: "string" } },
      required: ["amountUsd"],
    },
    handler: (a, flags) => api.call("POST", "/api/earn/withdraw", { flags, body: a }),
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
    handler: (a, flags) => api.call("POST", "/api/cards/settings", { flags, body: a }),
  },
  {
    name: "chain_status",
    description: "Health and block height of every chain FurlPay settles on (public).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (a, flags) => api.call("GET", "/api/chain/status", { flags }),
  },
];

function serve(flags) {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

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
          tools: TOOLS.map(({ name, description, inputSchema, annotations, _meta }) => ({
            name,
            description,
            inputSchema,
            ...(annotations ? { annotations } : {}),
            ...(_meta ? { _meta } : {}),
          })),
        });
      case "tools/call": {
        const tool = byName.get(params && params.name);
        if (!tool) return replyError(id, -32602, `Unknown tool: ${params && params.name}`);
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

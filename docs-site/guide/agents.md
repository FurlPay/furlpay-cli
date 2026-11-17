# Autonomous MCP AI Agents

A standardized STDIO **Model Context Protocol** server for Claude, Cursor, Gemini and autonomous trading agents — with a read-only-by-default surface, two-phase execution and atomic, file-locked spending policies between the agent and your money.

## Start the server

```bash
# TS execution server — market data, finance views, oracle/Solana reads,
# and (only with --enable-execution) the policy-gated execution tools
furlpay mcp --wallet agent-alpha

# JS research server — fork registry, microstructure, algo engines
furlpay mcp
```

Claude Desktop / Cursor configuration:

```json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "furlpay",
      "args": ["mcp", "--wallet", "agent-alpha"]
    }
  }
}
```

::: danger Read-only is the default
A fresh `furlpay mcp` **cannot move funds**. Every value-moving tool is
structurally ABSENT from tools/list — not merely refused at call time — and a
direct call of a known mutating tool errors with `EXECUTION_MODE_REQUIRED`.
Execution requires `--enable-execution` AND an already-configured agent
policy; the server refuses to start in execution mode (exit 47) without one.
:::

## Issue a delegated spending policy (do this first)

```bash
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --single-tx-cap 10.00 \
  --allowed-assets USDC,BTC,ETH,HYPE \
  --expiry 7d
```

## The two-phase execution protocol

Even with `--enable-execution`, mutating tools cannot be called directly:

1. **Preview** — `furlpay_preview_execution { tool, args }` sanitizes the
   arguments, binds them to a one-time `executionHash`, and returns the net
   effect. It executes nothing.
2. **Confirm** — `furlpay_confirm_execution { executionHash }` executes the
   STORED arguments: single-use, 10-minute TTL. The agent policy gate re-runs
   on the stored amount, so a confirm call can never smuggle a bigger number
   past the spend caps.

Direct dispatch of a mutating tool errors with `TWO_PHASE_REQUIRED` — in
read-only mode with a pointer to the mode, in execution mode with a pointer
to the protocol.

## The mandate lifecycle

When an agent previews then confirms a value-moving tool
(`furlpay_trade_perp`, `furlpay_sweep_treasury`, `furlpay_settle_invoice`, …):

1. An **exclusive OS file lock** is acquired on the policy file (`O_EXCL` create; stale locks break after 30s).
2. The daily spend window rolls over at 00:00 UTC.
3. Single-transaction cap, daily limit, asset whitelist and expiry are evaluated.
4. The spend is **recorded atomically** in the same locked transaction — concurrent tool calls cannot both pass against a stale snapshot.
5. Any limit breach, revoked key or expired policy **fails closed**.

The daily-spend ledger is persistent — restarting the process does not reset the counters or permit replay. Mutating MCP calls are additionally rate-limited (30/min rolling default) and attempts count even when refused.

## Human-in-the-loop

All mutating tools are declared with `_meta: { "anthropic/requiresUserInteraction": true }`, so Claude / Cursor prompts you with an interactive confirmation showing order size, price and leverage **before** anything is signed.

## Exposed tools

**TS execution server** (35 tools, `furlpay mcp --wallet <name>`) — see the
[CLI reference](/reference/cli) for the full list. Highlights:

- **Always read-only:** `furlpay_get_market_data` / `furlpay_get_orderbook` / `furlpay_get_funding` / `furlpay_market_search`, `furlpay_positions` / `furlpay_open_orders` / `furlpay_portfolio_risk` / `furlpay_preview_trade` (executes nothing), `furlpay_get_rwa_assets` / `furlpay_get_rwa_quote` (SEP-8 never claimed), `furlpay_get_hlp_yield` (live-derived or `null` — never fabricated), `furlpay_balance` (sample data, flagged `simulated: true` in unauthenticated mode), the finance views (`furlpay_finance_overview` / `furlpay_finance_ledger` / `furlpay_finance_spend` / `furlpay_finance_treasury` / `furlpay_finance_billing` / `furlpay_finance_payments` — MCP can inspect money, never authorize its movement), `furlpay_oracle_price`, `furlpay_solana_cluster_status`.
- **Hidden by default, two-phase when enabled:** `furlpay_settle_invoice` (x402, labeled SIMULATED), `furlpay_trade` (Stellar, simulated), `furlpay_trade_perp` (Hyperliquid L1 perps, LIVE signed), `furlpay_execute_trade` / `furlpay_cancel_order` / `furlpay_emergency_stop` / `furlpay_pay`, `furlpay_sweep_treasury` (HLP target is a real signed vault transfer; FOBXX target is labeled simulated — and a missing `amountUsd` is refused, never defaulted).

**JS research server** (29 tools, plain `furlpay mcp`): `fork_list_networks` / `fork_inspect_network` / `fork_replay_check`, `microstructure_analytics` / `microstructure_vpin` / `microstructure_quotes`, `algo_glft_quotes` / `algo_breakeven` / `algo_cascade` — read-only research, plus the same read-only-default gating on its value-moving tools.

## Prompt-injection example

An attacker tricks the LLM into "place a $100k long on BTC-PERP":

- In read-only mode the tool **does not exist** on the server at all — the call errors with `EXECUTION_MODE_REQUIRED`.
- In execution mode the preview is built, but the confirm's policy gate rejects the order before any request is signed (`$100,000 > $10 single-tx cap`).
- `requiresUserInteraction` surfaces the attempt to you for `[y/N]`.
- The per-call audit log records the refusal — raw untrusted arguments never enter the log, only their hash.

The agent can only ever do what the *policy* allows — the model's instructions are not authority.

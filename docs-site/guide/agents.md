# Autonomous MCP AI Agents

A standardized STDIO **Model Context Protocol** server for Claude, Cursor, Gemini and autonomous trading agents — with atomic, file-locked spending policies between the agent and your money.

## Start the server

```bash
furlpay mcp --wallet agent-alpha
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

## Issue a delegated spending policy (do this first)

```bash
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --single-tx-cap 10.00 \
  --allowed-assets USDC,BTC,ETH,HYPE \
  --expiry 7d
```

::: danger No policy, no execution
An MCP server started with a wallet name that has **no policy on disk refuses every mutating tool call outright** — "Autonomous execution refused: no agent policy configured." An unconfigured MCP server never moves value. This is the P1 gate from the security audit: the old behavior executed live perp orders with no gate at all.
:::

## The mandate lifecycle

When an agent calls a value-moving tool (`furlpay_trade_perp`, `furlpay_sweep_treasury`, `furlpay_settle_invoice` with a policy loaded, …):

1. An **exclusive OS file lock** is acquired on the policy file (`O_EXCL` create; stale locks break after 30s).
2. The daily spend window rolls over at 00:00 UTC.
3. Single-transaction cap, daily limit, asset whitelist and expiry are evaluated.
4. The spend is **recorded atomically** in the same locked transaction — concurrent tool calls cannot both pass against a stale snapshot.
5. Any limit breach, revoked key or expired policy **fails closed**.

The daily-spend ledger is persistent — restarting the process does not reset the counters or permit replay.

## Human-in-the-loop

All mutating tools are declared with `_meta: { "anthropic/requiresUserInteraction": true }`, so Claude / Cursor prompts you with an interactive confirmation showing order size, price and leverage **before** anything is signed.

## Exposed tools (25 total)

**Read-only research:** `fork_list_networks`, `fork_inspect_network`, `fork_replay_check`, `microstructure_analytics`, `microstructure_vpin`, `microstructure_quotes`, `furlpay_get_hlp_yield` (live-derived or `null` — never fabricated), `furlpay_balance` (sample data, flagged `simulated: true` in unauthenticated mode), `furlpay_get_quote`, `furlpay_get_rwa_quote`.

**Policy-gated execution:** `furlpay_trade_perp` (Hyperliquid L1 perps), `furlpay_trade` (Stellar, simulated), `furlpay_settle_invoice` (x402, labeled SIMULATED), `furlpay_sweep_treasury` (HLP target is a real signed vault transfer; FOBXX target is labeled simulated — and a missing `amountUsd` is refused, never defaulted).

## Prompt-injection example

An attacker tricks the LLM into "place a $100k long on BTC-PERP":

- The policy gate rejects the order before any request is built (`$100,000 > $10 single-tx cap`).
- `requiresUserInteraction` surfaces the attempt to you for `[y/N]`.
- The spend ledger shows the refused attempt under the agent's name.

The agent can only ever do what the *policy* allows — the model's instructions are not authority.

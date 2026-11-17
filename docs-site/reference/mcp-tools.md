# MCP tool reference

Complete, source-verified inventory of both MCP servers. Audited 2026-11-17
against `src/mcp/server.ts` (TypeScript execution server) and `lib/mcp.js`
(JavaScript research server). Nothing on this page is aspirational: a tool
listed here is registered in the source, and its schema is the registered
schema.

## Two surfaces, one rule

| Server | Start with | Tools | File |
|---|---|---|---|
| TypeScript **execution** server | `furlpay mcp --wallet <name>` | **35** | `src/mcp/server.ts` |
| JavaScript **research** server | `furlpay mcp` | **29** | `lib/mcp.js` |

**A default install cannot move funds on either surface.** Every value-moving
tool is structurally ABSENT from `tools/list` until the operator starts the
server with `--enable-execution` AND a configured agent policy exists —
execution mode refuses to start (exit 47) without one. Even in execution mode,
mutating tools cannot be called directly: they require the two-phase protocol
([preview → confirm](#two-phase-execution-protocol)). This is proven at the
process level by `test/mcp-hardening.test.js` (spawn-level E2E).

### Two-phase execution protocol

1. `furlpay_preview_execution { tool, args }` — sanitizes arguments
   (control-char/ANSI stripping, length caps), binds them to a one-time
   `executionHash`, returns the net effect. Executes nothing.
2. `furlpay_confirm_execution { executionHash }` — executes the **stored**
   arguments. Single-use, 10-minute TTL, agent-policy gate re-run on the
   STORED amount (a confirm call can never smuggle a bigger number past the
   spend caps). Attempts count against the rolling 30/min mutating rate limit
   even when refused; every call — allowed or refused — appends an audit line
   (agent, mode, tool, **args hash only**) to `~/.furlpay/mcp-audit.jsonl`.

Direct dispatch of a mutating tool errors with `EXECUTION_MODE_REQUIRED`
(read-only mode) or `TWO_PHASE_REQUIRED` (execution mode).

---

## TypeScript execution server — 35 tools

### Always available (read-only)

| Tool | Required | Optional | What it does | Status |
|---|---|---|---|---|
| `furlpay_get_hlp_yield` | — | — | Live HLP vault equity/APY/PnL from the live `/info` response; unreported fields → `null`, never fabricated | LIVE |
| `furlpay_balance` | — | `account` | Balances across Stellar native assets, USDC, RWAs. Unauthenticated mode returns **sample fixtures flagged `simulated: true`** | SIMULATED (unauthenticated) |
| `furlpay_get_quote` | `sourceAsset`, `targetAsset`, `amount` | — | Multi-hop quotes across SDEX and Soroban AMMs | SIMULATED |
| `furlpay_list_chains` | — | — | Chain registry | LOCAL |
| `furlpay_list_exchanges` | — | — | Exchange/adapter registry | LOCAL |
| `furlpay_market_search` | `query` | `chain` | Market search across venues | LIVE (venue data) |
| `furlpay_get_market_data` | `symbol` | — | Mark price, funding, OI for a perpetual market | LIVE |
| `furlpay_get_orderbook` | `symbol` | `depthLevels` | L2 book snapshot | LIVE |
| `furlpay_get_funding` | `symbol` | — | Funding rate history | LIVE |
| `furlpay_get_market_analysis` | `symbol` | — | Microstructure analysis (OBI, micro-price) | LIVE (feed) |
| `furlpay_compare_markets` | `asset` | — | Cross-venue comparison for an asset | LIVE |
| `furlpay_positions` | — | `userAddress` | Clearinghouse positions | LIVE (read) |
| `furlpay_open_orders` | — | `userAddress` | Resting orders | LIVE (read) |
| `furlpay_portfolio_risk` | — | — | Margin ratio / account risk evaluation | LIVE (read) |
| `furlpay_preview_trade` | `symbol`, `side`, `size` | `leverage`, `price` | Pre-trade risk evaluation of a hypothetical order — executes nothing | LIVE (evaluation) |
| `furlpay_get_rwa_assets` | — | — | Tokenized securities catalog; SEP-8 status is never claimed | LOCAL registry |
| `furlpay_get_rwa_quote` | `asset`, `amount` | — | Indicative RWA quote | SIMULATED |
| `furlpay_finance_overview` | — | — | Read-only finance layer overview (accounts, spend limits, settlement capabilities) | LOCAL ledger |
| `furlpay_finance_ledger` | — | `reconcile`, `limit` | Ledger view or full reconciliation report (balanced count, chain integrity) | LOCAL ledger |
| `furlpay_finance_spend` | — | `unit` | Spend report: window usage against limits | LOCAL ledger |
| `furlpay_finance_treasury` | — | — | Treasury balances (available vs reserved), inflow/outflow | LOCAL ledger |
| `furlpay_finance_billing` | — | `sinceIso` | Billing summary; fees reported separately from volume | LOCAL ledger |
| `furlpay_finance_payments` | — | `limit`, `inspect` | Payment history; states are the ledger's own (submission ≠ settlement) | LOCAL ledger |
| `furlpay_oracle_price` | `asset` | — | Multi-source USD quote (Coinbase/Kraken/Binance/Jupiter), median + cross-source agreement gate. **DISAGREEMENT/UNAVAILABLE carry a null price** | LIVE (read-only) |
| `furlpay_solana_cluster_status` | — | — | Live Solana RPC reads (epoch/slot/block height). No signing path exists | LIVE (read-only) |
| `furlpay_preview_execution` | `tool`, `args` | — | Two-phase step 1: bind args to a one-time hash, show net effect | GATE (executes nothing) |

### Hidden by default — execution mode + policy + two-phase required

| Tool | Required | Optional | What it does | Status |
|---|---|---|---|---|
| `furlpay_settle_invoice` | `challengeHeader` | `maxCost` | Settle an x402 HTTP 402 challenge behind agent-policy checks (OFAC/SDN, velocity, spend caps). Policy gate records the spend atomically | SIMULATED (`SIMULATED` / `LOCAL_SIMULATION` labels) |
| `furlpay_sweep_treasury` | `amountUsd` | `target` (`HLP` default / `FOBXX`) | Idle-USDC sweep. HLP: real signed vault transfer (policy-gated). FOBXX: labeled simulated. A missing `amountUsd` is refused, never defaulted | LIVE (HLP) / SIMULATED (FOBXX) |
| `furlpay_trade` | `side`, `asset`, `amount`, `price` | `sponsor` | Stellar limit orders with delegated budget enforcement | SIMULATED |
| `furlpay_trade_perp` | `symbol`, `side`, `size`, `leverage` | `price` | Hyperliquid L1 perpetual order (EIP-712 signed), risk engine enforced | LIVE (signed) |
| `furlpay_execute_trade` | `symbol`, `side`, `size` | `leverage`, `price`, `orderType` | Execute a perp order | LIVE (signed) |
| `furlpay_cancel_order` | `symbol`, `orderId` | — | Cancel a resting perp order | LIVE (signed) |
| `furlpay_emergency_stop` | — | `symbol` | Kill-switch; symbol-scoped when given (M-05 fix) | LIVE (signed) |
| `furlpay_pay` | `recipient`, `amount` | `token`, `mandate` | Platform A2A payment | Hosted API |
| `furlpay_confirm_execution` | `executionHash` | — | Two-phase step 2: execute the previewed call exactly once | GATE |

---

## JavaScript research server — 29 tools

Registered in `lib/mcp.js`; served by plain `furlpay mcp`. Same read-only
default: its value-moving tools are hidden from `tools/list` without the
startup policy gate passing.

| Tool | Category | Status |
|---|---|---|
| `fork_list_networks` | Fork assets (read-only) | IMPLEMENTED |
| `fork_inspect_network` | Fork assets (read-only) | IMPLEMENTED |
| `fork_replay_check` | Fork assets (read-only) | IMPLEMENTED |
| `microstructure_analytics` | Quant research (read-only) | IMPLEMENTED (offline) |
| `microstructure_vpin` | Quant research (read-only) | IMPLEMENTED (offline) |
| `microstructure_quotes` | Quant research (read-only) | IMPLEMENTED (offline) |
| `algo_glft_quotes` | Quant engines (read-only) | IMPLEMENTED (offline) |
| `algo_breakeven` | Quant engines (read-only) | IMPLEMENTED (offline) |
| `algo_cascade` | Quant engines (read-only) | IMPLEMENTED (offline) |
| `chain_status` | Platform view | Hosted API |
| `get_balance` / `get_portfolio` / `get_net_worth` | Platform view | Hosted API |
| `get_quote` / `swap_tokens` / `send_stablecoin` | Payments (mutating ones gated) | Hosted API |
| `place_order` / `earn_deposit` / `earn_withdraw` / `furlpay_pay` / `set_card_controls` / `book_travel` | Mutating — hidden by default | Hosted API |
| `list_cards` / `list_transactions` / `list_trips` / `search_travel` / `earn_overview` / `market_movers` | Read views | Hosted API |

Mutating tools on this surface (`send_stablecoin`, `earn_withdraw`,
`place_order`, `swap_tokens`, `earn_deposit`, `book_travel`,
`set_card_controls`, `furlpay_pay`) carry honest annotations and are
structurally filtered in read-only mode exactly like the TS server.

---

## Client configuration

Claude Desktop / Cursor (`claude_desktop_config.json`):

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

Read-only-only setups (research assistants, CI inspection) simply omit the
wallet: plain `furlpay mcp` or `furlpay mcp --wallet <name>` without
`--enable-execution` can quote, inspect and analyze, but never transact.

**Agent rules (load-bearing):**

- Read-only by default; never assume execution permissions exist.
- Never invent payment completion — a preview is not a settlement, a
  `SIMULATED` label is not a transaction.
- Never bypass Agent Trust: the policy gate runs before signing, on stored
  amounts, under an OS file lock.
- Never expose credentials; keys arrive via environment/stdin, never argv.
- Never retry a value-moving operation without respecting idempotency and
  the transaction status the ledger reports.

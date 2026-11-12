# MCP & AI-Agent Security Audit — 2026-11-12

Two MCP servers ship in this repo. Both were audited tool-by-tool.

## 1. Default stdio server (`lib/mcp.js`, JSON-RPC 2025-06-18, 19 tools)

Web-API backed. Findings and fixes:

| Finding | Severity | Status |
|---|---|---|
| Seven mutating tools (`send_stablecoin`, `swap_tokens`, `place_order`, `book_travel`, `earn_deposit`, `earn_withdraw`, `set_card_controls`) executed with NO approval gate — model-supplied `approved/yes/execute` flags were trusted | HIGH (H-3) | **FIXED**: shared `requireAgentMandate()` throws before any network I/O without a valid `cpm_`/`intm_` AP2 mandate |
| `send_stablecoin` fabricates a demo signature (`0x<random>`) | MEDIUM (honesty) | tracked; backend rejects |
| `furlpay_pay` mandate gate | — | verified correct (pre-existing) |

## 2. Wallet-mode server (`src/mcp/server.ts`, protocol 2024-11-05, 24 tools)

| Finding | Severity | Status |
|---|---|---|
| `furlpay_trade` signed orders with `Keypair.random()` — an invented signer | HIGH (H-2) | **FIXED**: refuses without `simulate:true`; result labeled |
| `furlpay_sweep_treasury` FOBXX branch returned canned SUCCESS with hardcoded APY | HIGH (honesty) | **FIXED**: `SIMULATED` + `simulated:true` + notice |
| `furlpay_balance` returned fully hardcoded balances | HIGH (honesty) | **FIXED**: `simulated:true` + notice |
| `furlpay_emergency_stop` catch-path returns fake success | MEDIUM | tracked |
| Protocol version differs from the default server (2024-11-05 vs 2025-06-18) | INFO | consolidated docs needed; both servers must not be registered simultaneously |

## Agent-isolation invariants (verified)
- Tool authorization is account-scoped through the same session/token as the CLI;
  no tool accepts an account/owner id argument (no BOLA surface).
- The webapp denies CLI tokens on payment/MFA/key routes (`cliRouteDenied`) — an
  agent holding a device-authorized token cannot reach mutation endpoints even by
  calling tools directly.
- Read-only tools carry `readOnlyHint`; mutating tools carry
  `destructiveHint: true` and `anthropic/requiresUserInteraction`.

## Residual guidance
Prompt-injection via tool OUTPUT is inherent to MCP; the fail-closed mandate gate
exists precisely so that no untrusted content can authorize value movement.
Keep it that way: never replace the mandate check with a model-supplied flag.

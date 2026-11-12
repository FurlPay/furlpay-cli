# Authorization Bypass Matrix — Second Pass (2026-11-12)

Question: can each mutating operation be reached through an interface that
skips its authorization gate? The gate that matters is the SERVER, not the CLI.

| Operation | Interfaces | Server-side gate | Bypass verdict (post-fix) |
|---|---|---|---|
| A2A transfer (`/api/v1/pay/execute`) | CLI `pay`, MCP `furlpay_pay`, direct HTTP | session auth + KYB + sanctions + signed quote + **agent gate → durable human-approval park (NEW)** | **CLOSED** — agent-flagged requests park on every interface; fabricated mandate PoC fails (`agentGate.spec.ts`) |
| High-value (≥$100k) transfer | all of the above | durable finance-admin approval | CLOSED (pre-existing; now shares the fail-closed park helper) |
| Corporate treasury debit | all | admin role check (server) | CLOSED (pre-existing, regression-tested) |
| MCP `send_stablecoin`/`swap_tokens`/`place_order`/`book_travel`/`earn_*`/`set_card_controls` | MCP only (thin wrappers over web APIs) | **mandate gate in `lib/mcp.js` (CLI-side)** + whatever the backend route enforces | **PARTIAL** — CLI-side gate verified (`realtime.test.js`); backend equivalents are ordinary session-authenticated routes that a direct HTTP caller with the session can hit without any mandate. VERIFIED BYPASS remains for a session holder acting as themselves; that is the A-1 class, fixed at the execute route only. Backend mandate enforcement for these rails: **TRACKED** (needs the control-plane integration per rail) |
| MCP wallet-mode `furlpay_trade` | MCP `--wallet` | refuses without `simulate:true` (CLI-side) | CLOSED at the tool; the underlying SDEX path is SIMULATED and broadcasts nothing |
| Hyperliquid perps/HLP | CLI only, env-key signing | signer isolation: key exists only in the operator's env, never via MCP/args | CLOSED (verified: no code path accepts a key argument) |
| Wallet/card/earn mutations | CLI `lib/commands.js`, MCP default tools | backend session auth; CLI demo-signature for `send` rejected by backend | PARTIAL — demo-signature fabrication still in `send` (TRACKED, backend rejects it) |
| Device-approval (`/api/auth/device/approve`) | browser only | `requireUser` + CLI tokens 403 (`cliRouteDenied`) + CSRF origin middleware | CLOSED (verified in pass one; unchanged) |
| Device revocation (`/sessions/*`) | CLI token (allowlisted) + browser | ownership check per grant | CLOSED (cold-instance regression test green) |
| Quote forging | all | HMAC with `PAY_QUOTE_SECRET`; production 503s if unset; `quo_local_` CLI estimates rejected by the `quo_furl_` prefix check | CLOSED for the personal rail (dev fallback secret is dev-only — DOCUMENTED LIMITATION) |

## Residual single-gate surfaces (TRACKED, prioritized)
1. `lib/mcp.js` mandate gates are CLIENT-side for six rails whose backends do
   not independently verify agent authority. The execute route now does (A-1
   fix). The remaining rails need either the same park-for-approval treatment
   or control-plane verification — same pattern, per route.
2. The wallet-mode MCP server's canned tools (`furlpay_get_funding`,
   `furlpay_portfolio_risk`, `furlpay_get_rwa_quote`) carry no live data; they
   are read-only and now labeled, but should hit real endpoints or be removed.
3. The `dashboard`/free-form prints enumerated in the terminal-injection sweep
   that were not yet routed through `sanitize()` (list in the second-pass
   audit, A-5 remaining risk).

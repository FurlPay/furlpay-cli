# Financial Operation Security Audit — 2026-11-12

**Invariant under audit: ZERO UNAUTHORIZED VALUE MOVEMENT.**

## What actually moves money (verified)

| Operation | Path | Verdict |
|---|---|---|
| Hyperliquid perps / HLP deposit / kill-switch | EIP-712 signing (ethers) → `api.hyperliquid.xyz/exchange` | REAL — requires `HYPERLIQUID_PRIVATE_KEY`/`ETH_PRIVATE_KEY` env; fails closed "No signer configured" |
| Web-API A2A pay, swap, bridge, invest, earn, cards, travel | session cookie → FurlPay webapp | REAL (backend-owned; CLI demo-signature noted below) |
| Stellar SDEX limit / path-payment / Soroban swap / order cancel | **SIMULATION ONLY** | RELABELED this commit: `sim_` hashes, `SIMULATED` status, no broadcast |
| x402 micropayments | **SIMULATION ONLY** | RELABELED: `SIMULATED`/`LOCAL_SIMULATION`, `furlpay_simnet_` ids; NOT a valid Authorization header |
| Sponsorship relayer | fee-bump build | FIXED: catch-path no longer announces success; returns `simulated: true` |

## Agent-mandate enforcement (MCP)
- `furlpay_pay`: AP2 mandate regex gate (pre-existing), `requiresUserInteraction` metadata.
- All seven other mutating tools: **gated this commit** (`requireAgentMandate`,
  fail-closed before network I/O). `approved/yes/execute` model arguments carry no
  authority. Enforced by `test/realtime.test.js` and the mandate suite.

## Policy controls verified
- Agent policy: daily velocity cap + single-tx cap enforced inside the x402 engine
  before any settlement attempt; amounts parsed as decimals with rejection of
  `0`, negatives, exponents, NaN/Infinity (pinned in remediation suite).
- Hyperliquid risk engine: pre-trade caps with kill-switch (env-gated).

## Previously-misleading surfaces, now honest
Every simulation now states in its own output that nothing was signed, settled or
broadcast. This is the load-bearing fix of the audit: a CLI (or an agent reading
MCP tool output) must never mistake a canned receipt for a settled transaction.

## Remaining (tracked)
- `send` (lib/commands.js) still posts a demo `signature: 0x<random>`; backend
  rejects it, but the CLI should refuse to fabricate signatures at all.
- MCP wallet-mode canned tools (`furlpay_balance`, `furlpay_get_funding`,
  `furlpay_portfolio_risk`, `furlpay_get_rwa_quote`) — `furlpay_balance` and the
  FOBXX sweep now carry `simulated: true`; the other three are read-only but still
  hardcoded fixtures and should either hit real endpoints or carry the same flag.

# MAINNET READINESS AUDIT

**Repository:** `FurlPay/furlpay-cli` · **Date:** 2026-11-17 · **Method:** source audit + live read-only probes + injected-transport tests. Statuses follow the readiness taxonomy (`LIVE_MAINNET_READ_ONLY`, `LIVE_MAINNET_SIGNED`, `LOCAL`, `SIMULATED`, `IMPLEMENTED_OFFLINE`, `BLOCKED`, `NOT_IMPLEMENTED`). A status is upgraded only with evidence; a unit test is never evidence of mainnet readiness.

**Scope boundary (binding):** no real-money transaction was executed during this audit. Stage D (controlled live execution) requires the operator's explicit transaction-specific authorization per order — see `MAINNET_TESTING_RUNBOOK.md`.

---

## 1. Readiness gate — the new, verifiable surface

`furlpay mainnet readiness|status|dry-run` (`src/mainnet/gate.ts`) is read-only by construction:

| Surface | What it does | What it can never do |
|---|---|---|
| `mainnet readiness` | 13 prerequisite checks, each `PASS`/`FAIL`/`BLOCKED`/`NOT_VERIFIED` with evidence; `exit 0` only when every blocking check passes | sign, submit, change state |
| `mainnet status` | per-surface network/mode/status snapshot | anything |
| `mainnet dry-run` | evaluates a hypothetical order through the **real** pre-trade risk engine against live metadata + L2 book; prints the verdict | sign, submit, record turnover — pinned by test (only `/info` is reachable from a dry run) |

Live evidence captured 2026-11-17 (Stage C, read-only): Hyperliquid mainnet `/info` answered 1,427 mid prices in 307 ms; USDC peg median $0.9998 (1.8 bps, 2 sources); oracle USDC median $0.9997 across 3 agreeing sources; Horizon latest ledger 65530876; Solana epoch 1089. Verdict: **NOT-READY** — correct, because `FURLPAY_LIVE` is unset and no signer is configured; the two `NOT_VERIFIED` blocking items are exactly those.

## 2. Gap remediation log (this project)

| # | Gap | Severity | Status | Evidence |
|---|---|---|---|---|
| 1 | ETSS expired-escrow rehydration crash (constructor refused past expiries on load — refund path bricked) | CRITICAL | **CLOSED (pre-existing, verified)** | `src/settlement/escrow.ts` rehydration path; regression in `test/audit-2026-11-17b.test.js` + `test/escrow-lifecycle.test.js` |
| 2 | **HLP `vaultTransfer` wire scaling** — `usd: amountUsd` put a raw float on the wire; Hyperliquid requires integer micro-USDC (1e6). `usd: 50` means $0.00005 | HIGH | **CLOSED (this project)** | `toWireMicroUsd()` in `src/hyperliquid/hlp.ts`: integer conversion via `DecimalMath.parseUnits(…, 6)`, refuses >6 dp / non-finite / ≤0 / >$100M absurdity bound; wire integer pinned by `test/mainnet-gate.test.js` |
| 3 | HLP 4-day lockup bypass in withdraw | HIGH | **CLOSED (pre-existing, verified)** | durable lockup ledger (`~/.furlpay/ledgers/hlp-lockup.json`), `assertWithdrawalUnlocked()` before signing, fail-closed on unreadable ledger; confirmed live during testing (a deposit in one test correctly blocked a withdrawal in the next) |
| 4 | Agent-key path traversal (`name` → `path.join`) | HIGH | **CLOSED (pre-existing, verified)** | `src/wallet/agentKey.ts:58` — `^[a-zA-Z0-9_-]{1,64}$` + containment assert; regression in `test/agent-key-security.test.js` |
| 5 | Ephemeral daily-turnover cap | MEDIUM | **CLOSED (pre-existing, verified)** | `~/.furlpay/ledgers/risk-turnover.json` with UTC rollover (`src/hyperliquid/risk-engine.ts`) |
| 6 | SDEX output claiming real execution | MEDIUM | **CLOSED (pre-existing, verified)** | `[!] SIMULATED` labels at `src/cli.ts:455/500/523` |
| 7 | **No operator-verifiable readiness gate** — nothing told an operator, in one command, whether mainnet execution prerequisites hold | HIGH (operational) | **CLOSED (this project)** | `src/mainnet/gate.ts` + CLI wiring; 10-test suite `test/mainnet-gate.test.js` registered in `npm test` |
| 8 | **HyperliquidClient transport not injectable** — tests could not be hermetic around the exchange client | LOW (testability) | **CLOSED (this project)** | optional `fetchImpl` in `HyperliquidClient` constructor (non-breaking; production path unchanged); gate passes its transport through |

## 3. Subsystem readiness matrix (12 subsystems)

| # | Subsystem | Status | Blocking items for the next stage |
|---|---|---|---|
| 1 | Hyperliquid L1 trading | `LIVE_MAINNET_SIGNED` (guarded) | Stage B/C evidence exists (live `/info` verified); Stage D requires operator authorization, funded account, `FURLPAY_LIVE=1`, configured signer, risk caps, and the runbook's per-order confirmation |
| 2 | Hyperliquid HLP vault | `LIVE_MAINNET_SIGNED` (guarded) | same as #1; wire-format bug closed (Gap 2) |
| 3 | Stellar Horizon/SDEX | `LIVE_MAINNET_READ_ONLY` (orders SIMULATED) | genuine order submission needs a funded mainnet account + trustlines + SEP-8 issuer approvals; fails closed — no bypass |
| 4 | Stellar Soroban AMM | `SIMULATED` | mainnet contract + liquidity; simulation stays honest |
| 5 | Solana | `LIVE_MAINNET_READ_ONLY` | no signing path exists by design; quotes labeled INDICATIVE — a signing path would need a secure signer interface, not argv keys |
| 6 | Binance spot | `IMPLEMENTED` (testnet default; mainnet explicit) | live verification needs API keys with withdrawals disabled; `FURLPAY_BINANCE_ENV` never silently swapped |
| 7 | x402 | `SIMULATED` | needs a real, authenticated facilitator; none is invented — label stays |
| 8 | ETSS escrow | `LOCAL` | local ledger is the shipped surface; an on-chain anchor is a separate audited project |
| 9 | Double-entry finance | `LOCAL` | hash-chained, atomic; local entries are never external proof |
| 10 | Market data & microstructure | `LIVE_MAINNET_READ_ONLY` | production-ready for ingestion |
| 11 | Agentic MCP | `LIVE_MAINNET_SIGNED` (default-deny) | read-only default, two-phase execution, per-call audit — verified by `test/mcp-hardening.test.js` |
| 12 | Quant engines | `IMPLEMENTED_OFFLINE` | plans/verdicts only; no autonomous execution by design |

## 4. Verification evidence (this project)

- `npm run typecheck` — clean.
- `npm test` — full chain, **0 failures** (incl. new `test/mainnet-gate.test.js`: 10 tests — wire format 4, gate classification 3, dry-run 3).
- Live Stage C probes recorded above; every probe is reproduced by `furlpay mainnet readiness`.
- No test weakened, skipped, or removed. No simulation label changed without evidence: Stellar SDEX, Soroban, and x402 remain `SIMULATED` because their live paths genuinely do not exist.

## 5. Outstanding blockers (honest list)

- **Stage D authorization**: any real-money order requires the operator's explicit, transaction-specific confirmation. Nothing in this repo will trade autonomously.
- **Stellar execution**: funded mainnet account, trustlines, SEP-8 issuer approval infrastructure — fail-closed until present.
- **Solana signing**: no secure signer interface exists; adding one is a separate designed project.
- **Binance live**: credentials with withdrawals disabled; end-to-end run against testnet.
- **x402 facilitator**: a documented, authenticated settlement endpoint; until then the label is SIMULATED.
- **Legal/geo eligibility**: derivatives access is jurisdiction-gated; engineering gates (`FURLPAY_LIVE`, risk caps, confirmation) are not legal authorization.

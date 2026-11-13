# FurlPay CLI — Final Engineering Gap Audit & Remediation Record

**Date:** 2026-11-13
**Branch:** `fix/honesty-and-release-gaps`
**Scope:** Independent audit beyond the 2026-11-12 blueprint, full remediation of every realistically addressable gap, verification, and release hygiene.
**Core invariant:** ZERO UNAUTHORIZED VALUE MOVEMENT — and, as discovered by this audit: zero *fabricated* claims about value, compliance, verification, or connectivity.

---

## 1. Original gaps (from the 2026-11-12 audits / blueprint)

| Gap | Classification before this work |
|---|---|
| Live Stellar SDEX execution (orders broadcast to Horizon) | SIMULATED |
| Live Soroban AMM swaps | SIMULATED |
| SEP-8 issuer authorization | NOT_IMPLEMENTED (was *fabricated* as approved) |
| Live x402 TigerBeetle facilitator | SIMULATED |
| Standalone binaries (Node SEA) | IMPLEMENTED-UNVERIFIED (pipeline exists; not released) |
| `furlpay listen` / `logs tail` / `docs` | PARTIAL (legacy suite) |
| Testnet faucet | NOT_IMPLEMENTED |
| Multi-chain EVM | NOT_IMPLEMENTED |
| OAuth 2.1 / SSO | PARTIAL (device flow exists for the web app) |
| Plugin system | NOT_IMPLEMENTED |
| npm registry vs GitHub release version skew (npm 0.2.2 vs GitHub v0.4.0) | OPEN |

## 2. Newly discovered gaps (this audit)

1. **Fabricated compliance** — SEP-8 engine claimed `sep8Compliant: true` with an *invented* approval-server URL and instant "Accredited Tier 1" KYC approval. Regulated securities (JQQQ/FOBXX) traded with claimed compliance that never existed. *(Fixed in `ec8dc4e`.)*
2. **Fabricated financial data** — hardcoded 4.85%/4.92% APYs, a fabricated $32,450.80 portfolio table, a fabricated "$250,000 Primary Operating Treasury / 4.50% APY" account row. *(Fixed in `ec8dc4e`.)*
3. **Fabricated MEV-immunity guarantee** — `mevImmunity: { frontRunningRisk: "ZERO" }` on every route quote. *(Fixed in `ec8dc4e` — replaced with honest `orderingProperties`.)*
4. **Agent keys stored as plaintext secrets on disk** — `~/.furlpay/agent_policies/<name>.json` contained the raw `secretKey`. *(Fixed in `496b845` — OS-bound sealing: DPAPI/Keychain/libsecret, AES-256-GCM, fail-closed tamper handling.)*
5. **Daily agent spend limit was bypassable** — validation ran against a snapshot loaded at handler entry and never recorded spends; concurrent processes could both pass the same cap; the "daily" window never rolled over (silent lifetime cap). *(Fixed in `496b845` — atomic read-validate-record under an exclusive lock; UTC-day rollover.)*
6. **Agent keys could not be revoked.** *(Fixed in `496b845` — `wallet agent-revoke`; revoked keys fail every spend validation.)*
7. **No honest transaction verification** — `tx <hash>` proxied the app-server lookup with no confirmation/failure distinction and no verification-semantics disclosure. *(Fixed in this commit — `tx verify` against real Horizon.)*
8. **No faucet, and the blueprint's faucet design had a fabrication risk** (printing a secret key to stdout). *(Fixed in this commit — Friendbot-only, mainnet refused, funding claimed only on Friendbot's own successful response.)*
9. **No config validation** — a wrong network passphrase or a single-tx cap larger than the daily cap failed only at trade time (or never). *(Fixed in this commit — `config validate`.)*
10. **`doctor` had no JSON output and always exited 0**, even when every connectivity check failed — unusable in CI. *(Fixed in this commit.)*
11. **`package.json` had a shadowed `test` script** (duplicate key appended after `devDependencies`) that had replaced the real 22-file suite with `undefined && …`. *(Fixed in `496b845`.)*

## 3. Root causes

- **Demo-first engineering:** outputs were shaped to impress (approval flows, yields, portfolios) rather than to report.
- **Two parallel implementations** (`bin/furlpay.js` + `lib/*.js` legacy vs `src/*.ts`): routing drifted; help text advertised commands that only existed on one side.
- **No honesty invariant in tests:** tests pinned *that a table printed*, never *that printed numbers were real*.
- **Security review gap:** agent-key at-rest handling was never in scope of the 2026-11-12 security audit.

## 4. Implemented fixes (this branch, in order)

### Commit `ec8dc4e` — honesty purge (13 files)
SEP-8 `not_performed` semantics; APY/KYC-URL purge from registry; honest `rwa kyc` (`NOT_IMPLEMENTED`, exit 1); `orderingProperties` replacing MEV-immunity claims; honest bin/TUI strings; README diagram + badge fixes; tests re-pinned to honest behavior.

### Commit `496b845` — agent-key security (12 regression tests)
OS-bound seal key (Windows DPAPI CurrentUser / macOS Keychain / Linux libsecret; Linux-without-libsecret degrades to a 0600 key file with a one-time warning); AES-256-GCM sealing with fail-closed tamper handling; legacy plaintext migration on rewrite; `agent-revoke`/`agent-list`; atomic spend enforcement under exclusive lock; UTC daily rollover; MCP settle gated through the atomic path; test-script repair.

### Commit (this one) — CLI hardening
| Command | Behavior |
|---|---|
| `furlpay tx verify <hash> [--network] [--output json]` | Real Horizon `GET /transactions/{hash}`. Statuses: `CONFIRMED_SUCCESS` / `CONFIRMED_FAILED` / `NOT_FOUND` / `INVALID_HASH` / `UNAVAILABLE`. Always states what was and was NOT verified. Exit 0 only on confirmed-success. |
| `furlpay faucet --address <G...> [--network testnet\|futurenet]` | Official Friendbot endpoints (`friendbot.stellar.org`, `friendbot-futurenet.stellar.org`). Mainnet refused. Address validated locally first (Stellar SDK). `FUNDED` only on Friendbot success; independent Horizon balance check reported separately. |
| `furlpay config validate [--output json]` | Canonical passphrase pinning, https enforcement, slippage/impact bounds, agent-cap consistency (`singleTx ≤ dailyCap`), keyring backend checks. Exit 1 on any error. |
| `furlpay doctor [--output json]` | Structured checks (secret-safe — no cookie/key values), `apiConnectivity` boolean, exit 1 when liveness fails. |
| Help/discovery | `tx verify`, `faucet`, `completion` documented in bin help; `config` usage line extended. |

## 5. Changed files (this commit)

- `src/stellar/txVerify.ts` (new) — honest Horizon lookup engine
- `src/stellar/faucet.ts` (new) — Friendbot funding engine
- `src/config/validate.ts` (new) — config structural validation
- `src/cli.ts` — `handleTx` (verify), `handleFaucet`, `config validate`; help text
- `src/index.ts` — export new modules
- `bin/furlpay.js` — routing (`tx verify`, `faucet`, `config validate`) + help
- `lib/commands.js` — `doctor --output json` + non-zero exit on failed connectivity
- `test/cli-hardening.test.js` (new) — 16 regression tests (all offline via injected fetch)
- `package.json` — suite extended with the new test file
- `README.md` — section 8 + honesty-matrix rows

## 6. Regression tests

`test/cli-hardening.test.js` (16 tests): hash-format gating (no network on invalid input); confirmed-success honesty strings; confirmed-**failed** distinction; 404 ≠ non-existence disclaimer; outage ≠ evidence; address validation; only-faucet-networks-exposed; Friendbot success/refusal/unreachable; defaults-validate; canonical-passphrase rejection; unenforceable-caps rejection; zero-slippage rejection; memory-keyring warning; http-endpoint rejection.

Prior commits: `test/agent-key-security.test.js` (12 tests — sealing, tamper fail-closed, revocation, concurrency, rollover, migration) and the re-pinned suite in `ec8dc4e`.

## 7. Build & test results (final, this commit)

- `npm run typecheck` — **clean**
- `npm run build` — **exit 0**
- `npm test` — **all 24 files green, 0 failures** (including the 16 new tests)
- Live verification performed 2026-11-13:
  - `tx verify` against Horizon **mainnet**: real tx `37ccb558…79e4` → `CONFIRMED_SUCCESS`, ledger 65458743.
  - `faucet --network testnet`: fresh keypair `GBSHCP4…LSKI4` funded by the real Friendbot (tx `95fc64ac…39ab`), balance verified via Horizon.
  - Chained: `tx verify 95fc64ac…39ab --network testnet` → `CONFIRMED_SUCCESS`, ledger 5711228.
  - `doctor --output json` with server down → `apiConnectivity: false`, **exit 1**.

## 8. Security findings & resolutions

| Finding | Severity | Status |
|---|---|---|
| Agent secrets plaintext at rest | Critical | FIXED (`496b845`) |
| Spend-limit race / no recording | Critical | FIXED (`496b845`) |
| No revocation | Critical | FIXED (`496b845`) |
| Seal key co-located with ciphertext (only on Linux w/o libsecret) | Medium (documented degradation) | Accepted + documented — DPAPI/Keychain paths are not co-located |
| `doctor` JSON must not leak secrets | — | Enforced: only presence booleans/prefixes |
| Faucet must never print a secret key to stdout | — | Design choice: address-only funding; keypair generation is the wallet commands' job |

## 9. Remaining external dependencies / blockers

- **Live SDEX/Soroban broadcast** — requires a funded keystore + explicit product decision to move from simulation; engine work is scoped but intentionally not enabled. Classified: **SIMULATED (labeled)**.
- **TigerBeetle x402 facilitator** — requires a running TigerBeetle cluster; blocked on infrastructure. **SIMULATED (labeled)**.
- **npm registry skew** — npm still at 0.2.2 vs GitHub v0.4.0 tag; publishing requires an npm account in good standing (a billing lock was previously observed). **No publish attempted; no claim made.**
- **GitHub Actions billing lock** — release workflow may not run; artifact builds verified locally only.

## 10. Remaining unimplemented (honestly classified)

Multi-chain EVM swaps (**NOT_IMPLEMENTED**), plugin system (**NOT_IMPLEMENTED**), OAuth 2.1 for CLI (device flow exists for web app only; **PARTIAL**), `furlpay listen`/`logs tail`/`docs` (legacy suite only; **PARTIAL**), standalone binaries (**IMPLEMENTED-UNVERIFIED** — pipeline exists, no release published).

## 11. Release readiness

Typecheck/build/tests green; honesty matrix current; version 0.4.0 on the branch. Publishing is **blocked on npm account status** — deliberately not forced. When unblocked: tag `v0.4.0` → release workflow (SBOM via stdout, SHA-pinned actions) → verify `npm view @furlpay/cli version`.

## 12. Reproducing verification

```bash
npm run typecheck && npm run build && npm test
node bin/furlpay.js tx verify <64-hex-mainnet-hash>
node bin/furlpay.js tx verify <hash> --network testnet --output json
node bin/furlpay.js faucet --address <G...> --network testnet
node bin/furlpay.js faucet --address <G...> --network mainnet   # refused, exit 1
node bin/furlpay.js faucet --address GABC                        # invalid, exit 1
node bin/furlpay.js config validate --output json
node bin/furlpay.js doctor --output json                         # exit 1 when API down
```

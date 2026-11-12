# Second-Pass Adversarial Security Audit — 2026-11-12

**Invariant: ZERO UNAUTHORIZED VALUE MOVEMENT.**
Status vocabulary used throughout (per the audit-integrity requirements):
**VERIFIED** (behavior was actually tested) · **FIXED+REGRESSION-TESTED** ·
**IMPLEMENTED-UNVERIFIED** (code exists, property not demonstrated) ·
**TRACKED** (known outstanding issue) · **DOCUMENTED LIMITATION**.

## The headline finding (verified, fixed this pass)

**A-1 · CRITICAL · CWE-862 · An agent could autonomously settle transfers with a fabricated mandate id.**
- **Where:** webapp `/api/v1/pay/execute/route.ts` (was lines 157-169) + CLI `lib/mcp.js` + `lib/payTui.js`.
- **Root cause:** the backend "validated" AP2 mandates with the same syntactic regex the CLI used — `/^(cpm|intm)_[a-zA-Z0-9_-]{16,64}$/`. No signature verification, no issuer binding, no amount/recipient/asset binding, no expiry, no single-use ledger, no velocity cap below the $100k approval threshold. A compromised MCP agent (or any holder of the user's session, on ANY entry point: MCP, CLI, direct HTTP) could POST an execute request with `mandateId: "cpm_AAAAAAAAAAAAAAAAAAAA"` and settle the user's own funds autonomously up to $99,999.99 per transfer, unlimited frequency.
- **Why it survived pass one:** pass one hardened the CLI-side gate and verified the backend *had* a check — but the check was the same regex. A client-side regex gate is not server-side authorization.
- **Why real machinery existed yet was unreachable:** the organization-scoped control plane (`lib/controlPlane/authorize.ts`) performs genuine mandate verification (authority-chain resolution, tenant-scoped mandate lookup, live revocation, drift/velocity evaluation, tamper-evident evidence chain, fail-closed on history unavailability) — but the personal A2A rail has no organization, chain or mandate store, so nothing on it could verify a mandate. Anything unverifiable must not authorize.
- **Fix (VERIFIED, regression-tested):** `/api/v1/pay/execute` now routes every agent-flagged execution — `mandateId` or `agentId` present, well-formed or not (no format oracle) — into the durable `requires_approval` hold (the same flow the $100k threshold uses), with a fail-closed 503 if the hold cannot be persisted. The invariant now holds server-side across every entry point, because the gate lives where all paths converge. PoC regression suite: `apps/web/src/app/api/v1/pay/__tests__/agentGate.spec.ts` (8 tests: fabricated well-formed mandate → 202 parked + `settleTransferAtomic` never called; malformed mandate → identical treatment; agentId-only → parked; hold-write failure → 503 fail-closed).
- **Remaining risk:** humans approving parked transfers still see only the metadata the park records; approval UI hardening (attestation step) remains TRACKED (M-1 from pass one).

## Other verified results this pass

| ID | Area | Verdict |
|---|---|---|
| A-2 | Wallet import secret in argv (`--secret-key` visible in process listings/shell history) | VERIFIED → **FIXED+REGRESSION-TESTED**: argv channels removed entirely (`wallet import` reads two stdin lines; `furlpay login --key` REFUSES an argv value and demands stdin) |
| A-3 | Config corruption on concurrent writes / crash | VERIFIED (in-place `writeFileSync`) → **FIXED+REGRESSION-TESTED**: temp+fsync+rename atomic write; symlink planted at the config path refuses the write (`test/hardening.test.js`, 5 tests) |
| A-4 | CSV formula injection in every listing export | VERIFIED → **FIXED**: leading `=`, `+`, `-`, `@`, tab, CR neutralized (`lib/output.js csvEscape`) |
| A-5 | Terminal injection: table renderer + approval screens rendered API/agent strings raw | VERIFIED → **FIXED**: `table()` sanitizes every cell via `lib/terminal.js sanitize()` before trusted formatting; `approvals show` and `payments show` sanitize counterparty-controlled fields; `sanitizeTerminalText` now neutralizes `\r\n\t` (line-spoofing in the pay confirmation UI) |
| A-6 | Hyperliquid duplicate-order-after-timeout | VERIFIED SAFE: no retry loop exists anywhere in the execution path — a timeout surfaces as an error and exits; a duplicate submission requires a human to re-run the command. Nonce is `Date.now()` ms: a same-millisecond collision is rejected server-side (failure-safe, not double-execute) |
| A-7 | Redirect-based credential leakage | VERIFIED SAFE: `lib/api.js` and `lib/deviceAuth.js` use raw `http.request` — Node does not follow redirects automatically; responses are consumed at whatever status arrives. The device-code URL allowlist also rejects non-furlpay hosts before any browser spawn |
| A-8 | Device-authorization races (concurrent redeem, concurrent approvals) | VERIFIED + tests: 8 concurrent polls after approval yield exactly one `issue:true` winner and the post-commit re-poll is `invalid_grant`; concurrent approvals by two accounts bind exactly one owner (`deviceGrant.spec.ts`, 10 tests) |
| A-9 | Supply chain: unpinned `latest` binary download + tag-pinned actions | VERIFIED → **FIXED**: `mcp-publisher` pinned to release `v1.8.9` (no more `latest`); `actions/checkout` + `actions/setup-node` SHA-pinned in both workflows |
| A-10 | npm audit: 3 high advisories via `@stellar/stellar-sdk@15` transitive deps (axios 1.15, toml ≤5) | VERIFIED, **TRACKED**: not remediated by `audit fix --force` (would be a breaking major jump to stellar-sdk 17). Exposure is bounded: the CLI's own HTTP client is zero-dep `node:http`; axios exists only inside the SDK's Horizon paths. Upgrade scheduled as its own breaking change |
| A-11 | Git-history secret scanning | VERIFIED CLEAN: all 17 commits' blobs scanned for `sk-`, `PRIVATE KEY`, `AKIA`, `ghp_`, `xox`, Stellar `S…` seeds — zero matches |
| A-12 | Package integrity | VERIFIED: no install scripts in the lockfile (152 pkgs), no source maps shipped, `files` whitelist matches output; internal audit docs ship in the package (deliberate; flagged for reconsideration) |
| A-13 | Keystore crypto (PBKDF2-100k/SHA-512 + AES-256-GCM) | IMPLEMENTED-UNVERIFIED: salt/IV are crypto-random per entry, GCM auth-tag checked on decrypt, 0600 file. Not verified: password rotation, re-encryption versioning, zeroization (JS cannot guarantee), Argon2id upgrade. Argon2id recommended as P2 (native dependency — must be a deliberate, supply-chain-reviewed addition) |

## Audit-report corrections from pass one
1. **Test inventory reconciled:** the CLI has exactly **21 test files**; `npm test` runs **19**, `http.test.js` (0/11) and `payment.test.js` (11/26) are excluded because they target APIs that were never implemented (documented, not faked green). Pass-one prose saying "21 files, all green" was wrong; the coverage table was right.
2. **Status discipline:** pass-one findings are re-graded — e.g., device-revocation cold-instance fix is FIXED+REGRESSION-TESTED *for cross-instance listing* but the KV-outage denylist fail-open remains TRACKED (M-2), and `npm pack` success never established package integrity (now A-12).
3. **`algo-msgpack-with-bigint` is used** (`src/hyperliquid/signer.ts:14`) — pass one flagged it as possibly unused; verified in use, dependency retained.

## Boundary statement
Dynamic testing used local mock backends and isolated temp dirs; no production
infrastructure, no real funds, no real devices. Findings about the webapp were
verified in the webapp workspace, which is not this repository.

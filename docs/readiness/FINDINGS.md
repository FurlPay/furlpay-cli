# Readiness findings — gap verification against the code

Phase-0 style verification: for each claimed gap, is it real, where, and what
already covers it. Verified by reading `src/` (not the README). Statuses:
Confirmed / Partially covered / Already fixed / Not applicable.

## P23 — orchestrator hardening — CONFIRMED → FIXED
The gap was real: `PaymentOrchestrator.createOutPayment` ran
`ledger.commit()` before the approval binding check, so a refused execution
still posted the payment (observed in a smoke test: mismatched fee → refused
→ but ledger committed → confirm → settle → billing counted it). Fixed this
session; see PROGRESS.md for the report.

## P1 — registry / live gate — ALREADY FIXED
`src/capabilities/registry.ts` (commit 22ef18f) implements the registry with
modes, `signsOrBroadcasts`, `assertLiveAllowed()` requiring `FURLPAY_LIVE=1`
opt-in, and refusals for simulated surfaces in live mode. `finance.payments`
is registered `local`. Remaining gap: some older call sites may still hardcode
capability lists (audited `settlementCapabilities()` — now registry-derived).

## P7 — MCP defaults — PARTIALLY COVERED
`src/mcp/server.ts` registers 32 tools; finance tools are inspection-only
with honest `readOnlyNotice` strings; mutating tools declare
`anthropic/requiresUserInteraction` (pinned by `test/mcp-2026.test.js`).
Gaps: no global read-only default mode; no two-phase preview/confirm;
`furlpay_settle_invoice` executes (policy-gated, simulation-only without a
policy) rather than preview→confirm; injection eval suite absent.

## P15 — transactional state — PARTIALLY COVERED (by P23 work)
All finance state is JSON files with atomic rename + hash-chain tamper
detection. P23 added a cross-process exclusive lock + reload-before-mutate on
the approvals and ledger stores, plus Windows rename/open retry handling.
Still missing: WAL/rollback, `state verify|backup|restore` commands,
kill -9 mid-write drills, OneDrive offboarding.

## P3 — key custody — PARTIALLY COVERED
Redaction property test exists (`test/key-redaction.test.js`, commit e1e6ef0).
Gaps: keystore KDF parameter upgrade path, strict-mode master-key refusal,
`safeSpawnEnv` for child processes.

## P14 — market-data & time integrity — PARTIALLY COVERED
Dual-source USDC peg feed (CoinGecko + Coinbase, commit 383005b) with
fail-closed semantics. Gaps: clock-drift refusal before signing, WS book
sequence-gap tests, endpoint allowlist warnings.

## P4/P5/P6/P8–P13, P16–P22 — NOT YET STARTED
No registry/doc/test evidence of work. See PROGRESS.md rows. Notable
pre-existing partials: risk engine hardening (e3462a6) covers some P5 scope;
algo/execution tests cover some P8 scope; honesty matrix + docs already
maintained (3f2efa9).

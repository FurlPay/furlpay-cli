# Readiness progress — R2 operator canary

Tracks the readiness gap items (P1–P23) from the readiness plan. One row per
item; branches are in this repo. Update per item after its report is written.

| Item | Title | Status | Branch | Notes |
|------|-------|--------|--------|-------|
| P1 | Capability registry + live gate | DONE | `main` (22ef18f) | `src/capabilities/registry.ts`, `assertLiveAllowed()` on signing paths |
| P2 | Compliance controls plumbing | PENDING | — | not started; needs registry controls rows first |
| P3 | Key custody & signer architecture | PARTIAL | `main` (e1e6ef0) | redaction property test + suite registered; keystore KDF upgrade, strict-mode master-key refusal, safeSpawnEnv still open |
| P4 | Order lifecycle correctness | PENDING | — | not started |
| P5 | Risk engine & kill-switch | PENDING | — | risk engine was hardened 2026-11-17 (e3462a6) but breaker/kill-switch independence not done |
| P6 | Agent Trust mandate state | PENDING | — | not started |
| P7 | MCP defaults & human-in-the-loop | IN PROGRESS | `readiness/p23-orchestrator-hardening` | finance surface already inspection-only (pinned by test); full read-only default + two-phase execution open |
| P8 | Live-network test strategy | PARTIAL | `main` | differential/property coverage exists in spots; chaos harness + coverage gates open |
| P9 | Stellar live execution (decision gate) | PENDING | — | safe relabel tasks open |
| P10 | x402 custody decision | PENDING | — | decision doc not written |
| P11 | Escrow honest relabel + verification | PENDING | — | tracker labeled; tx-hash verification not done |
| P12 | Binance hardening | PENDING | — | not started |
| P13 | Hosted backend inventory | PENDING | — | not started |
| P14 | Market-data & time integrity | PARTIAL | `main` (383005b) | dual-source peg feed done; clock-drift sign gate + WS book tests open |
| P15 | Transactional local state | PENDING | — | pragmatic cross-process lock shipped in P23 (finance stores); full store = P15 |
| P16 | Observability & audit | PENDING | — | events journal exists; hash-chained audit verify + metrics open |
| P17 | Runtime automation | PENDING | — | not started |
| P18 | CI/CD & release automation | PENDING | — | not started |
| P19 | Security program | PENDING | — | not started |
| P20 | Docs, identity, claims accuracy | PENDING | — | honesty matrix exists; README split + claims audit open |
| P21 | Incident response | PENDING | — | not started |
| P22 | User safeguards & disclosures | PENDING | — | not started |
| P23 | Finance/payment orchestrator hardening | DONE | `readiness/p23-orchestrator-hardening` | see report below |

## P23 report (2026-11-17)

**Status: DONE** on `readiness/p23-orchestrator-hardening`.

**What I found (vs. gap description).** The observed bypass was real and the
root cause exactly as suspected: `createOutPayment` committed the ledger
BEFORE `consumeForExecution` could throw on a binding mismatch. The working
branch had already restructured this to assert → reserve → commit → finalize;
this session closed the remaining gaps.

**What changed (files).**
- `src/finance/approvals.ts` — params hash normalizes absent fee ≡ zero fee;
  CAS reservation returns a one-time OWNER TOKEN; only the owner can finalize
  or release; every mutator runs under a cross-process file lock with
  reload-from-disk-first (stale in-memory views can never authorize).
- `src/finance/fileLock.ts` (new) — O_EXCL lock with staleness recovery;
  Windows delete-pending EPERM/EBUSY treated as retryable.
- `src/finance/store.ts` — atomic-rename retries on Windows reader collisions
  (EPERM/EACCES/EBUSY), brief backoff, then fail closed.
- `src/finance/ledger.ts` — reads and persists under the lock; evidence gate
  AT THE LEDGER: `→ SETTLED` requires `chain_verified`, no tx is born SETTLED;
  per-network destination + tx-hash validation (EVM 0x+40/64, Stellar strkey,
  Solana base58); `refDestination` explicit field; `annotate()` for audit.
- `src/finance/payments.ts` — owner token threaded reserve → finalize/release;
  binding assert before ANY write; atomic commitMany (payment+fee together);
  idempotency fingerprint + conflict + dead-key surfacing; spend cap counts
  amount+fee; per-unit thresholds (unknown unit → always approve); decimals
  from the money registry; `settlementCapabilities()` derived from the P1
  registry.
- `src/finance/billing.ts` — settled volume counts only chain-verified.
- `src/finance/humanGate.ts` (new) — TTY typed challenge OR approver
  credential (constant-time compare); refusals → CLI exit 46; no force flag.
- `src/cli.ts` — approve command uses the gate; settle path prints the honest
  operator_asserted/unverified story.
- `src/mcp/server.ts` — unchanged structurally (already inspection-only);
  now pinned by test.

**Tests added** (all in `test/finance-operations.test.js` unless noted):
byte-identical refusal; GDEST junk refused pre-approval; idempotency conflict;
dead-key surfacing; fiat 2-dp threshold; fee crosses threshold + spend cap;
unknown unit fail-closed; spend release on cancel; operator-asserted never
settles (billing); fake/short hash rejection; **8-process race → exactly one
execution** (stable 30/30 after the lock fixes); reservation owner-mismatch;
absent-fee ≡ zero-fee hash; evidence-gated state machine; SETTLE gate at
commit and transition; `test/human-approval-gate.test.js` (9 cases);
`test/mcp-2026.test.js` finance-surface guard.

**Acceptance criteria.** The observed bypass is impossible (refusal precedes
any write; ledger byte-identical, evidenced by the snapshot test). One
approval funds exactly one payment across processes. Only chain-verified
evidence settles. Non-TTY approval without a credential is refused with exit
46. MCP exposes no approve/settle/limit tool.

**Decisions needed from you.** None blocking. Open design questions parked
in later items: real OFAC ingestion (P2), x402 settle_invoice two-phase
gating (P7), transactional store (P15).

**Residual risk / not verified.** The ledger's read-modify-write is not
fully multi-writer transactional (lock serializes writes; P15 owns the real
store). Windows path in the race worker uses OneDrive-adjacent temp dirs —
fine for tests, P15 will move state off synced folders. Real chain-verified
evidence still needs an injected RPC provider (interface ready, no live
provider wired).

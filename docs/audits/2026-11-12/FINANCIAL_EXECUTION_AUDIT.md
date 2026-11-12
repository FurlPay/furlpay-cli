# Financial Execution Audit — Second Pass (2026-11-12)

Scope: every path that could move or claim to move value. Rules of evidence:
no real transactions were broadcast; dynamic tests used local mocks.

## Settlement engine (`/api/v1/pay/execute` → `settleTransferAtomic`)
| Property | Verdict | Evidence |
|---|---|---|
| Double-spend / duplicate submission | VERIFIED PROTECTED | atomic row-locking + idempotency key; `replayed` flag returned on repeat (`route.ts` tail, SEC-03/04) |
| Idempotency-key collisions | VERIFIED | engine treats repeat with same key as replay, not a new debit |
| High-value escalation | VERIFIED | ≥$100k → durable requires_approval hold (now shares the fail-closed park helper; write failure → 503, never a 202 without a hold) |
| **Agent-initiated execution** | **VERIFIED BLOCKED (this pass)** | mandate/agentId → parked; settle never invoked (8-test PoC suite) |
| Quote binding | VERIFIED | HMAC binds recipient+amount+currency+expiry; constant-time compare; expired quote 400 |
| Sender authorization | VERIFIED | BOLA suite (corporate treasury, cross-account) — pre-existing tests green |
| Compliance | VERIFIED | dual-side sanctions; KYB required; fail-closed on review status |
| Precision | VERIFIED | `usdToCents` minor-unit conversion server-side |

## Hyperliquid (real execution, env-key gated)
| Property | Verdict | Evidence |
|---|---|---|
| Duplicate order after timeout | VERIFIED SAFE | no retry loop in `client.ts`/`perp.ts` — timeout rejects and exits |
| Nonce replay/collision | VERIFIED FAILURE-SAFE | `Date.now()` ms nonce; a same-ms duplicate is rejected by the exchange, not double-executed |
| Signing-key isolation | VERIFIED | key only from env vars; no command accepts key material; MCP has no signer at all (A-1 class closed) |
| Kill-switch race | DOCUMENTED LIMITATION | single-process CLI; cancel-then-close is sequential; no in-process concurrent trader |
| Stale market data | DOCUMENTED LIMITATION | 60s meta cache; order sizes/prices are operator-supplied |
| Partial fills / status | IMPLEMENTED-UNVERIFIED | fill reporting reads `/info clearinghouseState`; correctness under partial fills not demonstrated |

## Stellar SDEX / Soroban / x402 / escrow / sponsor relayer
All previously-unlabeled simulations now carry `SIMULATED` / `sim_` hashes /
`simulated:true` and CANNOT be mistaken for broadcasts (pass-one fix, pinned
by `test/stellar.test.js`). x402 tokens are explicitly NOT valid Authorization
headers. Escrow fund/proof/release/dispute remain documented-but-unreachable
(help says otherwise — TRACKED functional gap).

## Honesty ledger (post-fix state)
No path found in this pass that reports success without either (a) an
authoritative server record (`transferId` + `settledAt` from the settlement
engine, `replayed` disclosed) or (b) an explicit SIMULATED marker. The
`accounts` fabricated treasury row and `logs` canned loop remain TRACKED
functional gaps from pass one.

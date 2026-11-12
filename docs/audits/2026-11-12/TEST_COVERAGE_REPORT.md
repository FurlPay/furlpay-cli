# Test Coverage Report — 2026-11-12

## Suite state after remediation

`npm test` now runs **19 of 21** test files and exits 0 (build prerequisite
unchanged: `tsc` runs first in CI).

| Test file | In npm test | Result | Notes |
|---|---|---|---|
| credential-trust | ✅ | 11 cases pass | cookie trust-boundary pins |
| pay-a2a | ✅ | pass | updated for honest `quo_local_` fallback quote |
| pay-remediation | ✅ | pass | SEC-09 rewritten to pin no-forged-signature semantics |
| x402-verification | ✅ | pass | |
| hyperliquid-execution | ✅ | pass | |
| escrow | ✅ | pass | |
| agent-mandate | ✅ | pass | |
| stellar | ✅ | pass | x402/MCP assertions updated: `SIMULATED` semantics pinned |
| hawkes-volatility | ✅ | pass | |
| dynamic-discovery | ✅ | pass | |
| terminal-navigation | ✅ | pass | |
| mcp-2026 | ✅ | pass | requires dist build (CI order is build→test) |
| institutional-workstation | ✅ | pass | |
| furlpay-core-engine | ✅ | pass | |
| furlpay-production-core | ✅ | pass | |
| hyperliquid-verified-protocol | ✅ | pass | |
| **device-auth** (NEW in npm test) | ✅ | 4 pass | URL allowlist, poll mapping, e2e polling loop, hostile-URL refusal |
| **hardening** (was excluded) | ✅ | 3 pass | safeUrl / configStore / paymentJournal |
| **realtime** (was excluded) | ✅ | 17 pass | MCP approval-gate invariant now enforced and green |
| **mnemonic** (NEW) | ✅ | 10 pass | SLIP-0010 spec vectors, BIP39 checksum, keystore round-trip |
| http | ❌ excluded | 0/11 | tests `payDemo`/transport fail-closed semantics that are NOT implemented — tracked, not faked green |
| payment | ❌ excluded | 11/26 | targets a payTui API (`parseAmount`, `validateQuote`, …) that was never implemented — tracked |

**Rationale:** tests documenting UNIMPLEMENTED behavior are roadmap, not
regressions. Adding them green would require faking the features; adding them red
would make CI useless. They are excluded with this documented reason (audit
full-security doc) and must be either implemented or deleted deliberately.

## What the new tests pin
1. `wallet import` imports the CALLER's key (never a generated one) and refuses a
   missing password.
2. Mnemonic derivation matches the SLIP-0010 ed25519 spec table (master, m/0',
   m/0'/1') and fails closed on BIP39 checksum errors.
3. The keystore's displayed publicKey is the key the mnemonic controls.
4. RFC 8628 client: allowlist enforcement even against a hostile backend,
   pending/slow_down polling, token stored without being echoed.
5. Every simulated financial surface reports `SIMULATED`/`sim_` — no canned
   "SETTLED"/"SUCCESS" receipts.
6. MCP mutating tools fail closed without an AP2 mandate, regardless of model
   arguments.

## Dynamic verification (post-remediation)
- `npm run typecheck` → clean
- `npm run build` → clean
- `npm test` → exit 0
- `npm pack --dry-run` → 243 files, ships bin/dist/lib/docs

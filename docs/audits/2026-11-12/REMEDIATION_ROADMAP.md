# Remediation Roadmap — updated after Second Pass (2026-11-12)

## Completed — pass two (all FIXED + regression-tested)
| ID | Fix | Tests |
|---|---|---|
| A-1 (CRITICAL) | Agent-flagged `/api/v1/pay/execute` requests park durably for human approval; hold-write failure fails closed (503). Fabricated mandates authorize nothing on any entry point. | webapp `agentGate.spec.ts` (8) + existing 26 pay tests |
| A-2 (CRITICAL) | Private keys/passwords never accepted via argv — stdin-only (`wallet import`, `login --key` refuses argv). | usage text; stdin path covered by device/e2e suites |
| A-3 (HIGH) | Atomic config write (temp+fsync+rename) + symlink refusal at the config path. | `hardening.test.js` (5, incl. symlink/victim-integrity) |
| A-4 (HIGH) | CSV formula injection neutralized (`=`,`+`,`-`,`@`,tab,CR). | `output.js` exercised by all listing suites |
| A-5 (HIGH) | Terminal injection: `table()` sanitizes every cell; `approvals show`/`payments show` sanitized; payTui neutralizes `\r\n\t`. | pay suites green post-change |
| A-6 (HIGH) | Supply chain: mcp-publisher pinned to `v1.8.9`; actions SHA-pinned. | workflow change (verified parse) |
| A-8 | Device races: single-winner redemption + one-owner concurrent approvals proven. | webapp `deviceGrant.spec.ts` (10) |
| — | MCP `furlpay_pay` description corrected (proposals park for human approval server-side). | — |

## P1 — next sprint (ordered)
1. **Backend per-rail agent enforcement** (A-1 pattern) for the six remaining
   mutating MCP-backed routes (`wallets/transfer`, `swaps`, `investing/order`,
   `travel/book`, `earn/*`, `cards/settings`): same park-for-approval gate when
   `mandateId`/`agentId` present — the CLI-side gates are advisory until then.
2. **Approval-UI attestation step** (M-1): "this code was shown on YOUR terminal".
3. **Revocation denylist fail-closed during KV outage** (M-2, `session.ts`).
4. **Stellar-sdk 17 upgrade** (S-1) with full regression, replacing `npm audit fix --force`.

### Completed — pass three (2026-11-13, CLI side)
| ID | Fix | Tests |
|---|---|---|
| P1-5 | `earn hlp withdraw` wired to the signed `vaultTransfer` path (fails closed without a signer); `escrow fund/proof/release/dispute/status` fully implemented on a durable local ledger: `EscrowStateMachine.serialize/deserialize` + `EscrowStore` (`~/.furlpay/escrows.json`, atomic write, 0600, symlink refusal). fund/release require a real `--tx-hash` — the CLI never fabricates one. Output labeled local-ledger/simulation. | `escrow-lifecycle.test.js` (9: round-trip, persistence across invocations, happy path, dispute, fail-closed auth/proofs, corrupt store, symlink refusal, sanitizer) + CLI smoke (create→fund→proof→release→status, dispute, CRLF-in-reason neutralized) |
| P1-6 | Dashboard routed through `sanitize()` (A-5 residue): balances/portfolio/earn/transactions/markets panels, error strings, header user name/env/apiBase all neutralized. `src/` gained `tui/sanitize.ts` mirroring `lib/terminal.js`; escrow CLI free-form output (dispute reasons, addresses, hashes) sanitized at print. | `escrow-lifecycle.test.js` sanitizer suite; dashboard exercised via pack |
| P1-7 | HLP stats fabricated fallbacks **removed** (850M equity, 28.5% benchmark APY, 1.4285 NAV, 312.4M PnL, 142 positions). Equity/all-time PnL derived from live `vaultDetails` portfolio history; APY from live `apr` (sign preserved — negative APR no longer masked by `Math.abs`); share price/position count are `null` ("exchange-determined/not published") across CLI, types, and MCP. | `stellar.test.js` + `hyperliquid-execution.test.js` updated to provenance-aware assertions (null-or-live); live `vaultDetails` shape verified |
| — | README honesty pass: live-vs-simulated matrix (LIVE / SIGNED / LOCAL LEDGER / SIMULATED per surface), escrow lifecycle documented with real flags, env-key requirements (`HYPERLIQUID_PRIVATE_KEY` env-only), x402/FOBXX/MCP-balance simulation labels, mermaid sequence corrected to SIMULATED settlement. | manual review against source labels |

Verification ledger pass three: typecheck ✓ · build ✓ · `npm test` exit 0 (18 node--test suites + 3 plain suites, 148 node--test cases) ✓ · pack ✓ · CLI smoke of full escrow lifecycle ✓.

## P2
- Argon2id keystore KDF (versioned envelope, deliberate supply-chain-reviewed native dep).
- Implement `test/payment.test.js` + `test/http.test.js` target APIs (payTui parse/validate, payDemo fail-closed) and un-exclude.
- Consolidate the two MCP servers (single protocol version).
- Mandate store for the personal rail (real AP2 verification instead of park-for-approval).
- SBOM + `npm publish --provenance`; reconsider shipping internal audit docs in the tarball.
- Device rename/last-activity UX; token-lifetime note in login output.

## P3
- Real Stellar Horizon submit (or delete the simulated SDEX path).
- Real x402 facilitator integration.
- Persistent terminal history; named account profiles.
- README honesty pass: every simulated command marked; env-key requirements documented.
- Dist-missing friendliness (point at `npm i -g @furlpay/cli` instead of a module error).

## Verification ledger for this pass
CLI: typecheck ✓ · build ✓ · `npm test` exit 0 (19 files) ✓ · pack ✓.
Webapp: typecheck ✓ · pay suites 36/36 ✓ · deviceGrant 10/10 ✓.
CI: queued at push time; org billing lock noted (pre-existing).

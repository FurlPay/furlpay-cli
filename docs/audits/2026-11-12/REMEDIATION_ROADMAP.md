# Remediation Roadmap — 2026-11-12

## P0 — done this commit
| Task | Files | Status |
|---|---|---|
| wallet import imports caller's key, mandatory password | src/cli.ts | ✅ |
| Mnemonic derivation (BIP39+SLIP-0010) + checksum fail-closed | src/wallet/mnemonic.ts, keystore.ts | ✅ |
| Simulated surfaces labeled (SIMULATED / sim_ / simulated:true) | sdex, pathPayment, soroban, order manager, relayer, x402, MCP server, cli.ts | ✅ |
| MCP furlpay_trade refuses invented signers | src/mcp/server.ts | ✅ |
| MCP mutating tools fail-closed mandate gate | lib/mcp.js | ✅ |
| Remove hardcoded HMAC quote secret | lib/payTui.js | ✅ |
| Regression suites: device-auth (4), mnemonic (10); hardening+realtime in npm test | test/ | ✅ |
| server.json version parity | server.json | ✅ |

## P1 — next (webapp workspace + CLI)
1. Approval UI attestation step ("this code came from YOUR terminal") — webapp
   `DeviceAuthorizationExperience.tsx`; mitigates M-1 cross-user phishing.
2. Revocation denylist fail-closed hardening during KV outage — webapp
   `session.ts:172-179` (currently bounded by the 1h token TTL).
3. Audit-log semantics: distinct `auth.device_denied` / `auth.device_cancelled` /
   `auth.device_approval_failed` events — webapp device routes.
4. CLI: stop fabricating the demo `signature` for `send` — require a real signer
   or refuse.
5. CLI: wire `earn hlp withdraw` and `escrow fund|proof|release|dispute` handlers
   or remove them from help (they are documented but unreachable).

## P2 — functional completeness
1. Implement or delete the unimplemented-API tests (`test/payment.test.js`,
   `test/http.test.js`) and the modules they target (payTui parse/validate API,
   payDemo fail-closed transport).
2. Replace remaining canned MCP wallet-mode tools (`furlpay_get_funding`,
   `furlpay_portfolio_risk`, `furlpay_get_rwa_quote`) with real endpoints or
   `simulated` flags.
3. Consolidate the two MCP servers (one registry, one protocol version, one docs
   section) — currently protocol 2025-06-18 vs 2024-11-05.
4. Device lifecycle polish: device rename, per-device activity view, `--device`
   login output noting the 1-hour token lifetime.
5. Dead code removal: lib/watch consumers vs realtime split, unused keystore
   paths, shadowed terminal branch.

## P3 — product
1. Interactive password prompt with echo suppression for `wallet import`.
2. Observability: correlate X-Request-ID / correlation-id headers into CLI logs.
3. Windows CI job exercising the keystore (DPAPI path in lib/configStore.js is
   currently unreferenced by shipped code).
4. README honesty pass: mark every simulated command as simulation, document the
   required env keys (`HYPERLIQUID_PRIVATE_KEY`/`ETH_PRIVATE_KEY`).

## Acceptance criteria per task
Every item above lands only with: typecheck clean, full `npm test` green, the
affected behavior pinned by a new test, and this document's table updated.

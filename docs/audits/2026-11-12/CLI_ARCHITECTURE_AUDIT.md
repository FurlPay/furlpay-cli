# CLI Architecture Audit — 2026-11-12

## Execution-flow map

```
bin/furlpay.js (CommonJS entry, no deps)
 ├─ parseFlags/positionals (lib/util.js)
 ├─ dispatch table
 │   ├─ web-API commands → lib/commands.js → lib/api.js (zero-dep http/https,
 │   │    cookie trust boundary) → ~/.furlpay/config.json
 │   ├─ pay flows → lib/payTui.js (quote → confirm → execute, idempotency keys)
 │   ├─ MCP server → lib/mcp.js (default) | src/mcp/server.ts (wallet mode)
 │   ├─ device login → lib/deviceAuth.js (RFC 8628)
 │   └─ "flagship" commands → dist/cli.js (TypeScript src/, built by tsc)
 │        ├─ src/hyperliquid/*  real network (signed EIP-712 → api.hyperliquid.xyz)
 │        ├─ src/trade/*        SIMULATED Stellar execution (labeled this commit)
 │        ├─ src/tui/*          interactive workstations
 │        └─ src/wallet/*       keystore (PBKDF2+AES-GCM), agent keys, mnemonic
 └─ trigger/listen → webhook forwarding with HMAC-SHA256 (lib/util.js sign)
```

## Architectural strengths
- Zero runtime dependencies for the CLI machinery (node http/https + commander/
  chalk only where warranted); the trust boundary lives in one function
  (`isCredentialedTarget`) with suffix-confusion tests.
- Clean separation: transport (api.js) vs presentation (output.js/payTui) vs
  credential storage (util.js config, keystore.ts).
- Tests as invariants: credential-trust, mandate gate, SLIP-0010 vectors.

## Weaknesses
1. **Two of everything:** two MCP servers, two config systems (JSON util.js vs
   TOML src/config), two Hyperliquid signers, two wallet command families,
   duplicate terminal branches. Consolidation is P2 roadmap item 3.
2. **Dead code:** lib/watch.js, lib/payDemo.js, lib/payView.js, lib/paymentJournal.js,
   lib/configStore.js, src OrderBookTerminal, several barrel-only modules
   (authorization-service, exchange-reconciler, recovery-engine, x402-facilitator…).
   They consume maintenance budget and appear in the README narrative.
3. **dist-gated UX:** every flagship command fails with `Cannot find module
   '../dist/cli'` unless `npm run build` ran. CI does build first; npx users get
   dist via prepack. A friendlier error pointing at `npm i -g @furlpay/cli` is a
   one-line fix (P3).
4. **Unmarked mock debt is now labeled but still present** — the honest endgame is
   implementing the Stellar execution path (real Horizon submit) or removing it.

## Proposed target architecture (no new deps)
```
bin/furlpay.js
 └─ commands/
     ├─ auth/ (otp.js, device.js)      ← lib/deviceAuth.js stays the single client
     ├─ api-client.js                  ← cookie/bearer transport + trust boundary
     ├─ financial/ (pay.js, swap.js…)  ← real web-API flows, backend authoritative
     ├─ trading/ (hyperliquid.js)      ← real signed flows (env-key gated)
     ├─ stellar/                       ← real Horizon submit OR removed (no mocks)
     └─ mcp/ (single server, single protocol, mandate gate shared with financial/)
```
Every simulated surface either becomes real (behind the same gates) or is
deleted; the `SIMULATED` labeling this commit added is the transition state.

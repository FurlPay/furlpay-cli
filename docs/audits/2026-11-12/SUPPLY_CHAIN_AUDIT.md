# Supply Chain Audit — Second Pass (2026-11-12)

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | HIGH | `npm audit`: **3 high advisories** via `@stellar/stellar-sdk@15.1.0` transitives — axios 1.15.0 (auth bypass via prototype pollution GHSA-w9j2-pvgh-6h63; NO_PROXY/SSRF bypasses; CRLF injection; response tampering) and toml ≤5.0.0 (prototype pollution GHSA-v5mp-jgw5-2x6j; uncontrolled recursion). Fix path = breaking major (stellar-sdk 17). | **TRACKED** — exposure bounded: the CLI's own HTTP is zero-dep `node:http` (`lib/api.js`); axios only exists inside the SDK's Horizon paths; the TOML parser is only reached via `src/config` (separate config system). Upgrade scheduled as its own reviewed change; never `audit fix --force` blindly. |
| S-2 | HIGH | `publish-mcp.yml` downloaded an **unversioned `latest`** binary (`mcp-publisher`) from a third-party repo and executed it with `id-token: write`. | **FIXED** — pinned to release `v1.8.9`; both workflows' actions now SHA-pinned (`actions/checkout@11d5960a…`, `actions/setup-node@49933ea5…`, tags in comments). |
| S-3 | MEDIUM | Root lifecycle scripts (`prepack`/`prepublishOnly` → `tsc`) — legitimate; **zero install scripts in the entire lockfile** (152 packages verified programmatically), all `resolved` URLs are registry.npmjs.org. | VERIFIED CLEAN |
| S-4 | LOW | Dependency confusion / typosquatting: all 12 runtime deps well-known; `algo-msgpack-with-bigint` (least-known) verified genuinely used (`src/hyperliquid/signer.ts:14`) — pass one's "possibly unused" suspicion was wrong; dependency retained. Outdated-but-pinned majors (chalk 4, inquirer 8, ora 5) — maintenance note. | VERIFIED |
| S-5 | INFO | `npm pack`: 253 files, no `.env`, no source maps (tsconfig has no `sourceMap`), no executables beyond `bin/furlpay.js`; `files` whitelist matches. Ships internal audit docs (deliberate — flagged for reconsideration). `CHANGELOG.md` whitelisted but absent (npm silently omits). | VERIFIED; doc-shipping decision tracked |
| S-6 | INFO | Git history (17 commits, all blobs scanned) for `sk-`, `PRIVATE KEY`, `AKIA`, `ghp_`, `xox`, Stellar `S…` seeds: **zero matches** (test fixtures excluded). | VERIFIED CLEAN |

## Package vs source equivalence
`npm pack --dry-run` verified contents match the whitelist. The distributed
tarball contains `src/`, `dist/`, and `lib/` — CI runs `tsc` from the same
lockfile, so dist is reproducible from source; provenance signing is not yet
configured (roadmap: `npm publish --provenance` + SBOM generation).

## CI supply-chain posture
`npm ci --ignore-scripts` (no lifecycle scripts run), `permissions: contents: read`,
SHA-pinned first-party actions only, no third-party composite actions. The
remaining exposure is S-1's transitive dependency risk.

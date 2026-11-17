# Documentation coverage report

Audit date: **2026-11-17**. Method: source-first — command inventories built
from `bin/furlpay.js` + `src/cli.ts` dispatchers, env vars from grepping every
environment access in `src/ lib/ bin/ scripts/`, MCP tools from the live
registration (`getToolDefinitions()` + `lib/mcp.js` registration list), flows
from the module files themselves. The README was treated as a claim to verify,
never as the source of truth.

## Coverage matrix

| Repository surface | Implementation audited | Documentation updated | Verified against source |
|---|---|---|---|
| Core CLI (dispatcher, help, version) | Yes | Yes (command-index, cli) | Yes |
| Wallet (ledger, sep7, extension, import, agent keys) | Yes | Yes (stellar guide, examples 5–8) | Yes |
| Payments (JS app surface, hosted API) | Yes | Yes (platform-api-integration) | Yes (endpoint list from `lib/commands.js`) |
| Stellar (trade/order/rwa, SDEX, Soroban, SEP-8) | Yes | Yes (stellar, rwa guides + honesty rows) | Yes |
| Hyperliquid (perps, HLP, risk engine, kill-switch) | Yes | Yes (hyperliquid guide + architecture) | Yes |
| Binance spot | Yes | Yes (binance guide) | Yes |
| MCP JavaScript (29 tools) | Yes | Yes (mcp-tools.md) | Yes (registration list) |
| MCP TypeScript (35 tools) | Yes | Yes (mcp-tools.md) | Yes (live `getToolDefinitions()` dump) |
| Oracle (`furlpay oracle`) | Yes | Yes (cli reference, architecture, examples 24) | Yes (live-verified endpoints) |
| Solana read-only (`furlpay solana`) | Yes | Yes (cli reference, examples 23) | Yes (live-verified RPC) |
| Quantitative research (microstructure, algo) | Yes | Yes (market-data, algorithms guides) | Yes |
| Escrow (ETSS) | Yes | Yes (escrow guide + architecture diagram) | Yes (incl. C-01 rehydration) |
| Security (keystore, redaction, gates) | Yes | Yes (security model, environment) | Yes |
| Environment variables | Yes (every access grepped) | Yes (reference/environment + .env.example +5) | Yes (5 previously-undocumented vars added) |
| Platform API (furlpay.com/docs) | Yes (CLI-side) | Yes (platform-api-integration) | Yes |

## What was corrected during the audit

1. **`HORIZON_URL` → `STELLAR_HORIZON_URL`** — the old env page named a var
   the source does not read.
2. **`STELLAR_NETWORK` removed from the env page** — a `config.toml` network
   profile concept, not an environment variable.
3. **5 source-read vars missing from `.env.example`** — `FURLPAY_LIVE`,
   `FURLPAY_ENV`, `HYPERLIQUID_WALLET_ADDRESS`, `FURLPAY_FINANCE_WEBHOOK_URL`,
   `FURLPAY_FINANCE_APPROVER_TOKEN` — now documented there and in the
   exhaustive reference.
4. **MCP tool count drift** — README said "28" while the TS surface actually
   registers 35 tools (finance + two-phase tools added under P7); now framed
   as two surfaces (35 TS / 29 JS).
5. **agents.md described the pre-P7 world** — rewritten for read-only
   default, two-phase execution, both surfaces.

## Counts

- CLI commands documented (top-level): **63** (dispatcher cases), indexed in
  `reference/command-index.md`.
- MCP tools documented: **35** (TS) + **29** (JS) = **64**, schemas from the
  live registration.
- Environment variables documented: **24** across 7 groups (+ terminal/detect
  vars), each traced to a source read.
- Examples: **30** recipes in `docs-site/examples/` (index + 3 pages).
- Architecture diagrams: **8** Mermaid diagrams, all drawn from real modules.
- Honesty-matrix discrepancies corrected this pass: tool-count drift,
  pre-P7 agent docs, 2 wrong env vars, 5 missing env vars.

## Remaining gaps (honest)

- Per-command exhaustive pages (every flag of every command in the
  `### Command: furlpay x` format) — the command index covers all 63
  top-level commands and the [CLI reference](/reference/cli) covers the
  flagship groups; the long tail (e.g. `furlpay api`, `listen`, `trigger`
  JS plumbing aliases) is indexed but not expanded flag-by-flag. Flag tables
  should be generated from `--help` output per command in a follow-up pass.
- Example outputs are shown only where captured live or pinned by tests;
  other recipes state expected behavior instead of inventing transcripts.
- The platform-API mapping documents the CLI side only; server-side route
  contracts live in furlpay.com/docs and are linked, not duplicated.

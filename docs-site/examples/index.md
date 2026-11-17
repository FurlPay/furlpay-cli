# Examples

Thirty runnable recipes, grouped in three pages. Every command is verified
against the implementation; where a recipe needs credentials or
infrastructure this is stated up front, and no output is shown that we have
not either captured or pinned in tests. Recipes involving real funds carry a
risk block — read it before running anything that signs.

| # | Recipe | Page | Needs credentials? |
|---|---|---|---|
| 1 | First-time install (npm) | [Setup](./setup) | No |
| 2 | Windows PowerShell install | [Setup](./setup) | No |
| 3 | macOS / Linux quick install | [Setup](./setup) | No |
| 4 | CLI authentication (device + headless OTP) | [Setup](./setup) | Hosted account |
| 5 | Wallet connection (extension / SEP-7) | [Setup](./setup) | No |
| 6 | Hardware wallet (Ledger) setup | [Setup](./setup) | Ledger device |
| 7 | Import an encrypted wallet (stdin only) | [Setup](./setup) | Your key |
| 8 | Create an agent wallet + spending policy | [Setup](./setup) | No |
| 9 | Read-only MCP configuration | [Setup](./setup) | No |
| 10 | Execution-enabled MCP configuration | [Setup](./setup) | Agent policy |
| 11 | Two-phase transaction confirmation | [Trading & data](./trading-and-data) | Agent policy |
| 12 | x402 payment challenge (labeled simulated) | [Trading & data](./trading-and-data) | No |
| 13 | Stellar SDEX trading (labeled simulation) | [Trading & data](./trading-and-data) | No |
| 14 | Hyperliquid market data | [Trading & data](./trading-and-data) | No |
| 15 | Hyperliquid signed perp order | [Trading & data](./trading-and-data) | **Signer — real funds** |
| 16 | Hyperliquid shorting | [Trading & data](./trading-and-data) | **Signer — real funds** |
| 17 | HLP vault information | [Trading & data](./trading-and-data) | No |
| 18 | HLP deposit / withdraw | [Trading & data](./trading-and-data) | **Signer — real funds** |
| 19 | Binance testnet configuration | [Ops & analysis](./ops-and-analysis) | Binance testnet keys |
| 20 | Binance spot orders (gated) | [Ops & analysis](./ops-and-analysis) | **Binance keys** |
| 21 | Escrow lifecycle (local ledger) | [Ops & analysis](./ops-and-analysis) | No |
| 22 | Transaction verification (honest semantics) | [Ops & analysis](./ops-and-analysis) | No |
| 23 | Solana read-only queries | [Ops & analysis](./ops-and-analysis) | No |
| 24 | Oracle price queries + disagreement gate | [Ops & analysis](./ops-and-analysis) | No |
| 25 | Quantitative market analysis (offline) | [Ops & analysis](./ops-and-analysis) | Supplied data files |
| 26 | Fork replay-risk inspection | [Ops & analysis](./ops-and-analysis) | No |
| 27 | Configuration validation | [Ops & analysis](./ops-and-analysis) | No |
| 28 | Automated diagnostics (`doctor`) | [Ops & analysis](./ops-and-analysis) | No |
| 29 | Self-update and rollback | [Ops & analysis](./ops-and-analysis) | npm install |
| 30 | Uninstallation | [Ops & analysis](./ops-and-analysis) | No |

Conventions used everywhere:

- **Placeholders** (`<G...>`, `0x…`, `<uuid>`) must be replaced with your
  values. No real keys, seed phrases, or production credentials appear in
  these pages — ever.
- **Status labels** (LIVE / SIMULATED / LOCAL / BLOCKED) follow the
  [Honesty Matrix](/reference/honesty-matrix) and are printed by the CLI
  itself alongside results.
- Nothing here weakens a gate: recipes that move value say so, and the
  gates (risk engine, mandate policy, live master gate) are shown as they
  behave, not bypassed.

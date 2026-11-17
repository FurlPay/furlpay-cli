# Command index

Every top-level command the `furlpay` binary dispatches (audited 2026-11-17
from `bin/furlpay.js` and `src/cli.ts`). **S** = served by the TypeScript
execution surface, **J** = JS app surface (`lib/commands.js`), **B** = JS
library engine (offline analysis / live feed), **+** = routed through the
live capability gate (`assertLiveAllowed`) where it signs.

| Command | Surface | One line | Details |
|---|---|---|---|
| `furlpay login` | J | Device (RFC 8628) / OTP auth | [Authentication](/guide/authentication) |
| `furlpay logout` / `whoami` | J | Session management | [Authentication](/guide/authentication) |
| `furlpay balance` | J | Token balances (hosted) | — |
| `furlpay pay` / `send` | J | A2A transfer / raw address send | [Payments](/guide/payments) |
| `furlpay swap` / `bridge` | J | Swap / bridge (hosted) | — |
| `furlpay card` / `cards` | J | Virtual cards (hosted) | — |
| `furlpay invest` | J | Fractional stocks (hosted) | — |
| `furlpay travel` | J | Travel search/booking (hosted) | — |
| `furlpay dashboard` | J | Aggregate dashboard | — |
| `furlpay approv­als` | J | Control-plane approvals | — |
| `furlpay wallet` | S+ | Custody: ledger, sep7, extension, import, agent-keygen | [Stellar Wallets](/guide/stellar) |
| `furlpay trade` | S | SDEX/Soroban trade tooling (SIMULATED) | [Stellar](/guide/stellar) |
| `furlpay order` | S | Offer management (SDEX) | [Stellar](/guide/stellar) |
| `furlpay rwa` | S | Tokenized securities catalog (SEP-8 never claimed) | [RWAs](/guide/rwa) |
| `furlpay x402` | S | HTTP 402 challenges (SIMULATED) | [x402](/guide/x402) |
| `furlpay escrow` | S | ETSS state machine (LOCAL LEDGER) | [Escrow](/guide/escrow) |
| `furlpay tx verify` | S | Honest Horizon lookup | [Configuration](/guide/configuration) |
| `furlpay faucet` | S | Friendbot (testnet/futurenet only) | [Configuration](/guide/configuration) |
| `furlpay config` | S/J | Show/validate config | [Configuration](/guide/configuration) |
| `furlpay hyperliquid` | S+ | Validator status, markets, signed trading | [Hyperliquid](/guide/hyperliquid) |
| `furlpay market` | S | Institutional microstructure | [Market Data](/guide/market-data) |
| `furlpay markets` / `chains` / `exchanges` / `portfolio` | S | Discovery surfaces | — |
| `furlpay account` | S+ | Clearinghouse balance/positions/orders/history | [Hyperliquid](/guide/hyperliquid) |
| `furlpay trading` | S+ | Risk limits + kill-switch | [Hyperliquid](/guide/hyperliquid) |
| `furlpay earn` / `hlp` | S+ | HLP vault stats/deposit/withdraw | [Hyperliquid](/guide/hyperliquid) |
| `furlpay terminal` / `quant` | S | Interactive TUI dashboard | — |
| `furlpay finance` | S | Double-entry ledger, spend, approvals, treasury, billing | — |
| `furlpay oracle` | S | Multi-source USD quotes (agreement-gated) | [CLI reference](/reference/cli) |
| `furlpay solana` | S | Live read-only RPC + Jupiter quotes | [CLI reference](/reference/cli) |
| `furlpay binance` | S+ | Spot adapter (testnet default, gated) | [Binance](/guide/binance) |
| `furlpay mcp` | S/J | MCP servers (read-only default) | [MCP tools](/reference/mcp-tools) |
| `furlpay live` | B | Live trade terminal (real WS feed, never trades) | [Market Data](/guide/market-data) |
| `furlpay short` / `shorting` | B+ | Shorting registry/signals; execution via Hyperliquid | [Shorting](/guide/shorting) |
| `furlpay microstructure` | B | OBI / microprice / VPIN / AS quotes (offline) | [Market Data](/guide/market-data) |
| `furlpay algo` | B | GLFT / breakeven / TWAP / POV / funding / cascade | [Algorithms](/guide/algorithms) |
| `furlpay fork` | B | Fork registry + replay-risk audit (read-only) | [Forks](/guide/forks) |
| `furlpay doctor` | J/S | Diagnostics (exit-code honest) | — |
| `furlpay update` | — | Self-update (npm installs) | [Updating](/guide/installation) |
| `furlpay status` / `env` / `version` | J | Environment & status | — |
| `furlpay completion` / `docs` / `help` | — | Shell completion / docs links / help | — |

Note: `furlpay payments`, `events`, `listen`, `logs`, `trigger`, `api`,
`accounts` are aliases/JS-surface plumbing retained for compatibility.

Full per-command syntax, flags and JSON schemas: [CLI Command
Reference](/reference/cli). MCP tools: [MCP tool reference](/reference/mcp-tools).

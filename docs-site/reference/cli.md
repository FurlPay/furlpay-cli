# CLI Command Reference

Every command accepts `--json` where output is structured. Global flags: `--env sandbox|live`, `--api-base <url>`, `--width <cols>`.

## Session & account

| Command | Description |
|---|---|
| `furlpay login [--device\|--email <addr>]` | Browser device flow (RFC 8628) or headless email OTP |
| `furlpay whoami` | Active session, verified email, KYC tier, Safe address |
| `furlpay logout` | Revoke the local session cookie |
| `furlpay env sandbox\|live` | Switch environment |
| `furlpay balance` | Token balances across Arbitrum, Base, Optimism, Ethereum |
| `furlpay dashboard` | Aggregate dashboard view |

## Payments

| Command | Description |
|---|---|
| `furlpay pay '@handle' <amt> [USD\|USDC\|EUR]` | A2A transfer — quote-bound, consent-first |
| `furlpay pay --demo` | Offline reference preview (zero API calls) |
| `furlpay pay --dry-run '@handle' 10 USD` | Real quote, never executes |
| `furlpay send <amt> <0xaddr> --token USDC --chain arbitrum` | Raw address transfer |
| `furlpay swap USDT USDC 100` | Token swap |
| `furlpay bridge 100 --from eth --to arb` | Cross-chain bridge |

## Hyperliquid & trading

| Command | Description |
|---|---|
| `furlpay hyperliquid status\|markets` | Validator connectivity / tradeable contracts |
| `furlpay hyperliquid trade --symbol BTC --side buy\|sell --size <s> --leverage <l> [--limit <px>]` | Signed perp order (LIVE) |
| `furlpay hyperliquid close BTC` | Reduce-only market close (LIVE) |
| `furlpay market <SYM> [--slippage bps] [--side buy]` | L2 book, depth bands, OFI, micro-price |
| `furlpay account balance\|positions\|orders` | Clearinghouse state |
| `furlpay trading limits --max-single-order <usd> --max-leverage <n>` | Pre-trade risk caps |
| `furlpay trading kill-switch --symbol <SYM>` | Emergency stop per symbol |
| `furlpay earn hlp stats\|deposit <usd>\|withdraw <usd>` | HLP vault (4-day lockup) |
| `furlpay short mechanisms\|signal` | Venue status / readiness research (read-only) |

## Binance

| Command | Description |
|---|---|
| `furlpay binance balances` | Spot balances |
| `furlpay binance ticker <SYM>` / `depth <SYM> --limit n` | Market data |
| `furlpay binance spot buy <SYM> --quote <usd>` / `sell <SYM> --qty <q>` | Market orders (agent-trust gated) |
| `furlpay binance open-orders [--symbol <SYM>]` / `cancel <id> --symbol <SYM>` | Order management |

## Stellar, RWAs & escrow

| Command | Description |
|---|---|
| `furlpay wallet connect ledger\|extension\|walletconnect\|sep7` | Custody options |
| `furlpay wallet import --name <n> [--mnemonic]` | Keystore import (stdin only) |
| `furlpay wallet agent-keygen --name <n> --daily-limit <usd> …` | Delegated agent policy |
| `furlpay trade limit\|market-buy\|swap\|terminal` | SDEX/Soroban (SIMULATED in this build) |
| `furlpay order list\|inspect\|cancel\|cancel-all` | Offer management |
| `furlpay rwa list\|inspect\|kyc` | Tokenized securities catalog (SEP-8 never claimed) |
| `furlpay escrow create\|fund\|start-delivery\|proof\|release\|dispute\|status` | ETSS local escrow ledger |

## Oracle & Solana (live read-only)

| Command | Description |
|---|---|
| `furlpay oracle price <ASSET>` | Multi-source USD quote (Coinbase/Kraken/Binance/Jupiter), median + agreement gate — DISAGREEMENT/UNAVAILABLE carry a null price |
| `furlpay oracle sources` | Source inventory: endpoints and covered assets (Pyth gateway shown inactive unless configured) |
| `furlpay solana status` | Live cluster status from mainnet RPC (epoch, slot, block height) |
| `furlpay solana balance <addr>` | Lamport balance via live RPC (base58-validated) |
| `furlpay solana price <mint|alias>` | Jupiter liquidity-weighted USD price (SOL, USDC aliases) |
| `furlpay solana quote <in> <out> <raw-amount>` | Indicative Jupiter route — labeled INDICATIVE, nothing in this build can fill it |

## Verification & diagnostics

| Command | Description |
|---|---|
| `furlpay tx verify <hash> --network mainnet\|testnet` | Real Horizon lookup with honest semantics |
| `furlpay faucet --address <G...>` | Friendbot funding (testnet/futurenet only) |
| `furlpay config validate` | Local config structural checks |
| `furlpay doctor` | Install/registry/config/connectivity diagnostics |
| `furlpay update [--check]` | Self-update (npm) |
| `furlpay mcp --wallet <name>` | Start the STDIO MCP server |

## x402 & forks

| Command | Description |
|---|---|
| `furlpay x402 pay --challenge-header <hdr> --max-cost <usd>` | HTTP 402 settlement (SIMULATED) |
| `furlpay fork networks\|inspect\|replay-check` | Fork registry & replay-risk audit (read-only) |
| `furlpay fork simulate\|psbt-inspect\|opreturn\|taint-plan` | Review-only sweep artifacts |

Exit codes: `0` success; `1` failure, refused, or unknown outcome. Machine-readable diagnostics via `--output json`.

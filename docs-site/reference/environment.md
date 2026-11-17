# Environment Variables

Secrets live in environment variables or stdin — **never as CLI arguments** (argv is visible in process listings and shell history). Variables without the `NEXT_PUBLIC_` style prefix never reach any client bundle; they are read only by the local process.

## Signing keys

| Variable | Used by | Notes |
|---|---|---|
| `HYPERLIQUID_PRIVATE_KEY` | Perp execution, HLP vault | Preferred. Fails closed if absent on signed surfaces. Use a delegated **API Agent key**, not your master |
| `ETH_PRIVATE_KEY` | Perp execution, HLP vault | Fallback signer |
| `FURLPAY_HL_TESTNET` | Hyperliquid | `1` = testnet, `0` = mainnet — explicit, never silently swapped |
| `FURLPAY_USDC_PEG_FEED_URL` | Pre-trade peg guardrail | USDC/USD feed for the depeg monitor; defaults to CoinGecko's simple price. Any https endpoint answering `{ "usd-coin": { "usd": <number> } }`. Refreshed at most once per 30s; a failed feed is surfaced as an explicit `PEG_FEED_UNAVAILABLE` warning on every order — never a synthetic price, and a depeg halt in force stays until real data proves recovery |

## Exchange credentials

| Variable | Used by | Notes |
|---|---|---|
| `BINANCE_API_KEY` | Binance spot | Create with spot trading enabled, **withdrawals disabled**, IP-bound |
| `BINANCE_API_SECRET` | Binance spot | HMAC-SHA256 signing, `recvWindow` enforced |
| `FURLPAY_BINANCE_ENV` | Binance | `testnet` or `mainnet` — distinct constants, never silently swapped |

## Stellar

| Variable | Used by | Notes |
|---|---|---|
| `STELLAR_NETWORK` | Stellar services | `PUBLIC` / `TESTNET` / `FUTURENET` — canonical passphrases validated by `config validate` |
| `HORIZON_URL` | Horizon lookups | e.g. `https://horizon.stellar.org` |

## Terminal & CLI behavior

| Variable | Notes |
|---|---|
| `NO_COLOR` | Presence (any value, including `0` or empty) disables all color |
| `COLORTERM`, `TERM`, `WT_SESSION` | Color-level detection (truecolor / 256 / 16) |
| `NODE_ENV`, `FURLPAY_ENV` | Environment hints; `production`/`live` gates sandbox fixtures |

## Oracle & Solana endpoints

| Variable | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Solana JSON-RPC endpoint for `furlpay solana status/balance` (default: public mainnet-beta) |
| `FURLPAY_PYTH_HERMES_URL` | Optional authorized Pyth Hermes gateway base URL — the Pyth provider is inactive without it (public Hermes is auth-gated) |
| `FURLPAY_PYTH_FEED_IDS` | JSON map `{"SOL":"0x…"}` of verified Pyth feed ids (required with the gateway) |
| `FURLPAY_JUPITER_API_URL` | Jupiter API base for `solana price/quote` (default: public Lite API) |

## Hygiene rules the CLI enforces

- **Argv secrets are refused** — mnemonics/keys on stdin only (`wallet import`, `login --key`).
- **Terminal echo is suppressed** for interactive seed-phrase/key input.
- The session cookie attaches **only** to `furlpay.com` over TLS or loopback — pointing `--api-base` elsewhere sends the request credential-less and says so.
- Cleartext `http://` is refused for remote targets, and refused even on loopback when the environment is `live`.
- URLs with embedded credentials (`https://user:pass@host`) are refused outright.

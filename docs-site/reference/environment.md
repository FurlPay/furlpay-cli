# Environment Variables

The exhaustive reference. Audited 2026-11-17 by grepping every environment
access across `src/`, `lib/`, `bin/` and `scripts/`, then cross-checked
against `.env.example` — if a variable is listed here, the source reads it;
the config-file equivalent (`config.toml` network profiles) is covered in
[Configuration & Diagnostics](/guide/configuration).

Secrets live in environment variables or stdin — **never as CLI arguments** (argv is visible in process listings and shell history). Variables without the `NEXT_PUBLIC_` style prefix never reach any client bundle; they are read only by the local process.

## Setup & precedence

Bash / macOS / Linux:

```bash
export HYPERLIQUID_PRIVATE_KEY="0x..."   # or an env file you source
```

Windows PowerShell (current session):

```powershell
$env:HYPERLIQUID_PRIVATE_KEY = "0x..."
```

Persisted per-user: `setx NAME value` (new shells only) or a `$PROFILE`
script. Never place secrets in cloud-synced directories.

Precedence: **real environment > `.env` file** (loaded by dotenv from the
working directory) **> built-in default**. A value set in the shell wins over
`.env`.

Rotation: API keys are read at process start — rotating a key takes effect on
the next invocation. The keystore master key rotates by re-importing
(`wallet import`). Redaction is property-tested: private keys never appear in
errors, `toString`, JSON, or signature envelopes (`test/key-redaction.test.js`).

## Signing keys

| Variable | Used by | Notes |
|---|---|---|
| `HYPERLIQUID_PRIVATE_KEY` | Perp execution, HLP vault | Preferred. Fails closed if absent on signed surfaces. Use a delegated **API Agent key**, not your master |
| `ETH_PRIVATE_KEY` | Perp execution, HLP vault | Fallback signer (same code path) |
| `FURLPAY_HL_TESTNET` | Hyperliquid | `1` = testnet, `0` = mainnet — explicit, never silently swapped |
| `HYPERLIQUID_WALLET_ADDRESS` | Read-only account views | Default address for `account balance/positions/orders`; a signer is still required for anything that signs |
| `FURLPAY_USDC_PEG_FEED_URL` | Pre-trade peg guardrail | USDC/USD feed for the depeg monitor; defaults to CoinGecko's simple price. Any https endpoint answering `{ "usd-coin": { "usd": <number> } }`. Refreshed at most once per 30s; a failed feed is surfaced as an explicit `PEG_FEED_UNAVAILABLE` warning on every order — never a synthetic price, and a depeg halt in force stays until real data proves recovery |

## Exchange credentials

| Variable | Used by | Notes |
|---|---|---|
| `BINANCE_API_KEY` | Binance spot | Create with spot trading enabled, **withdrawals disabled**, IP-bound |
| `BINANCE_API_SECRET` | Binance spot | HMAC-SHA256 signing, `recvWindow` enforced |
| `FURLPAY_BINANCE_ENV` | Binance | `testnet` or `mainnet` — distinct constants, never silently swapped |

## RPC endpoints (public defaults; bring your own provider)

| Variable | Used by | Default |
|---|---|---|
| `STELLAR_HORIZON_URL` | tx verify, Stellar tooling | network-dependent Horizon |
| `SOLANA_RPC_URL` | `solana status/balance` | `https://api.mainnet-beta.solana.com` |
| `ETHEREUM_RPC_URL` | JS app surface | `https://cloudflare-eth.com` |
| `BASE_RPC_URL` | JS app surface | `https://mainnet.base.org` |
| `ARBITRUM_RPC_URL` | JS app surface | `https://arb1.arbitrum.io/rpc` |

## Oracle & Jupiter

| Variable | Purpose |
|---|---|
| `FURLPAY_PYTH_HERMES_URL` | Optional authorized Pyth Hermes gateway base URL — the Pyth provider is inactive without it (public Hermes is auth-gated) |
| `FURLPAY_PYTH_FEED_IDS` | JSON map `{"SOL":"0x…"}` of verified Pyth feed ids (required with the gateway); no feed ids ship baked in |
| `FURLPAY_JUPITER_API_URL` | Jupiter API base for `solana price/quote` (default: public Lite API) |

## Platform, auth & finance

| Variable | Used by | Secret | Notes |
|---|---|---|---|
| `FURLPAY_ENV` | JS app surface (pay TUI) | No | Exact string `live` opts into live-environment semantics; unset is never live |
| `ANTHROPIC_API_KEY` | AI support chat engine | **Yes** | Only the assistant chat; trading never needs it |
| `FURLPAY_FINANCE_WEBHOOK_URL` | finance events | No | Signed webhook receiver for ledger events (optional) |
| `FURLPAY_FINANCE_APPROVER_TOKEN` | `finance approval approve` | **Yes** | Shared-secret bearer token the human approver must present when set; server-side only, never argv |

## Behavior & master gates

| Variable | Effect | Default |
|---|---|---|
| `FURLPAY_LIVE` | **Live-execution master gate** (`src/capabilities/registry.ts`): signing paths call `assertLiveAllowed()`; without `FURLPAY_LIVE=1` the surface stays inert with a clear refusal. On top of per-surface credentials | unset = inert |
| `FURLPAY_NO_BROWSER` | Device auth prints the URL instead of opening a browser | unset |
| `FURLPAY_QUIET_TRUST_WARNING` | Suppresses the repeated agent-trust warning banner | unset |
| `NO_COLOR` | Presence (any value, including `0` or empty) disables all color | unset |
| `COLORTERM`, `TERM`, `WT_SESSION` | Color-level detection (truecolor / 256 / 16) | — |
| `NODE_ENV`, `FURLPAY_ENV` | Environment hints; `production`/`live` gates sandbox fixtures | — |

## What is deliberately absent

- No `FURLPAY_PRIVATE_KEY`-style master override for Stellar: Stellar keys
  live in the encrypted keystore or hardware — never env, never argv.
- No screening-vendor API keys: OFAC/travel-rule integrations are not
  implemented in this build and the CLI does not pretend otherwise.
- No `NEXT_PUBLIC_` anything: this is a CLI; secrets never ship to a browser.

## Hygiene rules the CLI enforces

- **Argv secrets are refused** — mnemonics/keys on stdin only (`wallet import`, `login --key`).
- **Terminal echo is suppressed** for interactive seed-phrase/key input.
- The session cookie attaches **only** to `furlpay.com` over TLS or loopback — pointing `--api-base` elsewhere sends the request credential-less and says so.
- Cleartext `http://` is refused for remote targets, and refused even on loopback when the environment is `live`.
- URLs with embedded credentials (`https://user:pass@host`) are refused outright.

# Examples — operations & analysis (19–30)

## 19. Binance testnet configuration

```bash
export BINANCE_API_KEY="..."
export BINANCE_API_SECRET="..."
export FURLPAY_BINANCE_ENV=testnet   # default; exact string "mainnet" opts into api.binance.com
furlpay binance balances
```

Create testnet keys at testnet.binance.vision. Testnet and mainnet are
distinct constants — never silently swapped. Withdrawals are structurally
absent from the adapter surface (no method exists to call).

## 20. Binance spot orders (gated)

```bash
furlpay binance spot buy BTCUSDT --quote 50
```

With `--wallet <agent>` the Agent Trust mandate gate runs **before** signing
(a refused order builds no HTTP request). Without a wallet flag, live orders
require explicit consent (interactive confirmation or `--yes`; non-interactive
runs without `--yes` are refused — audit H-01 fix). Status: IMPLEMENTED,
live verification BLOCKED on credentials with withdrawals disabled.

## 21. Escrow lifecycle (local ledger)

```bash
furlpay escrow create \
  --seller 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  --arbiter 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  --amount 5000 --timeout-days 7 \
  --proof-hash 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

furlpay escrow fund    --escrow-id <id> --tx-hash 0x<your real funding tx>
furlpay escrow proof   --escrow-id <id> --hash 0x<sha256-of-deliverable> --signature <sig>
furlpay escrow release --escrow-id <id> --tx-hash 0x<settlement tx>
furlpay escrow status --verbose
```

LOCAL LEDGER: fund/release require **real** `--tx-hash` values (never
fabricated); unauthorized actors and malformed proofs fail closed. Expired
escrows rehydrate correctly (C-01 fix — the refund path is never bricked).

## 22. Transaction verification (honest semantics)

```bash
furlpay tx verify <64-hex-hash> --network mainnet --output json
```

Exit codes: `0` confirmed success; `1` failed-on-chain / not found / invalid
/ lookup unavailable. A 404 is explicitly **not** "does not exist" — the
output distinguishes `CONFIRMED_SUCCESS`, `CONFIRMED_FAILED`, `NOT_FOUND`
(with the not-proof-of-absence disclaimer), `INVALID_HASH`, `UNAVAILABLE`.

## 23. Solana read-only queries (LIVE, read-only)

```bash
furlpay solana status
furlpay solana balance <base58-address>
furlpay solana price SOL
furlpay solana quote SOL USDC 100000000 --slippage-bps 50
```

Real JSON-RPC reads (epoch/slot/block height, lamport balances) and
indicative Jupiter routes. Addresses are validated base58 before any
request; RPC errors throw (never a synthetic slot). Quotes are labeled
`INDICATIVE` — **this build has no Solana signing path; nothing can fill
them**.

## 24. Oracle price queries + disagreement gate (LIVE, read-only)

```bash
furlpay oracle price SOL
furlpay oracle sources --output json
```

Live multi-source quotes (Coinbase, Kraken, Binance USDT-cross, Jupiter)
with per-asset sanity bands and a cross-source agreement gate. Verified live
2026-11-17: SOL median across 4 agreeing sources. On disagreement the CLI
prints per-source readings and **no blended price** (exit 1); no source
answering sanely → `UNAVAILABLE` (exit 2). The Pyth provider stays inactive
until you configure a gateway + verified feed IDs.

## 25. Quantitative market analysis (offline)

```bash
furlpay microstructure analytics --book depth.json
furlpay microstructure vpin --tape trades.json --bucket 1000
furlpay microstructure quotes --mid-minor 7500500 --book depth.json
furlpay algo quotes --mid-minor 7500500 --sigma-bps 8 --tau-min 5 --gamma 0.1 --k 1.5
furlpay algo breakeven --delta-bps 1 --fill-rate-h 12 --fee-bps 2 --rebate-bps 0 --sigma-bps 8 --q 50
```

Pure engines over **your supplied** data (integer-minor math, deterministic).
GLFT quotes, VPIN toxicity, AS reservation price, maker breakeven, TWAP/POV
schedules, funding z-scores, cascade composite. Schedules are plans; verdicts
are arithmetic — nothing signs or places.

## 26. Fork replay-risk inspection (read-only)

```bash
furlpay fork networks
furlpay fork inspect BTCB2
furlpay fork eligibility BTCB2 --address <btc-address>
```

Declared registry (BTCB2, BTC1, ECX — unverified declaration) plus an
offline replay-risk audit. Phase-3 surfaces (market/simulate-as-live/
liquidate/settlement) refuse with `NOT_IMPLEMENTED` — nothing is simulated
there.

## 27. Configuration validation

```bash
furlpay config validate [--output json]
```

Structural checks only (no network): canonical network passphrases, https
endpoints, slippage/risk bounds, agent-trust cap consistency. Non-zero exit
on any error — wire it into shell profiles or CI.

## 28. Automated diagnostics

```bash
furlpay doctor [--output json]
```

Real connectivity/registry checks; exits non-zero when the API liveness
check fails, so scripts can rely on it. Never transmits credentials.

## 29. Self-update and rollback

```bash
furlpay update --check     # read-only check against npm
furlpay update             # self-update, with confirmation
npm install -g @furlpay/cli@<previous>   # manual rollback
```

Installation-method aware; transmits no credentials; never touches
`~/.furlpay` (config, wallets, escrow ledger).

## 30. Uninstallation

```bash
furlpay update --uninstall        # via the installer, where supported
npm uninstall -g @furlpay/cli     # npm-managed installs
rm -rf ~/.furlpay                 # ONLY if you also want local keys/ledgers gone
```

The last line destroys your keystore, wallets and local ledgers — do it
deliberately or not at all.

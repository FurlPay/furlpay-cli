# Binance Exchange Integration

> Status: **TESTNET-READY — live verification BLOCKED on credentials.** The
> adapter is implemented and unit-tested against stubbed transport; no
> live/testnet end-to-end run has happened because API credentials are not
> configured in this environment. Every exchange error surfaces
> code + message + HTTP status — nothing is synthesized.

## Setup

```bash
# Credentials come from the environment only — never argv (visible in
# process listings and shell history).
export BINANCE_API_KEY=...
export BINANCE_API_SECRET=...

# Explicit environment — testnet and mainnet are distinct constants and are
# never silently swapped.
export FURLPAY_BINANCE_ENV=testnet    # or mainnet
```

**Credential hygiene (non-negotiable):** create the API key on Binance API
Management with **"Enable Withdrawals" explicitly DISABLED**. The adapter has
no withdrawal method on its surface at all — the capability registry reports
`withdrawals: false` structurally, and there is no code path that constructs
a withdrawal request.

## What is implemented

| Surface | Endpoint family | Notes |
|---|---|---|
| HMAC-SHA256 request signing | all private | Deterministic; injected clock; `recvWindow` enforced at the signing layer |
| Account snapshot | `GET /api/v3/account` | Balances returned verbatim as decimal strings; zero rows filtered at the adapter |
| Market order (buy) | `POST /api/v3/order` | Uses `quoteOrderQty` — the exchange computes quantity at its own precision |
| Market order (sell) | refused | Selling requires an exact base quantity; the adapter refuses to invent one from a float price |
| Limit order | `POST /api/v3/order` | `LIMIT` with `timeInForce` |
| Cancel order | `DELETE /api/v3/order` | By symbol + orderId |
| Open orders | `GET /api/v3/openOrders` | Optional symbol filter |
| 24h ticker | `GET /api/v3/ticker/24hr` | |
| Order book depth | `GET /api/v3/depth` | |

## What is NOT implemented

Declared `false` in the capability registry — never assumed:

- USD-M Futures (`fapi/v1`), COIN-M futures
- OCO orders, trailing stops
- WebSocket streams (the shared streaming engine ships separately)
- **Withdrawals** (structurally absent — see hygiene note above)

## Security boundary

Every private action passes the Agent Trust mandate gate **before** any
request is built or signed. A refused order produces zero HTTP calls — the
gate ordering is asserted in the test battery. The API secret never leaves
the signing closure; it is read from the environment only (never argv) and
never appears in the signed output.

## Verification status

| Level | Status |
|---|---|
| Unit battery (14 tests, stubbed transport) | ✅ pass |
| Signing determinism vs a fixed secret | ✅ pass |
| Secret redaction in signed output | ✅ pass |
| Testnet end-to-end | ⛔ **BLOCKED** on credentials |
| Mainnet end-to-end | ⛔ **BLOCKED** on credentials + explicit operator decision |

Testnet is the only sanctioned first-run target: create testnet keys at
[testnet.binance.vision](https://testnet.binance.vision) (spot) and
[testnet.binancefuture.com](https://testnet.binancefuture.com) (futures,
when implemented), set `FURLPAY_BINANCE_ENV=testnet`, and run the commands
above. The host constants make cross-environment leakage impossible without
an explicit code change.

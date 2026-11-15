# Bitcoin Shorting

> Shorting BTC **is supported and live** on the Hyperliquid rail: a short is
> a signed EIP-712 order with side `sell` through the exchange endpoint,
> behind the pre-trade risk engine, mandate gate and kill-switch. This doc
> covers the `furlpay short` intelligence surface and the execution path.

## Execution (LIVE)

```bash
# Open a short — real signed L1 order, risk engine enforced
furlpay hyperliquid trade --symbol BTC --side sell --size 0.05 --leverage 5

# Inspect the position (entry, mark, unrealized PnL, liquidation price)
furlpay account positions

# Close (market buy-back of the position size)
furlpay hyperliquid close BTC
```

Requires `HYPERLIQUID_PRIVATE_KEY` (or `ETH_PRIVATE_KEY`) in the environment.
The pre-trade risk engine (per-order cap, leverage cap, velocity) and the
kill-switch gate every order — the trading adapter cannot bypass them.

## Mechanism registry

```bash
furlpay short mechanisms
```

| Mechanism | Status |
|---|---|
| Hyperliquid perpetual short (`--side sell`) | **LIVE** (signed, risk-engine enforced) |
| Binance USD-M futures short | **NOT IMPLEMENTED** (futures declared `false` in the Binance capability registry) |
| CME cash-settled futures / basis trade | **N/A** (no institutional venue access — outside this CLI's scope) |

## Short-readiness signal (read-only research)

```bash
# depth.json: { bids: [{priceMinor, sizeMinor}], asks: [...] }
# trades.json: [{ sizeMinor, side: "buy"|"sell" }] — chronological
furlpay short signal --book depth.json --tape trades.json --bucket 1000
```

Evaluates the three short-entry criteria from the microstructure literature
over YOUR supplied data:

| Signal | Passes when | Rationale |
|---|---|---|
| Order-Book Imbalance | OBI ≤ −0.65 | Ask wall + collapsing bids = downward drift pressure |
| Microprice | drifted **below** mid | Seller-aggressive top of book |
| VPIN | **below** the toxic threshold (0.75) | Shorting into an informed one-sided dump is squeeze risk — the informed sellers already front-ran the entry |

The verdict is `SHORT-READY` only when **all** signals pass. This is
**analysis, not execution**: the result carries the exact live command, and
the risk engine / kill-switch still gate every real order independently.

## Risk notices

- Shorting carries liquidation risk — a leveraged short against an adverse
  move is closed by the exchange's risk engine at the mark price.
- The `furlpay short signal` result is deterministic math over your data: it
  proves nothing about the live market and is not financial advice.
- Binance futures shorts are NOT IMPLEMENTED — the capability registry
  reports `false`; do not attempt them through the Binance adapter.

## Related

- [BINANCE.md](BINANCE.md) — the Binance adapter (spot only in this build)
- Hyperliquid perp engine: `src/hyperliquid/` — signed EIP-712 execution,
  margin/liquidation engines, risk engine
- Microstructure analytics: [MICROSTRUCTURE.md](MICROSTRUCTURE.md)

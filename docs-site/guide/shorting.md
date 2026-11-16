# Bitcoin Shorting (`furlpay short`)

Shorting BTC is supported and **live on the Hyperliquid rail**: a short is a signed EIP-712 order with `--side sell` through the exchange endpoint, behind the pre-trade risk engine, the mandate gate and the kill-switch.

## Open and close a short (LIVE, signed)

```bash
# Open — same risk-engine path as any Hyperliquid order
furlpay hyperliquid trade --symbol BTC --side sell --size 0.05 --leverage 5

# Inspect, then close via reduce-only market buy-back
furlpay account positions
furlpay hyperliquid close BTC
```

## Mechanism registry (honest status per venue)

```bash
furlpay short mechanisms
```

| Mechanism | Status |
|---|---|
| Hyperliquid perpetual short (`--side sell`) | **LIVE** (signed, risk-engine enforced) |
| Binance USD-M futures short | **NOT IMPLEMENTED** — declared `false` in the capability registry |
| CME cash-settled futures / basis trade | **N/A** — no institutional venue access |

## Readiness research — analysis, never a trigger

`furlpay short signal` combines the three entry criteria from the shorting microstructure literature, evaluated over **data you supply** (read-only):

```bash
furlpay short signal --book depth.json --tape trades.json --bucket 1000
```

- **OBI ask-wall** ≤ −0.65 — selling into a stacked bid book is squeeze bait
- **Microprice drifted below mid** — informed flow leaning sell
- **VPIN non-toxic** — shorting into an informed dump is squeeze risk

A green signal is *research output*. The risk engine gates every real order independently — a signal can never execute anything by itself.

::: warning US regulatory note
Cash-settled perpetuals are restricted for US retail under the CEA. See the [Regulatory Overview](/compliance/regulatory).
:::

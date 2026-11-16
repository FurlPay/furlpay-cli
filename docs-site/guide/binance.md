# Binance Spot (`furlpay binance`)

A first-class Binance adapter built on the same architecture as the Hyperliquid engine, behind the same Agent Trust controls. **TESTNET-ready; live end-to-end verification is blocked on credentials.**

## Credentials — environment only, never argv

```bash
export BINANCE_API_KEY=...
export BINANCE_API_SECRET=...
export FURLPAY_BINANCE_ENV=testnet   # or mainnet — explicit, never silently swapped
```

::: danger API key hygiene
Create the key with **Spot Trading enabled and Withdrawals disabled**, and bind it to your workstation's IP. Withdrawal capability is *structurally absent* from the adapter — there is no method on the surface — but disabling it at Binance too means a leaked key cannot off-ramp even if that ever regressed.
:::

## Commands

```bash
furlpay binance balances                        # spot account balances
furlpay binance ticker BTCUSDT                  # 24h ticker
furlpay binance depth BTCUSDT --limit 20        # order book depth
furlpay binance spot buy BTCUSDT --quote 50     # market buy by quote amount
furlpay binance spot sell BTCUSDT --qty 0.001   # market sell by base quantity
furlpay binance open-orders [--symbol BTCUSDT]  # resting orders
furlpay binance cancel <orderId> --symbol BTCUSDT
```

## Implementation status

| Capability | Status |
|---|---|
| HMAC-SHA256 request signing (deterministic, injected clock, `recvWindow` enforced at signing) | IMPLEMENTED + TESTED |
| Spot REST client — balances, market/limit orders, cancel, open orders, ticker, book | IMPLEMENTED + TESTED (stubbed transport) |
| Signed parameters in the **request body** (`application/x-www-form-urlencoded`) — never URL query strings | IMPLEMENTED + TESTED |
| Testnet/mainnet as distinct constants — never silently swapped | IMPLEMENTED + TESTED |
| Capability registry — withdrawals structurally absent | IMPLEMENTED + TESTED |
| Agent Trust mandate gate runs **before** signing — a refused order builds no HTTP request | IMPLEMENTED + TESTED |
| USD-M futures, OCO, trailing stops, WebSocket streams | NOT IMPLEMENTED — declared `false` in the capability registry, never assumed |
| Live/testnet end-to-end | BLOCKED — needs API credentials with withdrawals disabled |

Exchange errors surface `code` + `message` + HTTP status — never a synthetic success.

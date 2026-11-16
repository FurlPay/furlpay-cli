# Market Data & Microstructure

Realtime market data from Hyperliquid validators, plus the four canonical HFT microstructure indicators computed offline over data you supply.

## Live market data (Hyperliquid)

```bash
furlpay hyperliquid status        # validator connectivity & universe
furlpay hyperliquid markets       # tradeable contracts, mark, funding, OI
furlpay market BTC                # L2 book, depth bands, OFI, micro-price
furlpay market BTC --slippage 0.5 --side buy
```

## Live trade terminal (`furlpay live <SYM>`)

The interactive terminal over the **real Hyperliquid WebSocket** (`l2Book` + `trades` channels) — the [HFT-V2 report](https://github.com/FurlPay/furlpay-cli/blob/main/HFT_V2_Advanced_Algorithms_Live_Research_Report.md) §9 P0 #1 surface:

```bash
# Interactive: L2 book + gauges + hotkeys, 4 FPS alt-screen render
furlpay live BTC

# With GLFT reservation quotes and the cascade regime on-screen
furlpay live BTC --gamma 0.1 --sigma 0.02 --kappa 1.5 --funding 0.0002

# Headless single-frame diagnostics (CI-safe, no socket, no TTY)
furlpay live BTC --once --no-connect
```

What's on screen:

- **Order book** — top-of-book depth in integer minors, spread bar
- **Gauges** — OBI (ask-wall/bid-wall/balanced), Stoikov micro-price (below/above mid), **rolling VPIN** over the live trade tape (bucket configurable via `--vpin-bucket`), optional cascade regime and GLFT reservation
- **Execution log** — millisecond-stamped local events (connect, feed regression, resync, panics)
- **Hotkeys** — `q`/`Esc`/`Ctrl-C` quit (alt-screen leave, scrollback preserved); `r` honest resync (re-subscribe — HL pushes full books, a fresh subscription *is* the resync); `Space` PANIC

::: warning Feed discipline & panic honesty
An l2Book push whose timestamp regresses **freezes the book** (STALE) — an old book is never rendered as current; disconnect renders DISCONNECTED, never a fake book. The terminal never places, signs or broadcasts: `[Space]` prints the signed kill-switch command, and only spawns the real `furlpay trading kill-switch` subprocess with explicit `--allow-panic` — that command still runs the risk engine and fails closed without a signer.
:::

## Microstructure analytics (offline, supplied data)

```bash
furlpay microstructure analytics --book depth.json   # EW OBI + Stoikov microprice
furlpay microstructure vpin --tape trades.json --bucket 1000
furlpay microstructure quotes --book depth.json --inventory +0.5 --risk 0.1
```

| Tool | Model | Notes |
|---|---|---|
| `analytics` | Exponentially-weighted order-book imbalance + Stoikov micro-price | Integer-minor math |
| `vpin` | Easley / López de Prado / O'Hara VPIN | Fixed-volume buckets, trailing partial bucket excluded per the model |
| `quotes` | Avellaneda-Stoikov reservation price & optimal bid/ask | For an inventory position |

Also exposed as read-only MCP tools (`microstructure_analytics`, `microstructure_vpin`, `microstructure_quotes`) — see [MCP Agents](/guide/agents).

## Streaming engine (state machines, transport-agnostic)

The `L2DeltaBook` / `RollingVpin` / `WsConnectionManager` engine implements the full live-market discipline:

- **Sequence-gap poisoning** — a missed delta forces a REST resync; the book never silently diverges
- **Rolling VPIN** accumulator emits verdicts on bucket completion
- Exponential backoff, heartbeat-staleness detection, subscription dedup/cap

Wire a real socket into `connect()` to go live — the state machines are identical. Exposed via `furlpay realtime` tooling.

## Sweep artifact utilities (offline, review-only)

```bash
furlpay fork simulate …      # slippage simulator over a supplied depth snapshot
furlpay fork psbt-inspect …  # BIP-174 PSBT wire inspector
furlpay fork opreturn …      # BTC1 OP_RETURN barrier builder (≥83B, minimal push)
furlpay fork taint-plan …    # BTCB2 per-output taint plans
```

Integer minor math, deterministic, depth+cap refusals. All artifacts are **review-only — never broadcast**.

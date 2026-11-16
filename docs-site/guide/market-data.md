# Market Data & Microstructure

Realtime market data from Hyperliquid validators, plus the four canonical HFT microstructure indicators computed offline over data you supply.

## Live market data (Hyperliquid)

```bash
furlpay hyperliquid status        # validator connectivity & universe
furlpay hyperliquid markets       # tradeable contracts, mark, funding, OI
furlpay market BTC                # L2 book, depth bands, OFI, micro-price
furlpay market BTC --slippage 0.5 --side buy
```

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

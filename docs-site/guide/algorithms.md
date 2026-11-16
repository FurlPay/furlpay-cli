# Quantitative Algo Engines (`furlpay algo`)

The research-driven analysis surface — every engine implements a formula from the [HFT V2 research report](https://github.com/FurlPay/furlpay-cli/blob/main/HFT_V2_Advanced_Algorithms_Live_Research_Report.md), runs **offline over data you supply**, and fails closed on malformed input.

::: warning Honesty scope
Schedules are **plans**, verdicts are **arithmetic**. Nothing here places, signs or broadcasts an order, and no live edge is ever claimed. When the WebSocket engine ships, it feeds these same pure engines.
:::

## `algo quotes` — GLFT closed-form quotes

The Guéant–Lehalle–Fernandez-Tapia model — the deployable quoting frontier per the 2026 literature (hftbacktest ships a full implementation), adding the ½γσ²τ volatility term that the Avellaneda-Stoikov variant omits:

```text
δa + δb = γσ²τ + (2/γ)·ln(1 + γ/k)      (total spread)
r       = s − q·γσ²τ                     (inventory-skewed reservation)
p(δ)    = e^(−kδ)                        (GLFT fill probability)
```

```bash
furlpay algo quotes --mid 6482150 --gamma 0.1 --sigma 0.02 --kappa 1.5 [--inventory q] [--time-left 1]
```

## `algo schedule` — micro-TWAP / POV execution planning

Poisson-jittered time slices (deterministic for a pinned `--seed`), sizes reconciling **exactly** to the parent amount in BigInt — no minor unit minted or lost. POV mode caps participation at `--cap` (default 3.5%) over a supplied per-minute volume profile and **fails closed without one** — the tool refuses to guess volume.

```bash
furlpay algo schedule --amount 1000000000 --duration 900 --slices 12 --seed 42
furlpay algo schedule --amount 5000000 --duration 3600 --mode pov --volume profile.json --cap 0.035
```

An incomplete POV plan (observed volume < parent amount at the cap) reports the remainder — it never auto-chases the tail, because chasing the tail is how POV orders become impact events.

## `algo report` — Implementation Shortfall scorecard

IS is measured against **your arrival price** — the only honest scorecard, since it's the decision price, not a mid the executor can pick. Exact BigInt accounting: `Σ size·(price − arrival)`, VWAP with the division remainder surfaced, fees in minor units and bps.

```bash
furlpay algo report --arrival 10000 --fills fills.json   # [{ priceMinor, sizeMinor, feeMinor? }]
```

## `algo breakeven` — maker ship/no-ship arithmetic

The §7.1 objective function as a decision tool:

```text
E[PnL/hour] = λ·(δ − a − c) − ½γσ²q²   (bps)
```

λ is your **observed** fill rate at that spread — the fill-probability adjustment (arXiv:2502.18625) enters through λ: widening δ lowers λ, and the tool refuses to pretend otherwise.

```bash
furlpay algo breakeven --half-spread 2 --toxicity 1 --fee 0.5 --fills 10 --inventory 1 --gamma 0.1 --sigma 0.02
```

## `algo queue` — fluid queue-position estimate

Transparent fluid model: the queue ahead drains at (trade rate + cancel rate). Estimates seconds-to-front and fill probability within your horizon. Useful for ALO quoting sanity — if the queue can't clear in your horizon, the quote is dead inventory. (Approximation, not the full Moallemi queue-value model.)

```bash
furlpay algo queue --ahead 100000 --trade-rate 150 --cancel-rate 50 --horizon 60
```

## `algo funding` — persistence z-score + honest carry

Funding entry needs **both** a z-score above threshold (default 2.0) over your supplied ≥8-sample per-8h history and operator OI confirmation. A single high print is not a signal. Annualized gross uses `f̄·3·365`; the verdict reminds you that crowding compresses funding, both legs pay fees, and basis drift forces rebalances.

```bash
furlpay algo funding --history funding.json --z 2.0 --fees 8
```

## `algo cascade` — liquidation-cascade regime flag

Composite of the three cascade signatures: funding spike (≥5 bps/8h), ask-wall OBI (≤ −0.65), toxic VPIN (≥ 0.75). Score ≥ 2 → `CASCADE-LIKELY` → reduce maker exposure.

::: danger There is no sniping edge
Per the V2 report §5 correction: Hyperliquid routes liquidations through the book **without discount**; failed liquidations go to the HLP backstop (which you can participate in live via [`earn hlp`](/guide/hyperliquid)). The cascade tool is analysis only — every response carries this correction.
:::

```bash
furlpay algo cascade --funding 0.0006 --obi -0.7 --vpin 0.8
```

## MCP exposure (read-only)

AI agents get the same math through three read-only tools: `algo_glft_quotes`, `algo_breakeven`, `algo_cascade` — annotated `readOnlyHint`, offline-labeled in every response. See [MCP Agents](/guide/agents).

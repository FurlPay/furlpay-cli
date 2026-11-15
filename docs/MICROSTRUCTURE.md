# Market Microstructure Analytics

> The four canonical HFT indicators as pure deterministic functions over
> caller-supplied data. **No live venue feed exists in this build** — the
> analytics run offline on your depth snapshots and trade tapes. The
> WebSocket streaming engine (Phase 3) will feed these same functions live.

## Commands

```bash
# OBI + Stoikov microprice over a depth snapshot
furlpay microstructure analytics --book depth.json [--levels 10] [--lambda 0.5]

# Order-flow toxicity (Easley/López de Prado/O'Hara)
furlpay microstructure vpin --tape trades.json --bucket 100000000 [--toxic-threshold 0.75]

# Avellaneda-Stoikov reservation price + optimal quotes
furlpay microstructure quotes --mid-minor <n> --inventory <q> \
  --risk-aversion <γ> --sigma <σ> --kappa <κ> [--time-left <T>]
```

All subcommands accept `--json` for machine-readable output.

## Data formats

**Depth snapshot** (`--book`): integer-minor decimal strings — floats are
refused at the math layer.

```json
{
  "bids": [{ "priceMinor": "99000000", "sizeMinor": "2000000" }],
  "asks": [{ "priceMinor": "101000000", "sizeMinor": "1000000" }]
}
```

**Trade tape** (`--tape`): chronological, oldest first.

```json
[
  { "sizeMinor": "500", "side": "buy" },
  { "sizeMinor": "500", "side": "sell" }
]
```

## The four indicators

### 1. Order-Book Imbalance (OBI)

Exponentially weighted depth asymmetry over the top `levels` levels, weights
`wᵢ = e^(−λ(i−1))`, λ default 0.5. Bounded [−1, 1]: negative = ask-heavy
(downward drift pressure). Signal thresholds in the CLI: ≤ −0.65
"downward-drift (ask wall)", ≥ +0.65 "upward-drift (bid wall)".

### 2. Microprice (Stoikov)

Volume-weighted top-of-book estimator: `P = Pᵇ(Vᵃ/(Vᵇ+Vᵃ)) + Pᵃ(Vᵇ/(Vᵇ+Vᵃ))`.
Computed as an exact BigInt rational with a bounded 6-decimal output. The
CLI reports `driftedBelowMid` — micro under mid = seller-aggressive top of
book. The microprice never crosses the book.

### 3. VPIN (Volume-Synchronized Probability of Informed Trading)

Easley/López de Prado/O'Hara: split the chronological tape into fixed-volume
buckets; `VPIN = Σ|V_B − V_S| / (N·V)`. The trailing partial bucket is
**excluded** per the model (a half-filled bucket biases the ratio). Above
the toxic threshold (default 0.75) the flow is informed/toxic — passive
quotes get picked off.

### 4. Avellaneda-Stoikov quoting

Reservation price `R = s − qγσ²(T−t)` and optimal half-spread
`δ = (1/γ)·ln(1 + γ/κ)`. A net-short inventory (`q < 0`) **raises** the
reservation (cover bias); a net-long lowers it. Quotes are
`R ± δ`, rounded to integer minor.

## Precision contract

All prices, sizes and volumes are **integer-minor decimal strings** handled
via BigInt — no IEEE 754 floats on any money path. Dimensionless ratios
(OBI, VPIN) are the only Numbers emitted, converted from exact BigInt
rations at the final boundary. Fail-closed everywhere: missing sides,
malformed inputs and unreadable values are refusals, never zeros.

## MCP exposure

The same functions are available to AI agents as read-only tools:
`microstructure_analytics`, `microstructure_vpin`, `microstructure_quotes`
(all `readOnlyHint: true`; see the MCP section in the README).

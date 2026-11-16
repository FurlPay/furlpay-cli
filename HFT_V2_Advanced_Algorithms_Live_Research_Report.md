# HFT Alpha Catalog V2 — Live-Researched Algorithms, Speed Features & Profitability Math

## Companion Volume to the Institutional HFT Execution Blueprint — What the 2025–2026 Literature Actually Says

**Compiled for:** FurlPay CLI Terminal (`@furlpay/cli`)
**Date:** November 17, 2026
**Method:** Live research sweep across 2025–2026 academic literature (arXiv, SSRN, JFE, Quantitative Finance), practitioner engineering guides (hftbacktest, Hummingbot, Jito, AWS), and venue documentation (Hyperliquid, Solana/Jito, Binance).
**Relationship to prior work:** Extends `HFT_Execution_and_Alpha_Trading_Algorithms_Research_Report.md` (v1). Where v1 specified the architecture and a first algorithm set, this volume adds (a) the models the current literature has **superseded**, (b) a correction to the liquidation-strategy mechanics, (c) the profitability arithmetic that decides whether an algorithm makes money at all, and (d) a prioritized, command-mapped feature roadmap. Nothing here is implemented in the CLI unless marked otherwise — every proposal stays inside the [honesty matrix](docs/audits) discipline.

---

## Table of Contents

1. [Executive Summary — What Changed Since the Blueprint](#1-executive-summary)
2. [User-Friendly Speed: Feature-Gap Analysis](#2-user-friendly-speed-feature-gap-analysis)
3. [Latency Engineering V2 — Measured Budgets & New Venue Techniques](#3-latency-engineering-v2)
4. [Alpha Catalog V2 — Superseding Models & New Signals](#4-alpha-catalog-v2)
5. [Correction: Liquidation "Sniping" vs. Backstop Liquidity on Hyperliquid](#5-liquidation-correction)
6. [Where Arbitrage Edge Actually Lives in 2026](#6-arbitrage-reality)
7. [Profitability Math — The Formulas That Decide Survival](#7-profitability-math)
8. [Risk Engine V2](#8-risk-engine-v2)
9. [Prioritized Roadmap (P0/P1/P2) Mapped to CLI Commands](#9-roadmap)
10. [Sources](#10-sources)

---

## 1. Executive Summary

The v1 blueprint specified Avellaneda-Stoikov with OFI drift, VPIN gating, spatial/funding/liquidation arbitrage, and adaptive micro-TWAP. The live research sweep found five things that materially change the plan:

1. **Avellaneda-Stoikov is no longer the quoting frontier.** The Guéant–Lehalle–Fernandez-Tapia (**GLFT**) model provides closed-form asymptotic quotes that practitioners deploy directly (hftbacktest ships a full GLFT tutorial), and **2026 deep-RL market makers trained under regime shifts reportedly outperform GLFT** (arXiv:2609.11614). The CLI's `microstructure quotes` surface should gain a `--model glft` path.
2. **A material correction to v1's liquidation-sniping algorithm.** Hyperliquid routes liquidations through the order book **without discount**, and only when book liquidity fails do positions go to the HLP Liquidator Vault. There is no "resting bid at mark −1.8% catches discounted liquidations" trade. The real, compensated strategy is **being the backstop** — HLP deposits — which the CLI already supports live via `earn hlp`.
3. **Adverse selection is the whole game.** 2026 literature (Clapham; Multicoin Capital; the fill-probability-vs-post-fill-returns trade-off) converges on one formula: a market maker's expected PnL is spread capture minus adverse-selection cost, and the second component dominates. Every quoting decision is a position in that trade-off, not a prediction.
4. **Speed is a UX problem as much as an infrastructure problem.** Hotkey-driven execution cuts order entry from 2–3 s to **150–200 ms**; terminal emulators add **50–100 ms** of input latency when naively implemented; web dashboards sit at **250 ms–3 s** signal-to-order. The CLI's advantage is structural — but only with a real raw-mode TUI and pre-computed signers.
5. **Arbitrage edge migrated.** Cross-exchange spreads on majors are largely competed away; what remains is long-tail venue fragmentation, funding persistence on crowded-perp events, HIP-3 builder markets on Hyperliquid, and Solana Jito bundle economics (dynamic tipping, ShredStream, `dontfront` MEV protection).

**Bottom line for FurlPay CLI:** the winning surface is (GLFT-grade quoting + toxicity-gated withdrawal + backstop-yield participation + hotkey TUI), wrapped in the existing risk engine and honesty labels. Section 9 maps every increment to a concrete command.

---

## 2. User-Friendly Speed: Feature-Gap Analysis

Research benchmark numbers (2026 practitioner sources):

| Interaction path | Measured latency | Source |
|---|---|---|
| Hotkey order entry (professional platforms) | **150–200 ms**, vs 2–3 s mouse-driven | TradeAlgo hotkey guide |
| Terminal emulator input latency (naive TUI) | **50–100 ms** keyboard→render | Baidu Cloud TUI rendering analysis |
| Web dashboard signal-to-order (e.g., TradingView automation) | **250 ms – 3 s median** | key-trade.net analysis |
| Sub-20 ms hotkey execution bridges (native, global hotkeys) | **< 20 ms** achievable | ezmt5 HotkeyBridge |
| Dedicated trading keyboards | 30–50% faster order entry in benchmarks | key-trade.net 2026 guide |

### Feature gaps in the current CLI (and the fix for each)

| Gap | Impact | Feature to build | Effort |
|---|---|---|---|
| No persistent TUI — commands are fire-and-exit | Every market event costs a full CLI boot (200–600 ms Node startup) | `furlpay trade terminal --live`: alt-screen, 30–60 FPS delta rendering, L2 book + OFI/micro-price/VPIN gauges + positions pane (v1 §2 sketch) | L |
| No hotkey layer | 2–3 s of mouse/typing per order | Vim-modal keys in the TUI: `b`/`s` ALO limit at touch, `Shift+B/S` market within risk clip, `Space` = atomic cancel-all + reduce-only flatten | M |
| No order templates | Bracket entry requires 3 separate commands | Single-key bracket: entry + SL (−0.8%) + TP (+1.6%) in one signed payload | S |
| Signing in the hot path | 80–350 μs per ECDSA sign, plus key-lookup | Pre-warmed signer session (agent wallet), pre-computed domain separators; only price/size/nonce packed at fire time | S |
| No execution log with timestamps | No way to audit one's own latency | Millisecond-stamped execution log pane (v1 mock shows the format) | S |
| No natural-language intent layer | Complex multi-leg trades are error-prone | MCP copilot: `furlpay exec "arb BTC when Binance leads HL by >15 bps, size $5k"` — validated against the deterministic risk matrix before any signing | M |

> Honest-labeling rule: the TUI shows what the engines compute (OBI, VPIN, micro-price are already implemented offline); anything not yet wired to a live feed renders `unavailable`, never a fabricated number.

---

## 3. Latency Engineering V2

### 3.1 The tick-to-trade budget (updated with 2026 references)

| Stage | Budget | Technique |
|---|---|---|
| Feed ingress → parse | ≤ 20 μs | Zero-copy/SIMD JSON or MsgPack; kernel bypass (DPDK/Onload) where bare metal allows |
| Book update + signal update (OFI, VPIN, micro-price) | ≤ 10 μs | Lock-free SPSC ring buffer (LMAX Disruptor pattern); pre-allocated pools — **zero heap allocation in the hot path** |
| Risk gate | ≤ 5 μs | Deterministic, branch-predictable checks (v1 §6 table) |
| Sign | ≤ 10 μs marginal | Pre-computed EIP-712/Ed25519 scaffolding; agent wallet sessions |
| Transmit | venue-bound | Persistent WebSocket (HL), gRPC (Jito), pinned sockets (Binance) |
| Logging | 0 (off-path) | **Defer formatting + I/O off the hot path** — the single most-cited practitioner fix (r/cpp HFT thread) |

Infrastructure references: AWS digital-asset guide (Apr 2026) shows correct instance sizing + bare metal cuts **p99.9 tail latency by up to 29%**; NUMA pinning and CPU isolation are table stakes; the Zenodo (Jul 2026) low-latency architecture survey and Quod Financial's co-location overview give the full stack.

### 3.2 Venue acceleration — what's new since v1

**Hyperliquid.** v1 specified WebSocket POST actions — keep. Add: non-validator nodes with `--disable-output-file-buffering` and `split_client_blocks: true` (shaves 100–200 ms of client block assembly), and `alo: true` everywhere in market-making to guarantee maker economics.

**Solana / Jito.** v1 covered bundles + tight CU packing. v2 additions from Jito/Solana docs and RPCFast:
- **ShredStream integration** — subscribe to shreds for leader-slot awareness; submit the instant the next leader's slot opens (sub-slot routing).
- **Dynamic tip optimization** — track the rolling tip floor (e.g., 75th percentile ≈ 12,000 lamports baseline) instead of static tips; overpaying tips silently destroys arb PnL.
- **`dontfront` / MEV protection** — Solana's documented sandwich-protection path; combine with Warp transactions and trader nodes.
- **Bundle economics** — up to 5 txs atomic per bundle; failed bundles drop off-chain with **zero revert footprint** (no base-fee burn), which is the whole reason to bundle arb legs.

**Binance.** v1's `@bookTicker` (10 ms vs 100 ms depth) and socket pinning stand; add redundant 3-socket lowping selection as a rotating health check rather than a fixed pin.

**Stellar.** v1's pre-authorized SEP-8 tokens and Protocol 28 fleet-contract refs stand. Add queue-awareness: the SCP consensus path makes sub-second latency competition futile — the edge here is **pre-flight compliance caching** (no approval-server round-trip in the hot path), not speed racing.

---

## 4. Alpha Catalog V2

### 4.1 Quoting models — the state of the art

| Model | What it is | Status vs v1 |
|---|---|---|
| **Avellaneda-Stoikov + OFI drift** (v1 §5.1) | Reservation price with inventory penalty + flow drift | Superseded as the *default*; keep as the interpretable baseline |
| **GLFT (Guéant–Lehalle–Fernandez-Tapia)** | Closed-form asymptotic quotes for finite horizons; deployable as-is; hftbacktest ships a full implementation tutorial | **Adopt as the quoting engine** (`microstructure quotes --model glft`) |
| **Stoikov, "Market Making in Crypto" (SSRN 2024)** | Crypto-specific re-derivation for perpetual contracts — liquidity provision, risk, profit under perp funding mechanics | Read and fold funding into the reservation price: quoting a perp ignores funding at your peril |
| **Deep RL MM under regime shifts** (arXiv:2609.11614, Moret et al. 2026) | RL market maker trained in a zero-intelligence LOB; **outperforms GLFT baseline** in the paper | Research track: the CLI's offline VPIN/OBI features are exactly the state vector such a policy consumes |
| **Multi-level quoting RL** (arXiv:2608.18195, Cheridito et al.) | RL quoting at *multiple* book levels, not just best | Research track; requires queue-position modeling (§4.2) |

Practical instruction for the CLI: ship `--model as` and `--model glft` now; expose the RL policies later as `--model rl --weights <file>` with the same honesty labels (`untrained` / `backtest-only` — never claim live-validated alpha).

### 4.2 Signals — new and validated for crypto in 2025–2026

1. **OFI → price impact, measured on crypto** (Khan, JAIET 2026). OFI is not just a skew input; it has a measured linear price-impact coefficient in crypto books. Use it for (a) quote skew, (b) a *short-horizon impact forecaster* for execution scheduling.
2. **Second-level order-flow toxicity** (Rajendran, ScienceDirect 2026) — perp-futures-specific toxicity detection at 1s granularity. Complements VPIN (volume-bucketed) with a faster-reacting clock. Engine: run both; VPIN as regime gate, 1s toxicity as tripwire.
3. **The Quarter-Hour Effect** (arXiv 2026) — periodic algorithmic trading on crypto perps; opening order imbalance predicts returns over **4–12 hours**. Cheap to compute, scheduleable (`furlpay algo scan --cron 15m`), and orthogonal to the microstructure loop.
4. **Queue-position valuation** (Moallemi). For maker strategies, your *expected* PnL depends on queue position behind the best bid/ask. Combine with **state-dependent Hawkes processes** (Morariu-Patrichi & Sabzehzar; Mucciante & Sancetta) where cancel/join intensities are functions of queue imbalance — the literature's standard machinery for estimating when you actually reach the front. Input to: ALO quoting decisions and fill-probability estimates.
5. **Hawkes-compound LOB models** (arXiv:2312.08927; Oxford dissertation) — the simulator backbone for backtesting any of the above without fabricating fills.

### 4.3 Adverse-selection economics — the 2026 consensus

- **Multicoin Capital, "Adverse Selection Rules Everything Around Me" (Feb 2026)** — informed flow is toxic to makers; venue design, not just quoting, is a defense.
- **Clapham (SSRN 2026), "Market Making without Adverse Selection"** — price the *predictable uninformed* flow separately from inventory cost; isolating adverse selection from inventory is the analytical prerequisite for correct quoting.
- **Fill probability vs. post-fill returns** (arXiv:2502.18625) — the modern formulation of the maker's dilemma: raising fill probability systematically raises the toxicity of what fills. Quote placement is choosing a point on this curve.

These three give the CLI its quoting objective function: **maximize E[spread capture] − E[adverse selection] − inventory cost**, not "get filled."

### 4.4 Execution algorithms — the 2026 trend is *adaptive switching*

The taxonomy is stable (TWAP / VWAP / POV / IS), but 2026 practitioner literature (CoinRoutes, Quod Financial's 20+-algo taxonomy, BraiVIQ's implementation guide) converges on **adaptive schedules that switch between them** using real-time book state:

- **IS (Implementation Shortfall)** measured against **arrival price**; front-load when impact+timing risk is high.
- **POV** with a hard participation cap (v1: 3.5% of rolling 1-min volume) — keep.
- **Micro-TWAP** with Poisson slicing and Stoikov-microprice pegging (v1 §5.6) — keep; it *is* the adaptive variant.
- New: **generative LOB models** (paperswithbacktest, Oct 2026 — tokenize the order-message stream, predict the next message) as the test harness for execution algos before any live sizing. The CLI's existing offline simulators are the right substrate.

### 4.5 RL caution — the honest note

Practitioner consensus (MLQ): RL is most reliable in **execution, market making, hedging** — not directional alpha. Even a 53%-accuracy predictor loses money after fees. Any CLI "algo" surface must therefore present *execution/MM* RL first and treat directional models as research, with backtest-only labels. This is the same discipline as the honesty matrix.

---

## 5. Correction: Liquidation "Sniping" vs. Backstop Liquidity on Hyperliquid

v1 §5.5 sketched "resting limit buys at mark −1.8% to catch discounted liquidations." **The live venue mechanics make that trade structurally different:**

1. **Liquidations hit the order book without a discount.** Per Hyperliquid's own docs, liquidation orders are routed to the book like any other order.
2. **When book liquidity is insufficient** (equity below 2/3 of maintenance margin and the book can't absorb), the position goes to the **backstop liquidation via the Liquidator Vault (part of HLP)** — maintenance margin is *not* returned to the liquidated trader; that's the backstop's compensation.
3. **Backstop flow is adversely selected by construction** — it fills precisely when the book can't (the most toxic moments). The $26M ETH-short unwind (NewsBTC/TradingView) is the case study: the backstop absorbed 1,417 ETH of residual.
4. Academic treatment: **ADL impossibility/optimization** (arXiv:2512.01112) analyzes exactly this HLP-vs-ADL cost structure under cascades.

**Revised strategy for the CLI:**
- Do **not** ship a "liquidation sniping" mode — the edge described in v1 does not exist as specified, and pretending otherwise violates the honesty rules.
- The compensated exposure to liquidations is **HLP participation**, which the CLI already supports live (`furlpay earn hlp deposit` / `stats`) with real signed `vaultTransfer` actions and live-derived stats.
- What IS buildable: a **cascade monitor** (`furlpay short signal` extension) that flags liquidation-cascade regimes (funding spike + OBI flip + VPIN spike) as *analysis* — inputs for reducing maker exposure or preparing taker entries, never an execution trigger.

---

## 6. Where Arbitrage Edge Actually Lives in 2026

Practitioner reality check (r/algotrading, 2026 guides): cross-exchange spreads on major pairs between top-tier venues are **largely competed away**; bots still run but "rarely trigger." The surviving edges:

| Edge | Why it survives | CLI vehicle |
|---|---|---|
| **Long-tail venues** | Small/less-efficient venues reprice slower | Binance adapter (done, testnet-blocked) + future venue adapters |
| **Funding persistence** | Crowded longs keep funding high for hours; crowding shrinks it slowly | Funding arb (§7.2 math); monitor crowding |
| **Liquidation cascades** | Dislocations of 0.5–2% appear during forced unwinds, then revert | Cascade monitor + pre-positioned maker inventory on the reverting venue |
| **HIP-3 builder markets** | New Hyperliquid builder-deployed perp markets (equities, FX, commodities) start thin and mispriced | Watch HIP-3 universe in `hyperliquid markets` |
| **Solana bundle arb** | Atomic 5-tx bundles with zero revert footprint make CEX→DEX leg risk asymmetric | Future: Jito bundle engine (P2 roadmap) |
| **Pre-funded, zero-transfer settlement** | Transfer latency kills spatial arb; inventory rebalancing happens later, in size | Requires multi-venue inventory — pairs with Binance activation |

---

## 7. Profitability Math

### 7.1 The maker's breakeven (from §4.3)

For quotes of half-spread $\delta$ with fill probability $p(\delta)$ and adverse-selection cost $a(\delta)$ per filled unit:

$$E[\text{PnL per fill}] = \delta - a(\delta) - c_{\text{fee}} - c_{\text{inventory}}$$

Ship the maker only when positive. Three facts from the literature that determine sign:
- $a$ grows with fill probability (arXiv:2502.18625) — wide quotes that never fill earn exactly zero;
- fee tier dominates at crypto scale: a 1.5 bps maker rebate vs 4.5 bps taker fee flips which side of the trade is viable;
- inventory cost is $\tfrac{1}{2}\gamma\sigma^2 q^2$ per unit time (the AS/GLFT term) — it punishes stale inventory even without adverse fills.

### 7.2 Funding-arb expected carry (the honest version)

$$E[\text{carry}] = \bar{f} \cdot T - 2 \cdot c_{\text{taker/maker}} - E[\text{basis drift cost}] - \text{margin buffer drag}$$

- Funding persistence is the alpha: enter when the funding z-score is high **and** open-interest momentum confirms crowding (not merely because funding printed high once).
- The "free money" framing fails because crowding compresses $\bar f$, fees are paid on both legs, and basis drift forces rebalances (Renesis 2026; Hyperdash 2026).
- Liquidation buffer: 1×-leverage short leg still needs margin headroom for the *residual* basis move; size the buffer from the Kalman-filter residual σ (v1 §5.4), not from nothing.

### 7.3 Sharpe expectations, stated honestly

- Maker strategies in liquid crypto perps: high trade counts, thin per-trade edges, Sharpe driven almost entirely by the adverse-selection term — regime shifts (§4.1 RL paper) are the failure mode.
- Funding arb: low Sharpe until leverage; tail risk is exchange/liquidation risk, not price risk.
- Taker cascade trades: fat right tail, negative skew *before* discipline; VPIN/OBI gating exists to avoid catching the falling knife.

No CLI surface should ever print an expected Sharpe that wasn't produced by the offline simulator over supplied data.

---

## 8. Risk Engine V2

Extends the v1 §6 table with what the research adds:

| Guardrail | Threshold | Basis |
|---|---|---|
| (all v1 rows) | order clip, leverage cap, 15 orders/s token bucket, ±1.5% fat-finger band, 3%/60s drawdown kill, 3-gap socket poisoning, OFAC fail-closed | v1 — unchanged |
| **Toxicity tripwire** | 1s order-flow toxicity > threshold → pull quotes | Rajendran 2026 (faster than VPIN buckets) |
| **Regime detector** | Rolling realized-vol regime flag → widen spreads / halve size | arXiv:2609.11614 failure mode |
| **Funding-crowding gate** | Enter funding arb only if funding z-score > 2 *and* OI momentum confirms | §7.2 |
| **Queue-depth sanity** | ALO quotes only when estimated queue position ≤ k ticks | Moallemi valuation |
| **Bundle-risk cap (Solana, future)** | Max tip spend per slot; abort if tip floor > expected arb edge | §3.2 economics |

---

## 9. Prioritized Roadmap (P0/P1/P2) Mapped to CLI Commands

**P0 — speed & correctness on surfaces that already exist**
1. `furlpay trade terminal --live` — alt-screen TUI: L2 book, OFI/micro-price/VPIN gauges, positions, millisecond execution log, `Space` panic (cancel-all + reduce-only flatten). *(v1 M1 core; the single highest-leverage UX feature.)*
2. Pre-warmed signer session + pre-computed EIP-712 scaffolding (agent wallets).
3. Hotkey layer (`b`/`s`/`Shift+B`/`Shift+S`/bracket) behind the risk engine.
4. `microstructure quotes --model glft` alongside `--model as`.

**P1 — alpha surfaces on live rails**
5. Funding-arb monitor: `furlpay algo scan funding --symbol SOL --z 2.0 --confirm-oi` (analysis + gated execution on Hyperliquid leg; Binance leg after testnet activation).
6. Cascade monitor extension to `furlpay short signal` (funding + OBI + VPIN composite) — analysis-only labeling.
7. Queue/Hawkes estimation module feeding ALO quoting decisions (offline first; uses supplied data, honest labels).
8. Adaptive execution engine: `furlpay algo run --strategy micro-twap|is|pov --adaptive` with arrival-price reporting per fill.

**P2 — new venues & research tracks**
9. Jito bundle engine (ShredStream, dynamic tips, `dontfront`) for Solana legs.
10. HIP-3 builder-market universe in `hyperliquid markets` + long-tail inventory pre-funding planner.
11. RL policy loader (`--model rl --weights …`) with `backtest-only` labels; generative-LOB test harness for any policy before live sizing.
12. MCP copilot (`furlpay exec "…"` natural-language intents validated by the deterministic risk matrix).

---

## 10. Sources

**Quoting models & market making**
- [GLFT Market Making Model and Grid Trading — hftbacktest docs](https://hftbacktest.readthedocs.io/en/py-v2.1.0/tutorials/GLFT%20Market%20Making%20Model%20and%20Grid%20Trading.html)
- [Stoikov — Market Making in Crypto (SSRN 2024)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5066176)
- [Avellaneda Market Making — Hummingbot](https://hummingbot.org/strategies/v1-strategies/avellaneda-market-making)
- [Moret et al. — Deep Learning of Robust Market Making under Regime Shifts (arXiv:2609.11614)](https://arxiv.org/abs/2609.11614)
- [Cheridito et al. — Multi-Level Market Making with RL (arXiv:2608.18195)](https://arxiv.org/abs/2608.18195)
- [How Professional Market Makers Implement Avellaneda-Stoikov (Medium)](https://medium.com/@gwrx2005/design-and-implementation-of-a-low-latency-high-frequency-trading-system-for-cryptocurrency-markets-a1034fe33d97)

**Microstructure signals**
- [Khan — Order-Flow Imbalance and Price Impact in Cryptocurrency (JAIET 2026)](https://www.ingentaconnect.com/content/nvp/jaiet/pre-prints/content-jaiet-2026-00001)
- [Rajendran — Order-flow toxicity in cryptocurrency perpetual futures (2026)](https://www.sciencedirect.com/science/article/pii/S2405918825000331)
- [The Quarter-Hour Effect — periodic trading on crypto perps (arXiv)](https://arxiv.org/html/2601.02385v1)
- [Moallemi — A Model for Queue Position Valuation in a Limit Order Book](https://moallemi.com/ciamac/papers/queue-value-2016.pdf)
- [Morariu-Patrichi & Sabzehzar — State-dependent Hawkes processes (Quantitative Finance)](https://www.tandfonline.com/doi/full/10.1080/14697688.2021.1983199)
- [Mucciante & Sancetta — Estimation of an Order Book Dependent Hawkes Process (J. Financial Econometrics)](https://academic.oup.com/jfec/article/22/4/1098/7241580)
- [Compound Hawkes Process LOB modeling (arXiv:2312.08927)](https://arxiv.org/html/2312.08927v3)
- [Oxford — Hawkes Process-Driven Models for Limit Order Book Dynamics](https://www.maths.ox.ac.uk/system/files/attachments/Hawkes%20Process-Driven%20Models%20for%20Limit%20Order%20Book%20Dynamics_0.pdf)
- [Easley, López de Prado & O'Hara — The VPIN metric (original paper)](https://www.quantresearch.org/VPIN.pdf)

**Adverse selection**
- [Multicoin Capital — Adverse Selection Rules Everything Around Me (Feb 2026)](https://multicoin.capital/2026/02/17/adverse-selection-rules-everything-around-me)
- [Clapham — Market Making without Adverse Selection (SSRN 2026)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6681861)
- [Fill Probability vs. Post-Fill Returns trade-off (arXiv:2502.18625)](https://arxiv.org/html/2502.18625v2)
- [Tiniç — Adverse Selection in Cryptocurrency Markets](https://nottingham-repository.worktribe.com/OutputFile/40584797)

**Liquidations & backstop**
- [Hyperliquid Docs — Liquidations](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations)
- [Jeff on X — backstop liquidations absorbed without socialized losses](https://x.com/chameleon_jeff/status/1977066751717429516)
- [tradeXYZ — Liquidation mechanics (backstop economics)](https://docs.trade.xyz/perpetuals/risk-and-margining/liquidation-mechanics)
- [arXiv — Autodeleveraging: Impossibilities and Optimization (HLP vs ADL)](https://arxiv.org/html/2512.01112v2)
- [NewsBTC — $26M ETH short unwound in 12 seconds; backstop absorbed residual](https://www.tradingview.com/news/newsbtc:0aca9ea00094b:0-hyperliquid-trader-loses-26m-as-ether-short-unwinds-in-seconds)

**Execution algorithms**
- [CoinRoutes — Crypto Execution Algorithms: TWAP, VWAP, POV, IS (Jun 2026)](https://coinroutes.com/academy/crypto-execution-algorithms-twap-vwap-pov-is)
- [BraiVIQ — Building Execution Algorithms In Code (Sep 2026)](https://www.braiviq.com/playbook/building-execution-algorithms-in-code-vwap-twap-pov-implementation-shortfall-child-order-scheduling-trading)
- [Quod Financial — Algorithmic Execution Strategies: A Complete Taxonomy (Sep 2026)](https://www.quodfinancial.com/algorithmic-execution-strategies)
- [BIS — FX execution algorithms and market functioning](https://www.bis.org/publications/fx-execution-algorithms-and-market-functioning.pdf)
- [Generative Limit Order Book Models (paperswithbacktest, Oct 2026)](https://paperswithbacktest.com)

**Latency engineering**
- [AWS — Optimize tick-to-trade latency for digital assets (Part 2, Apr 2026)](https://aws.amazon.com/blogs/web3/optimize-tick-to-trade-latency-for-digital-assets-exchanges-and-trading-platforms-on-aws-part-2)
- [Myrtle.ai — Low Latency Trading Systems Guide (Sep 2026)](https://myrtle.ai/resources/blogs/low-latency-trading-systems-guide)
- [Quod Financial — Co-location, kernel bypass and the race to the market (Jul 2026)](https://www.quodfinancial.com/low-latency-trading-infrastructure-co-location-kernel-bypass-and-the-race-to-the-market)
- [Zenodo — Low-Latency System Design for HFT (Jul 2026)](https://zenodo.org/records/21501606)
- [Low Latency Trading Systems — complete guide](https://lowlatencysystem.com/guide)
- [r/cpp — practitioner thread: defer logging off the hot path](https://www.reddit.com/r/cpp/comments/1eyi92e/low_latency_trading)

**Solana / Jito**
- [Jito Docs — Low Latency Transaction Send](https://docs.jito.wtf/lowlatencytxnsend)
- [Solana Docs — MEV protection with Jito](https://solana.com/docs/defi/mev-protection)
- [RPCFast — Improving Jito bundle landing rate (dynamic tips, ShredStream)](https://rpcfast.com/blog/how-to-improve-your-jito-bundle-landing-rate-on-solana)
- [Chainstack — Solana MEV protection (dontfront, Warp, Trader Nodes)](https://docs.chainstack.com/docs/solana-mev-protection)
- [Allenhark — Jito Bundles: Atomic Execution on Solana](https://allenhark.com/jito-bundles)

**Funding / basis arbitrage**
- [Hyperdash — Basis trading & funding rate arbitrage on perps (Jan 2026)](https://hyperdash.com/learn/basis-trading-and-funding-rate-arbitrage-on-perps)
- [Renesis — Delta-neutral strategies in crypto (Jul 2026)](https://renesis.fi/articles/delta-neutral-strategies-crypto)
- [SparkCore — Delta-neutral crypto strategies explained (Mar 2026)](https://sparkcore.fund/blog/delta-neutral-crypto-strategies-explained)
- [Kraken — Funding rate arbitrage](https://www.kraken.com/learn/futures-trading-funding-rate-arbitrage)

**Arbitrage reality & trader UX**
- [HFT Arbitrage Platform — Crypto arbitrage types explained (2026)](https://hftarbitrageplatform.com/en/crypto-arbitrage-types-explained)
- [BJF Trading Group — Latency arbitrage and the speed gap](https://bjftradinggroup.com/exploring-the-potential-of-arbitrage-trading-in-cryptocurrency)
- [r/algotrading — practitioners on cross-exchange arb viability](https://www.reddit.com/r/algotrading/)
- [TradeAlgo — Hotkeys for day trading: speed & execution setup](https://www.tradealgo.com/trading-guides/day-trading/hot-keys-for-day-trading-speed-execution-setup-guide-for-every-platform)
- [The One Lance — Building a faster execution system with hotkeys](https://theonelanceb.com/blog/how-trading-hotkeys-can-help-you-execute-better-trades)
- [key-trade.net — Why TradingView lacks native hotkeys; 2026 trading keyboard guide](https://key-trade.net/en/blogs/professional-trading-keyboards/why-tradingview-lacks-native-hotkeys-for-traders)
- [Baidu Cloud — TUI rendering latency analysis (50–100 ms input latency)](https://intl.cloud.baidu.com/en/article/9142384)
- [Centerpoint Securities — Ultimate hotkeys guide](https://centerpointsecurities.com/hot-keys)

---

*Report compiled November 17, 2026 · FurlPay CLI v0.4.0 · MIT License · Companion to `HFT_Execution_and_Alpha_Trading_Algorithms_Research_Report.md` (v1) and the Regulatory, Licensing & Compliance report embedded in the README.*

# Research Reports

The CLI's quantitative and architectural decisions are grounded in published research. These reports live in the repository and are cross-referenced by the [Honesty Matrix](/reference/honesty-matrix): any feature proposed by research but not yet implemented stays labeled as such.

## Volume index

| Report | What it covers |
|---|---|
| [Institutional HFT Execution, Terminal UX & Quantitative Alpha Algorithms (v1)](https://github.com/FurlPay/furlpay-cli/blob/main/HFT_Execution_and_Alpha_Trading_Algorithms_Research_Report.md) | The engineering blueprint: dual-loop TUI architecture, sub-millisecond pipeline design, venue-specific acceleration (Hyperliquid WS POST, Jito bundles, Binance socket pinning, Stellar pre-auth), the first algorithm set (AS+OFI, VPIN gating, spatial/funding arb, adaptive micro-TWAP), and the pre-trade risk engine table. |
| [HFT Alpha Catalog V2 — Live-Researched Algorithms & Profitability Math](https://github.com/FurlPay/furlpay-cli/blob/main/HFT_V2_Advanced_Algorithms_Live_Research_Report.md) | The 2025–2026 literature sweep: GLFT and RL market makers superseding Avellaneda-Stoikov, crypto-validated OFI/toxicity/quarter-hour signals, queue-position and Hawkes estimation, the adverse-selection objective function, a **correction** to the liquidation-sniping strategy (Hyperliquid backstop mechanics), where arbitrage edge survives in 2026, the maker's breakeven formulas, and a P0/P1/P2 roadmap mapped to CLI commands. |
| [Regulatory, Licensing & Compliance Research Report](https://github.com/FurlPay/furlpay-cli/blob/main/README.md#furlpay-cli--regulatory-licensing-and-compliance-research-report) | The full multi-jurisdiction licensing matrix (US/EU/UK/SG), capital and surety-bond tables, and the developer compliance invariants. Condensed in [Regulatory Overview](/compliance/regulatory). |
| [User Authentication, Multi-Account Architecture & Trading Execution Research Report](https://github.com/FurlPay/furlpay-cli/blob/main/docs/USER_AUTHENTICATION_AND_TRADING_RESEARCH_REPORT.md) | The dual-plane (identity vs. custody) architecture, RFC 8628 device login, custody topologies, and the security threat-model matrix. |
| [Comprehensive Security Audit Report](https://github.com/FurlPay/furlpay-cli/blob/main/AUDIT_REPORT.md) | The P1–P12 vulnerability matrix and remediations — all fixed as of the `fix(security)` commit series. |

## How research becomes features

1. **Proposed** — appears in a research volume with the model, math, and source literature.
2. **Implemented (offline)** — the math ships behind the honesty labels (`microstructure analytics`, `vpin`, `quotes` compute over data you supply).
3. **Implemented (live)** — wired to a real venue with the risk engine in front (`hyperliquid trade`, `earn hlp`).
4. **Never shipped as claimed** — anything without a live venue or validated policy keeps its `SIMULATED` / `backtest-only` label permanently. A research report is never treated as proof of live profitability.

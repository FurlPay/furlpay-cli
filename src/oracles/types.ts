/**
 * Oracle layer types (gap report 2026-11-17, Gap 2).
 *
 * One reading = one source's answer for one asset. Sources fail to null —
 * never a synthetic price, never a stale price relabeled fresh. The
 * aggregator turns readings into a quote with an explicit status:
 *
 *   LIVE          — at least one in-band source, and every pair of sources
 *                   agrees within the asset's deviation budget.
 *   DISAGREEMENT  — sources answered but disagree beyond the budget. The
 *                   aggregate price is null: a blended number across
 *                   disagreeing sources is exactly the fabrication this
 *                   CLI refuses to print. Per-source readings are still
 *                   returned so an operator can see who the outlier is.
 *   UNAVAILABLE   — no source answered sanely. Nothing is guessed.
 */

/** A single source's live reading for an asset. */
export interface OracleReading {
  /** Stable provider id, e.g. "coinbase", "binance:usdt-cross". */
  source: string;
  /** Canonical asset symbol, uppercase (SOL, BTC, ETH, XLM, USDC). */
  asset: string;
  priceUsd: number;
  /** Local clock (epoch ms) when the reading was accepted. */
  asOf: number;
  /** Optional source-side timestamp (epoch ms) when the source published. */
  publishedAt?: number;
}

export type OracleQuoteStatus = "LIVE" | "DISAGREEMENT" | "UNAVAILABLE";

/** The aggregate answer across all configured sources for one asset. */
export interface OracleQuote {
  asset: string;
  /** Median of agreeing sources; null on DISAGREEMENT/UNAVAILABLE. */
  priceUsd: number | null;
  status: OracleQuoteStatus;
  /** Sanity band applied before any reading was trusted. */
  sanityBand: { minUsd: number; maxUsd: number };
  /** Max tolerated pairwise deviation for this asset, percent. */
  maxDeviationPct: number;
  /** Every in-band reading that survived sanity checks. */
  readings: OracleReading[];
  /** Per-source deviation from the median, percent (signed). */
  deviations: { source: string; deviationPct: number }[];
  fetchedAt: number;
}

/** Per-asset guardrails. Prices outside the band are schema errors, not market facts. */
export interface OracleAssetConfig {
  minUsd: number;
  maxUsd: number;
  /** Cross-source agreement budget in percent. */
  maxDeviationPct: number;
}

/**
 * Oracle aggregator (gap report 2026-11-17, Gap 2).
 *
 * Cross-provider fallback + anomaly detection:
 * 1. Fan out to every provider that supports the asset.
 * 2. Sanity-band every reading (per-asset plausibility bounds — a price
 *    outside the band is a schema error, not a market fact).
 * 3. Take the median of the survivors.
 * 4. If ANY survivor deviates from the median beyond the asset's budget,
 *    status = DISAGREEMENT and priceUsd = null. A disagreement is a stop
 *    signal, not something to average away — an operator inspecting the
 *    per-source readings can see exactly which source is the outlier.
 * 5. Zero survivors → UNAVAILABLE, priceUsd = null. Nothing is guessed,
 *    no stale cache is replayed as fresh.
 *
 * A single surviving source is reported LIVE with its readings list making
 * the single-source condition explicit (agreement cannot be cross-checked
 * with one witness — consumers that need two sources can check
 * readings.length themselves).
 */

import { OracleReading, OracleQuote, OracleAssetConfig } from "./types";
import { PriceProvider, defaultProviders, ProviderDeps } from "./providers";

/** Per-asset sanity bands + agreement budgets. Bounds mirror the web app's oracle clamp rule. */
export const ASSET_CONFIG: Record<string, OracleAssetConfig> = {
  SOL: { minUsd: 1, maxUsd: 2_000, maxDeviationPct: 2 },
  BTC: { minUsd: 100, maxUsd: 1_000_000, maxDeviationPct: 2 },
  ETH: { minUsd: 10, maxUsd: 100_000, maxDeviationPct: 2 },
  XLM: { minUsd: 0.001, maxUsd: 100, maxDeviationPct: 3 },
  USDC: { minUsd: 0.01, maxUsd: 10, maxDeviationPct: 1 },
};

export interface OracleAggregatorDeps extends ProviderDeps {
  providers?: PriceProvider[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export class OraclePriceAggregator {
  private readonly providers: PriceProvider[];

  constructor(deps: OracleAggregatorDeps = {}) {
    this.providers = deps.providers ?? defaultProviders(deps);
  }

  /** Assets this aggregator can quote today. */
  listAssets(): string[] {
    const assets = new Set<string>();
    for (const p of this.providers) {
      for (const a of Object.keys(ASSET_CONFIG)) {
        if (p.supports(a)) assets.add(a);
      }
    }
    return [...assets].sort();
  }

  /** Source inventory (endpoints, never credentials) — what `furlpay oracle sources` prints. */
  describeSources(): { id: string; endpoint: string; assets: string[] }[] {
    return this.providers.map((p) => ({
      id: p.id,
      endpoint: p.describe(),
      assets: Object.keys(ASSET_CONFIG).filter((a) => p.supports(a)),
    }));
  }

  async getQuote(assetInput: string): Promise<OracleQuote> {
    const asset = assetInput.toUpperCase().trim();
    const config = ASSET_CONFIG[asset];
    const fetchedAt = Date.now();

    const base: OracleQuote = {
      asset,
      priceUsd: null,
      status: "UNAVAILABLE",
      sanityBand: config ? { minUsd: config.minUsd, maxUsd: config.maxUsd } : { minUsd: 0, maxUsd: Infinity },
      maxDeviationPct: config?.maxDeviationPct ?? 0,
      readings: [],
      deviations: [],
      fetchedAt,
    };

    if (!config) {
      // Unknown asset is not an error worth throwing for — it is an explicit
      // UNAVAILABLE with an empty witness list. The CLI names the supported set.
      return base;
    }

    const supporting = this.providers.filter((p) => p.supports(asset));
    const settled = await Promise.all(supporting.map((p) => p.fetchPrice(asset)));
    const inBand: OracleReading[] = [];
    for (const r of settled) {
      if (r === null) continue;
      if (r.priceUsd >= config.minUsd && r.priceUsd <= config.maxUsd) inBand.push(r);
    }

    if (inBand.length === 0) return base;

    const mid = median(inBand.map((r) => r.priceUsd));
    const deviations = inBand.map((r) => ({
      source: r.source,
      deviationPct: mid === 0 ? 0 : ((r.priceUsd - mid) / mid) * 100,
    }));
    const maxAbsDeviation = Math.max(...deviations.map((d) => Math.abs(d.deviationPct)));

    const agrees = inBand.length === 1 || maxAbsDeviation <= config.maxDeviationPct;

    return {
      ...base,
      priceUsd: agrees ? mid : null,
      status: agrees ? "LIVE" : "DISAGREEMENT",
      readings: inBand,
      deviations,
    };
  }
}

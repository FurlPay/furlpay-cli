/**
 * USDC/USD peg feed ingestion for the UsdcPegMonitor (2026-11-17 audit closure).
 *
 * The audit found the peg guardrail structurally inert: UsdcPegMonitor
 * .updatePrice() was never called anywhere in src/, so the monitor's
 * "no oracles" fallback (priceUsd 1.0, isDepegged false) was the only state
 * it could ever report — a guardrail that had never seen a price and passed
 * every order by construction. This feed makes the ingestion real.
 *
 * Source: a public stablecoin price endpoint, CoinGecko's simple price by
 * default. The parsed response schema is { "usd-coin": { usd: number } }.
 * An operator can point FURLPAY_USDC_PEG_FEED_URL at any endpoint returning
 * that shape (self-hosted oracle aggregator, internal pricing service).
 *
 * Honesty rules:
 * - Any failure (network, timeout, non-200, schema mismatch, non-finite or
 *   out-of-range price) yields null — never a synthetic price, never a
 *   guessed 1.0. Null means "no trustworthy reading", and the caller (the
 *   risk engine) surfaces that as an explicit warning instead of letting the
 *   monitor's neutral fallback read as a clean bill of health.
 * - The price is sanity-bounded (0 < p < 10): USDC/USD outside that band is
 *   a schema error, not a market fact.
 */

export interface PegFeedDeps {
  /** Injectable transport for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Feed endpoint; defaults to FURLPAY_USDC_PEG_FEED_URL or CoinGecko. */
  url?: string;
  /** Hard timeout — a slow feed is a failed feed. */
  timeoutMs?: number;
}

const DEFAULT_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd";

/** USDC/USD sanity band: anything outside is a malformed response, not a price. */
const MIN_PLAUSIBLE_USDC_USD = 0.01;
const MAX_PLAUSIBLE_USDC_USD = 10;

export class UsdcPegFeed {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(deps: PegFeedDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const fromEnv = process.env.FURLPAY_USDC_PEG_FEED_URL?.trim();
    this.url = deps.url ?? (fromEnv || DEFAULT_URL);
    this.timeoutMs = deps.timeoutMs ?? 5_000;
    if (!/^https:\/\//.test(this.url)) {
      throw new Error("PEG_FEED_INSECURE_URL: the peg feed endpoint must be https — a tamperable feed is worse than no feed.");
    }
  }

  /** The endpoint this feed reads (never includes credentials; the default carries none). */
  describeSource(): string {
    return this.url;
  }

  /**
   * Latest USDC/USD, or null when the feed cannot be trusted to have answered.
   * Never throws: every failure mode is a null and a silent no-ingest (the
   * monitor keeps its last honest state, and the risk engine warns).
   */
  async fetchUsdcUsd(): Promise<number | null> {
    try {
      const res = await this.fetchImpl(this.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, Record<string, unknown> | undefined>;
      const raw = body?.["usd-coin"]?.["usd"];
      const price = typeof raw === "string" ? Number(raw) : raw;
      if (
        typeof price !== "number" ||
        !Number.isFinite(price) ||
        price < MIN_PLAUSIBLE_USDC_USD ||
        price > MAX_PLAUSIBLE_USDC_USD
      ) {
        return null;
      }
      return price;
    } catch {
      return null;
    }
  }
}

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
  /**
   * Feed endpoint; defaults to FURLPAY_USDC_PEG_FEED_URL or the CoinGecko
   * primary. The secondary (Coinbase spot) is always queried alongside it —
   * a single source cannot be cross-checked, and the peg guard deserves two
   * independent answers (readiness P14).
   */
  url?: string;
  /** Hard timeout — a slow feed is a failed feed. */
  timeoutMs?: number;
}

const DEFAULT_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd";
const SECONDARY_URL = "https://api.coinbase.com/v2/prices/USDC-USD/spot";

/** USDC/USD sanity band: anything outside is a malformed response, not a price. */
const MIN_PLAUSIBLE_USDC_USD = 0.01;
const MAX_PLAUSIBLE_USDC_USD = 10;

export interface PegReading {
  source: string;
  priceUsd: number;
}

export class UsdcPegFeed {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly secondaryUrl: string;
  private readonly timeoutMs: number;

  constructor(deps: PegFeedDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const fromEnv = process.env.FURLPAY_USDC_PEG_FEED_URL?.trim();
    this.url = deps.url ?? (fromEnv || DEFAULT_URL);
    this.secondaryUrl = SECONDARY_URL;
    this.timeoutMs = deps.timeoutMs ?? 5_000;
    if (!/^https:\/\//.test(this.url)) {
      throw new Error("PEG_FEED_INSECURE_URL: the peg feed endpoint must be https — a tamperable feed is worse than no feed.");
    }
  }

  /** The endpoints this feed reads (never credentials; the defaults carry none). */
  describeSource(): string {
    return this.url;
  }

  private parseCoinGecko(body: unknown): number | null {
    const b = body as Record<string, Record<string, unknown> | undefined> | null;
    const raw = b?.["usd-coin"]?.["usd"];
    const price = typeof raw === "string" ? Number(raw) : raw;
    return typeof price === "number" && Number.isFinite(price) ? price : null;
  }

  private parseCoinbase(body: unknown): number | null {
    const b = body as { data?: { amount?: unknown } } | null;
    const raw = b?.data?.amount;
    const price = typeof raw === "string" ? Number(raw) : raw;
    return typeof price === "number" && Number.isFinite(price) ? price : null;
  }

  private inBand(price: number): boolean {
    return price >= MIN_PLAUSIBLE_USDC_USD && price <= MAX_PLAUSIBLE_USDC_USD;
  }

  private async fetchOne(url: string, parse: (b: unknown) => number | null): Promise<PegReading | null> {
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const price = parse(await res.json());
      if (price === null || !this.inBand(price)) return null;
      return { source: url, priceUsd: price };
    } catch {
      return null;
    }
  }

  /**
   * Readings from every source that answered sanely (primary CoinGecko-shape
   * + secondary Coinbase spot). Empty array = no trustworthy data — never a
   * synthetic price, never a guessed 1.0. The monitor's weighted consensus
   * ingests each reading under its own source key.
   */
  async fetchReadings(): Promise<PegReading[]> {
    const [primary, secondary] = await Promise.all([
      this.fetchOne(this.url, (b) => this.parseCoinGecko(b)),
      this.fetchOne(this.secondaryUrl, (b) => this.parseCoinbase(b)),
    ]);
    return [primary, secondary].filter((r): r is PegReading => r !== null);
  }

  /**
   * Back-compat single reading (weighted consensus across sources): null
   * when nothing answered. Prefer fetchReadings() for multi-source ingestion.
   */
  async fetchUsdcUsd(): Promise<number | null> {
    const readings = await this.fetchReadings();
    if (!readings.length) return null;
    return readings.reduce((s, r) => s + r.priceUsd, 0) / readings.length;
  }
}

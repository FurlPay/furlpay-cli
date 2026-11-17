/**
 * Oracle price providers (gap report 2026-11-17, Gap 2 — Phase 1 items 3/4).
 *
 * Every provider here hits a real, public, keyless HTTPS endpoint that was
 * probed live before being wired in (2026-11-17):
 *   - Coinbase spot      api.coinbase.com/v2/prices/{ASSET}-USD/spot
 *   - Kraken ticker      api.kraken.com/0/public/Ticker?pair={ASSET}USD
 *   - Binance ticker     api.binance.com/api/v3/ticker/price?symbol={ASSET}USDT
 *                        (USDT cross — labeled as such; tiny USDT/USD basis
 *                        risk is exactly why it is never the only source)
 *   - Jupiter price v3   lite-api.jup.ag/price/v3?ids={mint}  (Solana mints)
 *
 * Pyth Hermes: the public hermes.pyth.network endpoint now answers
 * "unauthorized" (Pyth Pro gate, September 2026) — so the Pyth provider is
 * INACTIVE unless an operator points FURLPAY_PYTH_HERMES_URL at a gateway
 * they are authorized to use (self-hosted Hermes or a Pro entitlement), plus
 * FURLPAY_PYTH_FEED_IDS (JSON {"SOL":"0x..","BTC":"0x.."}). No unverified
 * feed IDs ship baked into this file. An inactive or failing provider is a
 * null reading — the aggregator degrades across the remaining sources; an
 * oracle outage must never block (the same degradation rule the Solana USD
 * price clamp enforces on the web side).
 *
 * Honesty rules (same as the peg feed):
 * - https only; injectable transport; hard timeout.
 * - Any failure (network, non-200, schema mismatch, non-finite price) is a
 *   null reading — never a synthetic price.
 * - Sanity banding happens in the aggregator; providers only parse honestly.
 */

import { OracleReading } from "./types";

export interface ProviderDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** A price source: one asset in, one reading (or null) out. */
export interface PriceProvider {
  id: string;
  /** The endpoint shape this provider reads (never credentials). */
  describe(): string;
  /** Canonical assets this provider can quote. */
  supports(asset: string): boolean;
  fetchPrice(asset: string): Promise<OracleReading | null>;
}

abstract class HttpPriceProvider implements PriceProvider {
  abstract readonly id: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly timeoutMs: number;

  constructor(deps: ProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? 5_000;
  }

  abstract describe(): string;
  abstract supports(asset: string): boolean;
  protected abstract url(asset: string): string;
  protected abstract parse(body: unknown): { priceUsd: number; publishedAt?: number } | null;

  async fetchPrice(asset: string): Promise<OracleReading | null> {
    const url = this.url(asset);
    if (!/^https:\/\//.test(url)) return null;
    try {
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const parsed = this.parse(await res.json());
      if (!parsed || !Number.isFinite(parsed.priceUsd)) return null;
      return {
        source: this.id,
        asset,
        priceUsd: parsed.priceUsd,
        asOf: Date.now(),
        publishedAt: parsed.publishedAt,
      };
    } catch {
      return null;
    }
  }
}

const COINBASE_ASSETS = new Set(["SOL", "BTC", "ETH", "XLM", "USDC"]);

export class CoinbaseSpotProvider extends HttpPriceProvider {
  readonly id = "coinbase";
  describe(): string {
    return "api.coinbase.com/v2/prices/{ASSET}-USD/spot (public spot)";
  }
  supports(asset: string): boolean {
    return COINBASE_ASSETS.has(asset.toUpperCase());
  }
  protected url(asset: string): string {
    return `https://api.coinbase.com/v2/prices/${asset.toUpperCase()}-USD/spot`;
  }
  protected parse(body: unknown) {
    const raw = (body as { data?: { amount?: unknown } } | null)?.data?.amount;
    const price = typeof raw === "string" ? Number(raw) : raw;
    return typeof price === "number" && Number.isFinite(price) ? { priceUsd: price } : null;
  }
}

/** Kraken returns alias keys (XXBTZUSD for XBT, XXLMZUSD for XLM) — parse the first result entry. */
const KRAKEN_PAIRS: Record<string, string> = {
  SOL: "SOLUSD",
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  XLM: "XLMUSD",
  USDC: "USDCUSD",
};

export class KrakenTickerProvider extends HttpPriceProvider {
  readonly id = "kraken";
  describe(): string {
    return "api.kraken.com/0/public/Ticker (public last-trade price)";
  }
  supports(asset: string): boolean {
    return Boolean(KRAKEN_PAIRS[asset.toUpperCase()]);
  }
  protected url(asset: string): string {
    return `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN_PAIRS[asset.toUpperCase()]}`;
  }
  protected parse(body: unknown) {
    const result = (body as { result?: Record<string, { c?: unknown[] }> } | null)?.result;
    if (!result) return null;
    const first = Object.values(result)[0];
    // last-trade price is c[0]; Kraken also gives bid a[0]/ask b[0] — the
    // last trade is the least-interpretable single number.
    const raw = Array.isArray(first?.c) ? first.c[0] : undefined;
    const price = typeof raw === "string" ? Number(raw) : raw;
    return typeof price === "number" && Number.isFinite(price) ? { priceUsd: price } : null;
  }
}

const BINANCE_ASSETS = new Set(["SOL", "BTC", "ETH", "XLM"]);

export class BinanceTickerProvider extends HttpPriceProvider {
  readonly id = "binance:usdt-cross";
  describe(): string {
    return "api.binance.com/api/v3/ticker/price (USDT cross — not a USD print)";
  }
  supports(asset: string): boolean {
    return BINANCE_ASSETS.has(asset.toUpperCase());
  }
  protected url(asset: string): string {
    return `https://api.binance.com/api/v3/ticker/price?symbol=${asset.toUpperCase()}USDT`;
  }
  protected parse(body: unknown) {
    const raw = (body as { price?: unknown } | null)?.price;
    const price = typeof raw === "string" ? Number(raw) : raw;
    return typeof price === "number" && Number.isFinite(price) ? { priceUsd: price } : null;
  }
}

/** Verified Solana mainnet mints (cross-checked against the Jupiter price v3 response). */
const JUPITER_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export class JupiterPriceProvider extends HttpPriceProvider {
  readonly id = "jupiter:solana";
  describe(): string {
    return "lite-api.jup.ag/price/v3 (Solana liquidity-weighted USD price)";
  }
  supports(asset: string): boolean {
    return Boolean(JUPITER_MINTS[asset.toUpperCase()]);
  }
  protected url(asset: string): string {
    return `https://lite-api.jup.ag/price/v3?ids=${JUPITER_MINTS[asset.toUpperCase()]}`;
  }
  protected parse(body: unknown) {
    const mint = (body as Record<string, { usdPrice?: unknown }> | null) ?? {};
    const first = Object.values(mint)[0];
    const price = first?.usdPrice;
    return typeof price === "number" && Number.isFinite(price) ? { priceUsd: price } : null;
  }
}

/**
 * Optional Pyth Hermes provider — inactive without BOTH env vars. The public
 * endpoint is authorization-gated as of Pyth Pro; operators with a gateway
 * supply its base URL and their verified feed IDs. Stale publishes are
 * rejected (default 120s), because Pyth timestamps are the source's own
 * clock and a republished old price is the classic oracle failure.
 */
export class PythHermesProvider implements PriceProvider {
  readonly id = "pyth-hermes";
  private readonly baseUrl: string;
  private readonly feedIds: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxStalenessMs: number;

  constructor(deps: ProviderDeps & { baseUrl?: string; feedIds?: Record<string, string>; maxStalenessMs?: number } = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? 5_000;
    this.maxStalenessMs = deps.maxStalenessMs ?? 120_000;
    const envUrl = deps.baseUrl ?? process.env.FURLPAY_PYTH_HERMES_URL?.trim();
    let feedIds = deps.feedIds;
    if (!feedIds && process.env.FURLPAY_PYTH_FEED_IDS?.trim()) {
      try {
        const parsed = JSON.parse(process.env.FURLPAY_PYTH_FEED_IDS);
        if (parsed && typeof parsed === "object") feedIds = parsed as Record<string, string>;
      } catch {
        feedIds = undefined;
      }
    }
    this.baseUrl = envUrl || "";
    this.feedIds = feedIds || {};
  }

  describe(): string {
    return this.isActive()
      ? `${this.baseUrl}/v2/updates/price/latest?parsed=true (operator-supplied Pyth gateway)`
      : "inactive — public Hermes is auth-gated (Pyth Pro); set FURLPAY_PYTH_HERMES_URL + FURLPAY_PYTH_FEED_IDS to enable";
  }

  isActive(): boolean {
    return /^https:\/\//.test(this.baseUrl) && Object.keys(this.feedIds).length > 0;
  }

  supports(asset: string): boolean {
    return Boolean(this.feedIds[asset.toUpperCase()]);
  }

  async fetchPrice(asset: string): Promise<OracleReading | null> {
    const feedId = this.feedIds[asset.toUpperCase()];
    if (!feedId || !/^https:\/\//.test(this.baseUrl)) return null;
    try {
      const url = `${this.baseUrl}/v2/updates/price/latest?ids%5B%5D=${encodeURIComponent(feedId)}&parsed=true`;
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { parsed?: Array<{ price?: { price?: string; expo?: number; publish_time?: number } }> };
      const entry = body?.parsed?.[0]?.price;
      if (!entry || typeof entry.price !== "string" || typeof entry.expo !== "number") return null;
      const price = Number(entry.price) * Math.pow(10, entry.expo);
      if (!Number.isFinite(price)) return null;
      if (typeof entry.publish_time === "number") {
        const publishedAt = entry.publish_time * 1_000;
        if (Date.now() - publishedAt > this.maxStalenessMs) return null;
        return { source: this.id, asset: asset.toUpperCase(), priceUsd: price, asOf: Date.now(), publishedAt };
      }
      return { source: this.id, asset: asset.toUpperCase(), priceUsd: price, asOf: Date.now() };
    } catch {
      return null;
    }
  }
}

/** The default source set: the four public providers plus the (inactive-unless-configured) Pyth gateway. */
export function defaultProviders(deps: ProviderDeps = {}): PriceProvider[] {
  return [
    new CoinbaseSpotProvider(deps),
    new KrakenTickerProvider(deps),
    new BinanceTickerProvider(deps),
    new JupiterPriceProvider(deps),
    new PythHermesProvider(deps),
  ];
}

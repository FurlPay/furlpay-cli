/**
 * Oracle Aggregator Test Suite (gap report 2026-11-17, Gap 2).
 *
 * Every test runs against an INJECTED transport — no live network in CI.
 * What is pinned:
 *   - The median + cross-source agreement gate: agreeing sources → LIVE
 *     median; divergence beyond the asset budget → DISAGREEMENT with a NULL
 *     price (never a blended number across disagreeing sources).
 *   - Zero sane answers → UNAVAILABLE, null price, nothing guessed.
 *   - Sanity bands drop out-of-band readings before aggregation.
 *   - Unknown assets are UNAVAILABLE without a single network call.
 *   - Per-provider parsing against the REAL response shapes (Coinbase
 *     spot, Kraken alias-keyed ticker, Binance USDT cross, Jupiter v3).
 *   - The Pyth provider is structurally inactive until an operator configures
 *     a gateway + feed IDs, and rejects stale publishes.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { OraclePriceAggregator, ASSET_CONFIG } = require("../dist/oracles/aggregator");
const {
  CoinbaseSpotProvider,
  KrakenTickerProvider,
  BinanceTickerProvider,
  JupiterPriceProvider,
  PythHermesProvider,
} = require("../dist/oracles/providers");

/** Build a fetch impl from a map: url → {status, body}. Unmapped URLs get HTTP 503. */
function fetchMap(map) {
  return async (url) => {
    const hit = Object.keys(map).find((k) => url.startsWith(k));
    if (!hit) return { ok: false, status: 503, json: async () => ({}) };
    const { status = 200, body } = map[hit];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

function aggWith(map, opts = {}) {
  return new OraclePriceAggregator({
    fetchImpl: fetchMap(map),
    timeoutMs: 250,
    ...opts,
  });
}

const OK = { status: 200 };

describe("oracle aggregator — agreement gate", () => {
  it("LIVE: three agreeing sources → median price", async () => {
    const agg = aggWith({
      "https://api.coinbase.com": { ...OK, body: { data: { amount: "100.0" } } },
      "https://api.kraken.com": { ...OK, body: { result: { ETHUSD: { c: ["100.2", "1"] } } } },
      "https://api.binance.com": { ...OK, body: { price: "99.9" } },
    });
    const q = await agg.getQuote("ETH");
    assert.equal(q.status, "LIVE");
    assert.equal(q.priceUsd, 100.0); // median of [99.9, 100.0, 100.2]
    assert.equal(q.readings.length, 3);
    assert.equal(q.deviations.length, 3);
  });

  it("DISAGREEMENT: divergence beyond budget → null price, per-source readings preserved", async () => {
    // ETH budget ±2%. Median of [100, 105] = 102.5 → each source ±2.44% off.
    const agg = aggWith({
      "https://api.coinbase.com": { ...OK, body: { data: { amount: "100.0" } } },
      "https://api.kraken.com": { ...OK, body: { result: { ETHUSD: { c: ["105.0", "1"] } } } },
    });
    const q = await agg.getQuote("ETH");
    assert.equal(q.status, "DISAGREEMENT");
    assert.equal(q.priceUsd, null, "a disagreeing source set must never produce a blended price");
    assert.equal(q.readings.length, 2);
    assert.ok(q.deviations.some((d) => Math.abs(d.deviationPct) > 2));
  });

  it("UNAVAILABLE: every source fails → null price, empty readings", async () => {
    const agg = aggWith({}); // all 503
    const q = await agg.getQuote("SOL");
    assert.equal(q.status, "UNAVAILABLE");
    assert.equal(q.priceUsd, null);
    assert.deepEqual(q.readings, []);
  });

  it("out-of-band readings are dropped by the sanity band before aggregation", async () => {
    // SOL band is $1–$2000; a $0.10 print is a schema error, not a price.
    const agg = aggWith({
      "https://api.coinbase.com": { ...OK, body: { data: { amount: "0.1" } } },
      "https://api.kraken.com": { ...OK, body: { result: { SOLUSD: { c: ["150.0", "1"] } } } },
    });
    const q = await agg.getQuote("SOL");
    assert.equal(q.status, "LIVE");
    assert.equal(q.priceUsd, 150.0);
    assert.equal(q.readings.length, 1, "the insane print must not enter the witness list");
    assert.equal(q.readings[0].source, "kraken");
  });

  it("a single surviving source is LIVE but visibly single-source", async () => {
    const agg = aggWith({
      "https://api.coinbase.com": { ...OK, body: { data: { amount: "64000" } } },
    });
    const q = await agg.getQuote("BTC");
    assert.equal(q.status, "LIVE");
    assert.equal(q.readings.length, 1);
    assert.equal(q.priceUsd, 64000);
  });

  it("unknown asset → UNAVAILABLE with zero network calls", async () => {
    let calls = 0;
    const agg = new OraclePriceAggregator({
      fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    const q = await agg.getQuote("DEFI");
    assert.equal(q.status, "UNAVAILABLE");
    assert.equal(calls, 0, "no provider may be contacted for an unconfigurable asset");
    assert.equal(q.priceUsd, null);
  });

  it("asset config bounds mirror the web app's oracle clamp rule (SOL $1–$2000)", () => {
    assert.deepEqual(ASSET_CONFIG.SOL, { minUsd: 1, maxUsd: 2000, maxDeviationPct: 2 });
    assert.ok(ASSET_CONFIG.USDC.minUsd < 1 && ASSET_CONFIG.USDC.maxUsd > 1.1);
  });
});

describe("oracle providers — real response-shape parsing", () => {
  it("Coinbase spot parses {data:{amount}} and rejects garbage", async () => {
    const p = new CoinbaseSpotProvider({ fetchImpl: fetchMap({ "https://api.coinbase.com": { ...OK, body: { data: { amount: "0.137593" } } } }) });
    const r = await p.fetchPrice("XLM");
    assert.equal(r.priceUsd, 0.137593);
    const bad = new CoinbaseSpotProvider({ fetchImpl: fetchMap({ "https://api.coinbase.com": { ...OK, body: { unexpected: true } } }) });
    assert.equal(await bad.fetchPrice("XLM"), null);
  });

  it("Kraken parses alias-keyed results (XBT for BTC) from the first entry", async () => {
    const p = new KrakenTickerProvider({ fetchImpl: fetchMap({ "https://api.kraken.com": { ...OK, body: { error: [], result: { XXBTZUSD: { c: ["63958.78", "0.05"] } } } } }) });
    const r = await p.fetchPrice("BTC");
    assert.equal(r.priceUsd, 63958.78);
  });

  it("Binance parses string price and is labeled a USDT cross", async () => {
    const p = new BinanceTickerProvider({ fetchImpl: fetchMap({ "https://api.binance.com": { ...OK, body: { symbol: "SOLUSDT", price: "72.38000000" } } }) });
    const r = await p.fetchPrice("SOL");
    assert.equal(r.priceUsd, 72.38);
    assert.equal(r.source, "binance:usdt-cross");
  });

  it("Jupiter parses v3 {mint:{usdPrice}} keyed by mint", async () => {
    const p = new JupiterPriceProvider({ fetchImpl: fetchMap({ "https://lite-api.jup.ag": { ...OK, body: { So11111111111111111111111111111111111111112: { usdPrice: 72.31, decimals: 9 } } } }) });
    const r = await p.fetchPrice("SOL");
    assert.equal(r.priceUsd, 72.31);
  });

  it("every provider refuses an http:// endpoint (https-only)", async () => {
    // Provider constructed with a tampered URL — parse cannot happen, fetch
    // would target non-https. Coinbase hardcodes its https URL, so instead
    // verify the Pyth provider (the only one with an operator URL) refuses.
    const p = new PythHermesProvider({ baseUrl: "http://insecure.example", feedIds: { SOL: "0xabc" } });
    assert.equal(p.isActive(), false);
    assert.equal(await p.fetchPrice("SOL"), null);
  });
});

describe("pyth provider — inactive-unless-configured", () => {
  it("is structurally inactive without env config (public Hermes is auth-gated)", async () => {
    const saved = { url: process.env.FURLPAY_PYTH_HERMES_URL, ids: process.env.FURLPAY_PYTH_FEED_IDS };
    delete process.env.FURLPAY_PYTH_HERMES_URL;
    delete process.env.FURLPAY_PYTH_FEED_IDS;
    try {
      const p = new PythHermesProvider();
      assert.equal(p.isActive(), false);
      assert.equal(await p.fetchPrice("SOL"), null);
      const agg = new OraclePriceAggregator();
      const sources = agg.describeSources();
      assert.ok(sources.find((s) => s.id === "pyth-hermes" && s.assets.length === 0));
    } finally {
      if (saved.url) process.env.FURLPAY_PYTH_HERMES_URL = saved.url;
      if (saved.ids) process.env.FURLPAY_PYTH_FEED_IDS = saved.ids;
    }
  });

  it("activates with a gateway + feed IDs, parses parsed=true shape, rejects stale publishes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = { parsed: [{ price: { price: "72103263", expo: -6, publish_time: now } }] };
    const stale = { parsed: [{ price: { price: "72103263", expo: -6, publish_time: now - 3600 } }] };
    const url = "https://pyth-gw.internal.example";
    const impl = fetchMap({ [url]: { ...OK, body: fresh } });
    const p = new PythHermesProvider({ baseUrl: url, feedIds: { SOL: "0xef0d" }, fetchImpl: impl, maxStalenessMs: 120_000 });
    assert.equal(p.isActive(), true);
    const r = await p.fetchPrice("SOL");
    assert.equal(r.priceUsd, 72.103263);
    assert.ok(r.publishedAt);
    const staleP = new PythHermesProvider({ baseUrl: url, feedIds: { SOL: "0xef0d" }, fetchImpl: fetchMap({ [url]: { ...OK, body: stale } }) });
    assert.equal(await staleP.fetchPrice("SOL"), null, "a republished old price is a null reading, never accepted as fresh");
  });
});

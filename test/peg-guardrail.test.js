/**
 * USDC Peg Guardrail & Fail-Closed Risk Engine Test Suite
 *
 * Closes the 2026-11-17 audit finding that the peg guardrail was structurally
 * inert: nothing in src/ ever called UsdcPegMonitor.updatePrice(), so the
 * monitor's neutral fallback (priceUsd 1.0, isDepegged false) was the only
 * state it could report and every order passed "peg check" without a single
 * price ever having been seen. These tests pin the live ingestion path and
 * the explicit no-data warning, plus the risk engine's fail-closed
 * regressions (book failure, insufficient margin) from the same audit.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { HyperliquidRiskEngine } = require("../dist/hyperliquid/risk-engine");
const { UsdcPegFeed } = require("../dist/hyperliquid/peg-feed");
const { UsdcPegMonitor } = require("../dist/hyperliquid/usdc-peg-monitor");

const STUB_URL = "https://stub.invalid/usdc-price";

/** Minimal client stub: healthy book mid 75005, generous leverage metadata. */
function stubClient() {
  return {
    getAssetMeta: async () => ({ maxLeverage: 50 }),
    getL2Book: async () => ({ levels: [[{ px: "75000" }], [{ px: "75010" }]] }),
  };
}

function feedReturning(usd) {
  return new UsdcPegFeed({
    url: STUB_URL,
    fetchImpl: async () => ({ ok: true, json: async () => ({ "usd-coin": { usd } }) }),
  });
}

function feedThrowing() {
  return new UsdcPegFeed({ url: STUB_URL, fetchImpl: async () => { throw new Error("socket hung up"); } });
}

describe("USDC Peg Guardrail (live ingestion, audit closure)", () => {
  it("P0: a depegged reading blocks the order through the full risk path", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedReturning(0.98) } // 200 bps drift >> 25 bps threshold
    );
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client: stubClient(),
    });
    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /DEPEG_HALT/);
    assert.match(check.reason, /200\.0 bps/);
  });

  it("P1: a healthy reading passes with no warnings attached", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedReturning(1.0) }
    );
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client: stubClient(),
    });
    assert.strictEqual(check.passed, true);
    assert.strictEqual(check.warnings, undefined);
  });

  it("P2: a feed outage passes the order but attaches an explicit warning — never a silent pass", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedThrowing() }
    );
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client: stubClient(),
    });
    assert.strictEqual(check.passed, true, "an outage is not depeg evidence — no halt on silence");
    assert.ok(Array.isArray(check.warnings) && check.warnings.length === 1);
    assert.match(check.warnings[0], /PEG_FEED_UNAVAILABLE/);
    assert.match(check.warnings[0], /not a clean bill of health/);
  });

  it("P3: a depeg halt persists when the feed goes stale — an outage never proves recovery", () => {
    const monitor = new UsdcPegMonitor();
    const t = Date.now();
    monitor.updatePrice("stub", 0.98, t);

    const depeg = monitor.evaluatePeg(t);
    assert.strictEqual(depeg.status, "DEPEG_ALERT");
    assert.strictEqual(depeg.tradingPermitted, false);

    // 61s later the reading is stale (freshness window is 60s). The halt must
    // NOT decay into HEALTHY on fabricated fallback numbers.
    const stale = monitor.evaluatePeg(t + 61_000);
    assert.strictEqual(stale.dataAvailable, false);
    assert.strictEqual(stale.status, "DEPEG_ALERT");
    assert.strictEqual(stale.tradingPermitted, false);
    assert.match(stale.reason, /stays in force/);
  });

  it("P4: the feed never returns a synthetic price — garbage in, null out", async () => {
    const garbage = [
      { status: 500 },                                                    // non-200
      { status: 200, json: async () => ({ unexpected: "schema" }) },      // schema mismatch
      { status: 200, json: async () => ({ "usd-coin": { usd: "abc" } }) },// non-numeric
      { status: 200, json: async () => ({ "usd-coin": { usd: 9999 } }) }, // outside sanity band
      { status: 200, json: async () => ({ "usd-coin": { usd: 0 } }) },    // non-positive
    ];
    for (const res of garbage) {
      const feed = new UsdcPegFeed({ url: STUB_URL, fetchImpl: async () => res });
      assert.strictEqual(await feed.fetchUsdcUsd(), null, JSON.stringify(res));
    }
    // A feed outage (throw) is a null too.
    assert.strictEqual(await feedThrowing().fetchUsdcUsd(), null);
  });

  it("P4b: the feed refuses non-https endpoints outright", () => {
    assert.throws(() => new UsdcPegFeed({ url: "http://stub.invalid/usdc-price" }), /INSECURE_URL/);
  });
});

describe("Fail-closed risk engine regressions (same audit)", () => {
  it("P5: an L2 book fetch failure refuses the order — the empty-catch fail-open is gone", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedReturning(1.0) }
    );
    const client = stubClient();
    client.getL2Book = async () => { throw new Error("book endpoint 503"); };
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client,
    });
    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /RISK_UNAVAILABLE/);
    assert.match(check.reason, /fail-closed/);
  });

  it("P6: insufficient account equity refuses the order when userState is supplied", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedReturning(1.0) }
    );
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client: stubClient(),
      userState: { marginSummary: { accountValue: "100", totalMarginUsed: "99" } },
    });
    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /Insufficient account equity/);
  });

  it("P7: sufficient equity passes — the margin check proves both directions", async () => {
    const risk = new HyperliquidRiskEngine(
      { maxSingleOrderUsd: 50_000 },
      { pegFeed: feedReturning(1.0) }
    );
    const check = await risk.evaluatePreTrade({
      coin: "BTC", side: "buy", size: 0.01, price: 75_005, leverage: 2,
      client: stubClient(),
      userState: { marginSummary: { accountValue: "100000", totalMarginUsed: "0" } },
    });
    assert.strictEqual(check.passed, true);
    assert.strictEqual(check.warnings, undefined);
  });
});

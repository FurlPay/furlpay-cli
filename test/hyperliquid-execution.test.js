/**
 * Hyperliquid Execution & Microstructure Test Suite
 * 
 * Verifies:
 * 1. Cryptographic EIP-712 Phantom Agent signing & connectionId derivation.
 * 2. Pre-trade Risk Engine guardrails (notional, leverage, fat-finger, daily velocity).
 * 3. Market Data Microstructure (Depth-weighted Micro-Price, Volume-Weighted Spread, Slippage & OFI).
 * 4. HLP Vault Live Inspection & 4-day withdrawal lockup validation.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const { HyperliquidSigner } = require("../dist/hyperliquid/signer");
const { HyperliquidClient } = require("../dist/hyperliquid/client");
const { HyperliquidRiskEngine } = require("../dist/hyperliquid/risk-engine");
const { MarketDataService } = require("../dist/services/market-data");
const { HlpVaultService } = require("../dist/hyperliquid/hlp");

describe("Hyperliquid Execution & Microstructure Verification", () => {
  const dummyWallet = ethers.Wallet.createRandom();
  const signer = new HyperliquidSigner(dummyWallet.privateKey, false);

  it("P0: derives correct EIP-712 Phantom Agent connectionId and signature envelope", async () => {
    const action = {
      type: "order",
      orders: [
        {
          a: 0,
          b: true,
          p: "75000.0",
          s: "0.1",
          r: false,
          t: { limit: { tif: "Gtc" } },
        },
      ],
      grouping: "na",
    };

    const nonce = 1710000000000;
    const connectionId = signer.deriveConnectionId(action, nonce);

    assert.ok(connectionId.startsWith("0x"));
    assert.strictEqual(connectionId.length, 66); // 32 bytes hex + 0x

    const sig = await signer.signL1Action(action, nonce);
    assert.ok(sig.r.startsWith("0x"));
    assert.ok(sig.s.startsWith("0x"));
    assert.ok(sig.v === 27 || sig.v === 28);

    // Cryptographic recovery verification of the Agent message
    const domain = {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const types = {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    };
    const message = {
      source: "a",
      connectionId,
    };

    const recovered = ethers.verifyTypedData(
      domain,
      types,
      message,
      ethers.Signature.from({ r: sig.r, s: sig.s, v: sig.v }).serialized
    );
    assert.strictEqual(recovered.toLowerCase(), dummyWallet.address.toLowerCase());
  });

  it("P1 Risk Engine: rejects order breaching single-order notional limit", async () => {
    const risk = new HyperliquidRiskEngine({ maxSingleOrderUsd: 10_000 });
    const client = new HyperliquidClient("mainnet");

    const check = await risk.evaluatePreTrade({
      coin: "BTC",
      side: "buy",
      size: 1.0, // 1 BTC = ~$75,000 > $10,000 limit
      price: 75_000,
      leverage: 5,
      client,
    });

    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /exceeds single order limit/);
  });

  it("P1 Risk Engine: rejects excessive leverage beyond limits", async () => {
    const risk = new HyperliquidRiskEngine({ maxLeverage: 10 });
    const client = new HyperliquidClient("mainnet");

    const check = await risk.evaluatePreTrade({
      coin: "BTC",
      side: "buy",
      size: 0.05,
      price: 75_000,
      leverage: 50, // 50x > 10x limit
      client,
    });

    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /exceeds max allowed/);
  });

  it("P1 Risk Engine: fat-finger protection rejects orders >15% away from mid", async () => {
    const risk = new HyperliquidRiskEngine({ maxFatFingerPct: 15.0 });
    const client = new HyperliquidClient("mainnet");

    // Live BTC is ~$75k; $120k is 60% away
    const check = await risk.evaluatePreTrade({
      coin: "BTC",
      side: "buy",
      size: 0.01,
      price: 120_000,
      leverage: 2,
      client,
    });

    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /Fat-finger threshold/);
  });

  it("P1 Risk Engine: approves compliant orders within safe thresholds", async () => {
    const risk = new HyperliquidRiskEngine({ maxSingleOrderUsd: 50_000, maxLeverage: 20 });
    const client = new HyperliquidClient("mainnet");

    const book = await client.getL2Book("BTC");
    const mid = (parseFloat(book.levels[0][0].px) + parseFloat(book.levels[1][0].px)) / 2.0;

    const check = await risk.evaluatePreTrade({
      coin: "BTC",
      side: "buy",
      size: 0.005, // ~$375 notional
      price: mid,
      leverage: 5,
      client,
    });

    assert.strictEqual(check.passed, true);
  });

  it("P1 Market Microstructure: calculates Depth-Weighted Micro-Price and VWS", async () => {
    const mds = new MarketDataService("mainnet");
    const analytics = await mds.getMicrostructureAnalytics("BTC");

    assert.ok(analytics.midPrice > 10_000, "BTC mid price should be > $10,000");
    assert.ok(analytics.microPrice > 10_000, "Micro-price should be calculated");
    assert.ok(analytics.volumeWeightedSpread >= 0, "VWS should be non-negative");
    assert.ok(analytics.liquidityHhi >= 0 && analytics.liquidityHhi <= 1, "HHI between 0 and 1");
    assert.ok(analytics.bidDepthTotal > 0, "Bids depth present");
    assert.ok(analytics.askDepthTotal > 0, "Asks depth present");

    // Microstructure Depth Bands (10 bps <= 25 bps <= 50 bps)
    assert.ok(analytics.depth10BpsUsd >= 0, "10 bps depth calculated");
    assert.ok(analytics.depth25BpsUsd >= analytics.depth10BpsUsd, "25 bps depth >= 10 bps depth");
    assert.ok(analytics.depth50BpsUsd >= analytics.depth25BpsUsd, "50 bps depth >= 25 bps depth");

    // Realtime Provenance & Feed Latency
    assert.ok(analytics.exchangeTimestampMs > 0, "Exchange timestamp present");
    assert.ok(analytics.receivedAtMs > 0, "Received timestamp present");
    assert.ok(analytics.feedLatencyMs >= 0, "Feed latency is non-negative");
    assert.strictEqual(analytics.source, "rest", "Initial snapshot source is rest");
  });

  it("P1 Microstructure Integrity: validates order books and detects crossed or inverted feeds", async () => {
    const mds = new MarketDataService("mainnet");

    // 1. Valid book check against live BTC book
    const liveValidation = await mds.validateOrderBook("BTC");
    assert.strictEqual(liveValidation.valid, true, "Live book should be strictly valid");
    assert.strictEqual(liveValidation.isCrossed, false, "Live book should not be crossed");
    assert.ok(liveValidation.bestBid < liveValidation.bestAsk, "bestBid < bestAsk");

    // 2. Crossed book detection
    const crossedBook = {
      coin: "BTC",
      time: Date.now(),
      levels: [
        [{ px: "75050.0", sz: "1.0", n: 1 }],
        [{ px: "75000.0", sz: "1.0", n: 1 }],
      ],
    };
    const crossedRes = mds.validateBook(crossedBook);
    assert.strictEqual(crossedRes.valid, false);
    assert.strictEqual(crossedRes.isCrossed, true);
    assert.match(crossedRes.errors[0], /Crossed orderbook detected/);

    // 3. Inverted/unordered bids detection
    const unorderedBidsBook = {
      coin: "BTC",
      time: Date.now(),
      levels: [
        [{ px: "74000.0", sz: "1.0", n: 1 }, { px: "74500.0", sz: "1.0", n: 1 }],
        [{ px: "76000.0", sz: "1.0", n: 1 }],
      ],
    };
    const unorderedRes = mds.validateBook(unorderedBidsBook);
    assert.strictEqual(unorderedRes.valid, false);
    assert.match(unorderedRes.errors[0], /Bids not strictly descending/);

    // 4. Future timestamp drift rejection
    const futureBook = {
      coin: "BTC",
      time: Date.now() + 60_000, // 60s in future
      levels: [
        [{ px: "74000.0", sz: "1.0", n: 1 }],
        [{ px: "75000.0", sz: "1.0", n: 1 }],
      ],
    };
    const futureRes = mds.validateBook(futureBook);
    assert.strictEqual(futureRes.valid, false);
    assert.match(futureRes.errors[0], /in the future/);
  });

  it("P1 Market Microstructure: estimates order slippage and market impact", async () => {
    const mds = new MarketDataService("mainnet");

    // Estimate slippage for 0.5 BTC buy
    const estimate = await mds.estimateSlippage("BTC", "buy", 0.5);

    assert.strictEqual(estimate.targetSize, 0.5);
    assert.strictEqual(estimate.side, "buy");
    assert.ok(estimate.expectedAvgPrice > 0);
    assert.ok(estimate.priceImpactPct >= 0);
    assert.strictEqual(estimate.canFillFully, true);
  });

  it("P1 HLP Vault: queries live vault details and enforces 4-day lockup notification", async () => {
    const hlp = new HlpVaultService("mainnet");
    const stats = await hlp.getHlpStats();

    assert.strictEqual(stats.vaultAddress, "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303");
    // P1 #7: equity is live-derived or null — the 850M fabricated fallback is gone.
    if (stats.totalEquityUsd !== null) {
      assert.ok(stats.totalEquityUsd > 100_000_000, "HLP vault equity > $100M when live data is present");
    }
    assert.strictEqual(stats.sharePriceUsd, null, "share price must not be fabricated");
    assert.strictEqual(stats.activePositionsCount, null, "position count must not be fabricated");
    assert.ok(stats.rawVault.allowDeposits === true, "Vault allows deposits");

    // APR vs APY Provenance & Protocol Lockup Invariant
    assert.ok(stats.aprFraction !== undefined && typeof stats.aprFraction === "number", "Raw APR fraction preserved");
    assert.ok(stats.aprPercent !== undefined && typeof stats.aprPercent === "number", "APR percent computed");
    assert.strictEqual(stats.lockingPeriodSeconds, 345_600, "Protocol 4-day lockup period in seconds");
    assert.match(stats.lockupNotice, /4-day/, "Explicit lockup notice presented");
  });
});

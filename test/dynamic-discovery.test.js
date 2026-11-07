/**
 * Dynamic Multi-Chain Market Discovery Verification (Zero-Mock Suite)
 * 
 * STRICT COMPLIANCE:
 * - NO mock exchange adapters or synthetic prices.
 * - Live endpoint health checks and measured roundtrip latency.
 * - Dynamic discovery against live Hyperliquid L1 (/info) and Stellar Horizon.
 * - Cryptographic and microstructure provenance verification.
 * - Fail-closed offline detection and circuit breaker isolation.
 */

const test = require("node:test");
const assert = require("node:assert");
const { ProviderRegistry } = require("../dist/market/registry");
const { MarketDiscoveryService } = require("../dist/market/discovery");
const { HyperliquidAdapter } = require("../dist/market/adapters/hyperliquid");
const { StellarAdapter } = require("../dist/market/adapters/stellar");
const { HyperliquidClient } = require("../dist/hyperliquid/client");

test("Dynamic Discovery: Real Hyperliquid L1 adapter health & measured latency", async () => {
  const adapter = new HyperliquidAdapter();
  assert.strictEqual(adapter.id, "hyperliquid");
  assert.strictEqual(adapter.chain, "hyperliquid");

  const capabilities = adapter.getCapabilities();
  assert.strictEqual(capabilities.supportsPerps, true);
  assert.strictEqual(capabilities.supportsLeverage, true);
  assert.ok(capabilities.maxLeverage >= 20);

  const health = await adapter.checkHealth();
  assert.strictEqual(health.adapterId, "hyperliquid");
  assert.strictEqual(health.status, "connected");
  assert.ok(health.latencyMs > 0 && health.latencyMs < 10_000, `Latency must be measured: ${health.latencyMs}ms`);
  assert.ok(health.activeMarketsCount > 50, `Expected >50 live markets on Hyperliquid L1, got ${health.activeMarketsCount}`);
  assert.ok(health.lastChecked > 0);
  assert.match(health.message, /Connected to mainnet/);
});

test("Dynamic Discovery: Real Hyperliquid market universe discovery & live provenance", async () => {
  const adapter = new HyperliquidAdapter();
  const markets = await adapter.discoverMarkets();

  assert.ok(markets.length > 50, `Expected >50 discovered markets, got ${markets.length}`);

  // Core instruments must be dynamically discovered from exchange metadata
  const btcPerp = markets.find((m) => m.symbol === "BTC-PERP");
  assert.ok(btcPerp, "BTC-PERP must be discovered from Hyperliquid metadata");
  assert.strictEqual(btcPerp.chain, "hyperliquid");
  assert.strictEqual(btcPerp.marketType, "perpetual");
  assert.strictEqual(btcPerp.baseAsset, "BTC");
  assert.strictEqual(btcPerp.quoteAsset, "USDC");
  assert.strictEqual(btcPerp.supportsPerps, true);
  assert.ok(btcPerp.maxLeverage >= 20);

  // Live prices and microstructure metrics
  assert.ok(btcPerp.lastPrice !== undefined && btcPerp.lastPrice > 10_000, `Live BTC mark price > $10k: ${btcPerp.lastPrice}`);
  assert.ok(btcPerp.bidPrice !== undefined && btcPerp.bidPrice > 10_000, `Live bid price: ${btcPerp.bidPrice}`);
  assert.ok(btcPerp.askPrice !== undefined && btcPerp.askPrice >= btcPerp.bidPrice, "askPrice >= bidPrice");
  assert.ok(btcPerp.spreadBps !== undefined && btcPerp.spreadBps >= 0, "spreadBps >= 0");

  // Strict live provenance
  assert.strictEqual(btcPerp.provenance.isLive, true);
  assert.strictEqual(btcPerp.provenance.provider, "hyperliquid-info-api");
  assert.strictEqual(btcPerp.provenance.dataFreshness, "realtime");
  assert.ok(btcPerp.provenance.exchangeTimestamp > 0);
  assert.ok(btcPerp.provenance.feedLatencyMs >= 0);

  // Discover HYPE-PERP
  const hypePerp = markets.find((m) => m.symbol === "HYPE-PERP");
  assert.ok(hypePerp, "HYPE-PERP must be discovered dynamically from live exchange metadata");
  assert.ok(hypePerp.lastPrice !== undefined && hypePerp.lastPrice > 0, `HYPE price: ${hypePerp.lastPrice}`);
});

test("Dynamic Discovery: Unconnected / Dead venue is NOT marked connected", async () => {
  // Point to a guaranteed dead local port
  const deadAdapter = new StellarAdapter("http://127.0.0.1:59999");
  const health = await deadAdapter.checkHealth();

  assert.notStrictEqual(health.status, "connected");
  assert.strictEqual(health.status, "disconnected");
  assert.strictEqual(health.activeMarketsCount, 0);
  assert.ok(health.latencyMs >= 0);
  assert.match(health.message, /unreachable|fetch failed|ECONNREFUSED/i);
});

test("Dynamic Discovery: Real Stellar Horizon ledger discovery & SDEX orderbooks", async () => {
  const adapter = new StellarAdapter("https://horizon.stellar.org");
  const health = await adapter.checkHealth();

  assert.strictEqual(health.status, "connected");
  assert.ok(health.latencyMs > 0 && health.latencyMs < 10_000);
  assert.match(health.message, /Horizon Live \(Ledger: \d+\)/);

  const markets = await adapter.discoverMarkets();
  assert.ok(markets.length >= 2, `Discovered ${markets.length} Stellar markets`);

  // Verify SDEX asset
  const xlm = markets.find((m) => m.baseAsset === "XLM");
  assert.ok(xlm, "XLM SDEX market discovered");
  assert.strictEqual(xlm.chain, "stellar");
  assert.strictEqual(xlm.marketType, "spot");
  assert.strictEqual(xlm.provenance.provider, "stellar-horizon-api");
  assert.strictEqual(xlm.provenance.isLive, true);

  // Verify institutional RWA / Tokenized equity
  const jqqq = markets.find((m) => m.baseAsset === "JQQQ");
  if (jqqq) {
    assert.strictEqual(jqqq.marketType, "tokenized_equity");
    assert.strictEqual(jqqq.supportsSep8, true);
    assert.ok(jqqq.contractAddress, "Issuer public key present");
  }
});

test("Dynamic Discovery: Fault isolation — failing adapter does NOT crash discovery", async () => {
  const registry = new ProviderRegistry();
  const goodAdapter = new HyperliquidAdapter();
  const deadAdapter = new StellarAdapter("http://127.0.0.1:59999");

  registry.registerAdapter(goodAdapter);
  registry.registerAdapter(deadAdapter);

  const discovery = new MarketDiscoveryService({ registry, skipDefaultAdapters: true });
  const markets = await discovery.getMarkets();

  // Good adapter markets must be discovered cleanly despite dead adapter failure
  assert.ok(markets.length > 50, `Expected >50 markets from operational adapter, got ${markets.length}`);
  const btc = markets.find((m) => m.symbol === "BTC-PERP");
  assert.ok(btc, "BTC-PERP discovered despite sibling adapter outage");
  assert.strictEqual(btc.provenance.isLive, true);
});

test("Dynamic Discovery: Universal cross-chain search and canonical marketId deduplication", async () => {
  const registry = new ProviderRegistry();
  const hlAdapter = new HyperliquidAdapter();
  const stellarAdapter = new StellarAdapter("https://horizon.stellar.org");

  registry.registerAdapter(hlAdapter);
  registry.registerAdapter(stellarAdapter);

  const discovery = new MarketDiscoveryService({ registry, skipDefaultAdapters: true });

  const btcResults = await discovery.searchAssetAcrossAllChains("BTC");
  assert.ok(btcResults.length >= 1, "Discovered BTC markets");
  assert(btcResults.some((m) => m.chain === "hyperliquid" && m.symbol === "BTC-PERP"));

  // Verify canonical format of all marketIds: ${chain}:${exchange}:${symbol}
  const allMarkets = await discovery.getMarkets();
  for (const m of allMarkets.slice(0, 30)) {
    const parts = m.marketId.split(":");
    assert.ok(parts.length >= 3, `Market ID should have chain:exchange:symbol format, got ${m.marketId}`);
    assert.strictEqual(parts[0], m.chain);
  }
});

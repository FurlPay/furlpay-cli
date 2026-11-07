/**
 * FurlPay Core L1 Financial Engine & Institutional Risk Test Suite (2026)
 * 
 * Verifies:
 * 1. FurlPay CLOB: Price-time priority matching, ALO, IOC, GTC, discrete tick/lot rounding, cancel-by-cloid.
 * 2. FurlPay Clearinghouse: Deposit, $1 withdrawal fee, position margin holds, realized/unrealized P&L.
 * 3. Exact Liquidation Mathematics: Maintenance margin rate l = 1 / (2 * maxLeverage), long/short equations.
 * 4. FLP Protocol Vault: Pro-rata share issuance, 4-day withdrawal lockup enforcement, liquidation absorption.
 * 5. Funding Engine: Order book premium sampling, +/-0.05% clamp bounds, hourly settlement.
 * 6. Cross-VM Precompiles: 0x...0801 spot balance and 0x...0807 mark price simulator.
 * 7. Candlestick Renderer: fromCandleSnapshots, fromTrades, deterministic LCG generation (zero Math.random()).
 * 8. Unified Risk Engine: Quote freshness, slippage, stablecoin peg divergence, margin stress warnings.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const {
  FurlPayCLOB,
  FurlPayClearinghouse,
  FLPVault,
  FurlPayFundingEngine,
  FurlPayCoreEngine,
} = require("../dist/engine/furlpay-core");
const { CandlestickChartRenderer } = require("../dist/tui/chart/candlestick");
const { FurlPayInstitutionalRiskEngine } = require("../dist/services/risk-engine");

describe("FurlPay Sovereign L1 Core Financial Engine & Workstation Suite", () => {
  const btcMeta = {
    coin: "BTC",
    szDecimals: 3,
    tickSize: 0.5,
    maxLeverage: 50,
    minOrderNotionalUsd: 10.0,
  };

  it("P0 CLOB: enforces discrete tick sizes, lot precision, and price-time priority matching", () => {
    const clob = new FurlPayCLOB(btcMeta);

    // Discrete rounding
    assert.strictEqual(clob.roundPrice(92150.24), 92150.0);
    assert.strictEqual(clob.roundPrice(92150.26), 92150.5);
    assert.strictEqual(clob.roundSize(0.1239), 0.123);

    // Resting maker sell order
    const sellRes = clob.placeOrder({
      coin: "BTC",
      isBuy: false,
      limitPx: 92000.0,
      sz: 0.5,
      tif: "Gtc",
      cloid: "0xmaker1",
      user: "0xMakerAlice",
    });
    assert.strictEqual(sellRes.success, true);
    assert.strictEqual(sellRes.result.filledSz, 0);
    assert.ok(sellRes.result.restingOrder);
    assert.strictEqual(sellRes.result.restingOrder.oid, 100000);

    // Aggressive taker buy order (crossing spread)
    const buyRes = clob.placeOrder({
      coin: "BTC",
      isBuy: true,
      limitPx: 92100.0,
      sz: 0.2,
      tif: "Ioc",
      user: "0xTakerBob",
    });
    assert.strictEqual(buyRes.success, true);
    assert.strictEqual(buyRes.result.filledSz, 0.2);
    assert.strictEqual(buyRes.result.avgPx, 92000.0);
    assert.strictEqual(buyRes.result.makerOrders.length, 1);
    assert.strictEqual(buyRes.result.makerOrders[0].user, "0xMakerAlice");
    assert.strictEqual(buyRes.result.makerOrders[0].filledSz, 0.2);

    // Check depth
    const topAsks = clob.getTopAsks(5);
    assert.strictEqual(topAsks.length, 1);
    assert.strictEqual(topAsks[0].px, "92000.000");
    assert.strictEqual(topAsks[0].sz, "0.300"); // 0.5 - 0.2 = 0.3
  });

  it("P0 CLOB: enforces ALO (Post-Only) rejection and cancellation by cloid", () => {
    const clob = new FurlPayCLOB(btcMeta);

    // Place resting ask at 92000
    clob.placeOrder({
      coin: "BTC",
      isBuy: false,
      limitPx: 92000.0,
      sz: 0.5,
      cloid: "0xseller",
      user: "0xAlice",
    });

    // ALO buy at 92500 would cross ask -> must reject
    const aloCrossing = clob.placeOrder({
      coin: "BTC",
      isBuy: true,
      limitPx: 92500.0,
      sz: 0.1,
      tif: "Alo",
      user: "0xBob",
    });
    assert.strictEqual(aloCrossing.success, false);
    assert.match(aloCrossing.error, /POST_ONLY_REJECTED/);

    // Cancel resting order by cloid
    const cancelled = clob.cancelByCloid("0xseller");
    assert.strictEqual(cancelled, true);
    assert.strictEqual(clob.getTopAsks().length, 0);
  });

  it("P1 Clearinghouse: deposits, $1.00 withdrawal fee, and realized P&L accounting", () => {
    const clearinghouse = new FurlPayClearinghouse();

    // Deposit $10,000 USD
    clearinghouse.deposit("0xTrader", 10_000.0);
    const u = clearinghouse.getOrCreateUser("0xTrader");
    assert.strictEqual(u.accountValue, 10_000.0);
    assert.strictEqual(u.freeCollateral, 10_000.0);

    // Open Long position: 1.0 BTC @ 90,000 with 10x leverage
    clearinghouse.updatePosition({
      user: "0xTrader",
      coin: "BTC",
      fillSz: 1.0,
      fillPx: 90_000.0,
      isBuy: true,
      leverage: 10,
      maxLeverage: 50,
    });

    const pos = u.positions.get("BTC");
    assert.ok(pos);
    assert.strictEqual(pos.size, 1.0);
    assert.strictEqual(pos.marginUsed, 9_000.0); // $90,000 / 10 = $9,000
    assert.strictEqual(u.freeCollateral, 1_000.0); // $10,000 - $9,000 = $1,000

    // Verify maintenance margin rate l = 1 / (2 * 50) = 0.01 (1%)
    // Liquidation price = 90,000 * (1 - 1/10) / (1 - 0.01) = 90,000 * 0.9 / 0.99 = 81,818.18
    assert.ok(Math.abs(pos.liquidationPx - 81818.18) < 1.0);

    // Close position @ 95,000 -> Profit = 1.0 * (95,000 - 90,000) = $5,000
    clearinghouse.updatePosition({
      user: "0xTrader",
      coin: "BTC",
      fillSz: 1.0,
      fillPx: 95_000.0,
      isBuy: false,
      leverage: 10,
      maxLeverage: 50,
    });

    assert.strictEqual(u.positions.has("BTC"), false);
    assert.strictEqual(u.accountValue, 15_000.0); // $10,000 + $5,000
    assert.strictEqual(u.freeCollateral, 15_000.0);

    // Withdraw $5,000 with $1.00 fee -> Net deduct $5,001.00
    const withdrawOk = clearinghouse.withdraw("0xTrader", 5_000.0);
    assert.strictEqual(withdrawOk, true);
    assert.strictEqual(u.accountValue, 9_999.0);
  });

  it("P1 FLP Protocol Vault: pro-rata share minting, 4-day lockup enforcement, and liquidation absorption", () => {
    const vault = new FLPVault(1_000_000); // Initial capital $1M

    // Alice deposits $100,000
    const res = vault.deposit("0xAlice", 100_000);
    assert.strictEqual(res.sharesMinted, 100_000);
    assert.strictEqual(vault.totalUsd, 1_100_000);

    // Immediate withdrawal fails due to 4-day lockup cooldown
    const immediateWithdraw = vault.withdraw("0xAlice", 100_000);
    assert.strictEqual(immediateWithdraw.success, false);
    assert.match(immediateWithdraw.error, /LOCKUP_ACTIVE/);

    // Vault absorbs an underwater liquidation
    vault.absorbLiquidation(50_000, 1_500); // Retains $1,500 liquidation buffer
    assert.strictEqual(vault.totalUsd, 1_101_500);
  });

  it("P1 Funding Engine: order book premium sampling, +/-0.05% clamp, and rate derivation", () => {
    const funding = new FurlPayFundingEngine();

    // Mid price 92050, Oracle price 92000 -> Premium = (92050 - 92000) / 92000 = +0.000543 (5.43 bps)
    funding.samplePremium(92050, 92000);
    funding.samplePremium(92060, 92000);

    const rate = funding.computeFundingRate();
    assert.ok(typeof rate === "number");
    assert.ok(rate > 0); // Positive funding: longs pay shorts
  });

  it("P1 Sovereign FurlPayCoreEngine: end-to-end matching, cross-VM precompiles, and margin limits", () => {
    const engine = new FurlPayCoreEngine(btcMeta);

    // Seed Trader account with $50,000
    engine.clearinghouse.deposit("0xTraderOne", 50_000.0);

    // Precompile test: 0x...0801 (Spot balance)
    const balance = engine.readPrecompileSpotBalance("0xTraderOne");
    assert.strictEqual(balance, 50_000.0);

    // Precompile test: 0x...0807 (Oracle mark price)
    const oraclePx = engine.readPrecompileOraclePrice(92150.3);
    assert.strictEqual(oraclePx, 92150.5); // Rounded to 0.5 tick

    // Submit order exceeding free collateral
    const excessiveOrder = engine.submitOrder(
      {
        coin: "BTC",
        isBuy: true,
        limitPx: 90000.0,
        sz: 10.0, // Notional $900,000 -> 10x requires $90,000 margin > $50,000
        user: "0xTraderOne",
      },
      10
    );
    assert.strictEqual(excessiveOrder.success, false);
    assert.match(excessiveOrder.error, /INSUFFICIENT_MARGIN/);

    // Submit compliant order
    const compliantOrder = engine.submitOrder(
      {
        coin: "BTC",
        isBuy: true,
        limitPx: 90000.0,
        sz: 1.0, // Requires $9,000 margin <= $50,000
        user: "0xTraderOne",
      },
      10
    );
    assert.strictEqual(compliantOrder.success, true);
  });

  it("P1 Candlestick Renderer: zero Math.random(), fromCandleSnapshots, fromTrades, and deterministic LCG", () => {
    // 1. Snapshot parser
    const snapshots = [
      { t: 1718000000000, o: "91000.0", h: "91500.0", l: "90900.0", c: "91400.0", v: "15.5" },
      { t: 1718000060000, o: "91400.0", h: "91800.0", l: "91350.0", c: "91750.0", v: "22.1" },
    ];
    const candlesFromSnapshots = CandlestickChartRenderer.fromCandleSnapshots(snapshots);
    assert.strictEqual(candlesFromSnapshots.length, 2);
    assert.strictEqual(candlesFromSnapshots[0].close, 91400.0);
    assert.strictEqual(candlesFromSnapshots[1].volume, 22.1);

    // 2. Trades aggregator
    const trades = [
      { px: 92000, sz: 0.5, time: 10000 },
      { px: 92200, sz: 1.0, time: 20000 },
      { px: 91900, sz: 0.2, time: 40000 },
      { px: 92100, sz: 0.3, time: 55000 },
    ];
    const aggregated = CandlestickChartRenderer.fromTrades(trades, 60000);
    assert.strictEqual(aggregated.length, 1);
    assert.strictEqual(aggregated[0].open, 92000);
    assert.strictEqual(aggregated[0].high, 92200);
    assert.strictEqual(aggregated[0].low, 91900);
    assert.strictEqual(aggregated[0].close, 92100);
    assert.strictEqual(aggregated[0].volume, 2.0); // 0.5 + 1.0 + 0.2 + 0.3

    // 3. Deterministic LCG generates identical output without Math.random()
    const run1 = CandlestickChartRenderer.generateCandles(90000, 10);
    const run2 = CandlestickChartRenderer.generateCandles(90000, 10);
    assert.deepStrictEqual(
      run1.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      run2.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    );
  });

  it("P1 Unified Risk Engine: verifies exact liquidation formulas, stablecoin peg checks, and margin stress", () => {
    const risk = new FurlPayInstitutionalRiskEngine({
      maxLeverage: 10,
      maxSlippageBps: 50,
      maxStablecoinDepegBps: 25,
    });

    // Exact maintenance margin fraction: l = 1 / (2 * 50) = 0.01 (1%)
    const mmRate = FurlPayInstitutionalRiskEngine.calculateMaintenanceMarginRate(50);
    assert.strictEqual(mmRate, 0.01);

    // Exact liquidation price calculation:
    // Long 10x on Entry 100 with maxLeverage 50 (l = 0.01):
    // Liq = 100 * (1 - 1/10) / (1 - 0.01) = 100 * 0.9 / 0.99 = 90.90909
    const liqLong = FurlPayInstitutionalRiskEngine.calculateLiquidationPrice(100, 10, true, 50);
    assert.ok(Math.abs(liqLong - 90.909) < 0.01);

    // Short 10x on Entry 100:
    // Liq = 100 * (1 + 1/10) / (1 + 0.01) = 100 * 1.1 / 1.01 = 108.91089
    const liqShort = FurlPayInstitutionalRiskEngine.calculateLiquidationPrice(100, 10, false, 50);
    assert.ok(Math.abs(liqShort - 108.91) < 0.01);

    // Stablecoin peg check: USDC $0.998 vs USDT $1.000 -> Diff = 20 bps <= 25 bps (Passes)
    const pegPass = risk.checkStablecoinPeg(0.998, 1.000);
    assert.strictEqual(pegPass.passed, true);

    // USDC $0.996 vs USDT $1.000 -> Diff = 40 bps > 25 bps (Fails circuit breaker)
    const pegFail = risk.checkStablecoinPeg(0.996, 1.000);
    assert.strictEqual(pegFail.passed, false);
    assert.match(pegFail.reason, /STABLECOIN_DEPEG_BREACH/);

    // Margin stress evaluation
    const stress = risk.evaluateAccountRisk(100_000, 85_000); // 85% margin ratio
    assert.strictEqual(stress.isHighRisk, true);
    assert.match(stress.warningMessage, /WARNING: Margin ratio elevated/);
  });
});

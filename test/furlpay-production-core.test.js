/**
 * FurlPay Production Core P0 Verification Suite (2026)
 * 
 * Verifies:
 * 1. Decimal Accounting: Scaled BigInt arithmetic, tick/lot rounding, realized P&L, liquidation math.
 * 2. Order Lifecycle: Strict state machine, 128-bit cloid idempotency, partial/full fills, terminal guards.
 * 3. Execution Authorization: Default-deny perimeter, mandate ceilings, daily velocity, kill switch.
 * 4. Exchange Reconciler: Equity/margin/position divergence detection (> $0.01), state synchronization.
 * 5. Market Recovery Engine: Order book reconstruction after disconnect, timeout resolution.
 * 6. Durable Event Store: SHA-256 cryptographic chain integrity and audit log persistence.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { DecimalMath } = require("../dist/precision/decimal-math");
const { OrderLifecycleManager } = require("../dist/order/lifecycle-manager");
const { ExecutionAuthorizationService } = require("../dist/execution/authorization-service");
const { ExchangeStateReconciler } = require("../dist/reconciliation/exchange-reconciler");
const { MarketDataRecoveryEngine } = require("../dist/market/recovery-engine");
const { DurableEventStore } = require("../dist/blotter/durable-event-store");

describe("FurlPay Production Core P0 Verification Suite", () => {
  it("P0 Decimal Accounting: eliminates floating-point drift and rounds to discrete ticks/lots", () => {
    // 0.1 + 0.2 floating point flaw check
    const sum = DecimalMath.formatUnits(
      DecimalMath.parseUnits("0.1", 6) + DecimalMath.parseUnits("0.2", 6),
      6
    );
    assert.strictEqual(sum, "0.300000");

    // Multiplication & Division
    const notional = DecimalMath.mul("1.500", "92150.50", 6);
    assert.strictEqual(notional, "138225.750000");

    // Tick rounding
    assert.strictEqual(DecimalMath.roundToTick("92150.24", 0.5), "92150.0");
    assert.strictEqual(DecimalMath.roundToTick("92150.26", 0.5), "92150.5");
    assert.strictEqual(DecimalMath.roundToLot("0.12395", 3), "0.123");

    // Realized P&L
    // Long 2.0 BTC: Entry 90,000, Exit 95,000 -> P&L = +$10,000.00
    const longPnl = DecimalMath.computeRealizedPnl(true, "2.0", "90000.0", "95000.0");
    assert.strictEqual(longPnl, "10000.000000");

    // Short 2.0 BTC: Entry 90,000, Exit 95,000 -> P&L = -$10,000.00
    const shortPnl = DecimalMath.computeRealizedPnl(false, "2.0", "90000.0", "95000.0");
    assert.strictEqual(shortPnl, "-10000.000000");

    // Liquidation price calculation: Entry 90,000, Leverage 10x, MaxLeverage 50 (l = 0.01)
    const liqPx = DecimalMath.computeLiquidationPrice("90000.0", 10, true, 50);
    assert.strictEqual(liqPx, "81818.18");
  });

  it("P0 Order Lifecycle & Idempotency: enforces state machine transitions and prevents duplicate cloids", () => {
    const mgr = new OrderLifecycleManager();

    // Generate compliant 128-bit hex cloid
    const cloid = OrderLifecycleManager.generateCloid();
    assert.strictEqual(cloid.startsWith("0x"), true);
    assert.strictEqual(cloid.length, 34); // 0x + 32 hex chars

    // Create order
    const order = mgr.createOrder({
      coin: "BTC",
      side: "buy",
      price: "92000.0",
      size: "1.0",
      customCloid: cloid,
    });
    assert.strictEqual(order.state, "CREATED");

    // Idempotency check: duplicate cloid throws
    assert.throws(
      () =>
        mgr.createOrder({
          coin: "BTC",
          side: "buy",
          price: "92000.0",
          size: "1.0",
          customCloid: cloid,
        }),
      /IDEMPOTENCY_VIOLATION/
    );

    // Lifecycle progression: CREATED -> AUTHORIZED -> SUBMITTED -> RESTING
    mgr.markAuthorized(order.orderId);
    assert.strictEqual(order.state, "AUTHORIZED");

    mgr.markSubmitted(order.orderId);
    assert.strictEqual(order.state, "SUBMITTED");

    mgr.markResting(order.orderId, 10042);
    assert.strictEqual(order.state, "RESTING");
    assert.strictEqual(order.exchangeOid, 10042);

    // Partial fill
    mgr.recordFill(order.orderId, "0.4", "92000.0", "1.50");
    assert.strictEqual(order.state, "PARTIALLY_FILLED");
    assert.strictEqual(order.filledSize, "0.4000");

    // Complete fill
    mgr.recordFill(order.orderId, "0.6", "92000.0", "2.25");
    assert.strictEqual(order.state, "FILLED");
    assert.strictEqual(order.filledSize, "1.0000");

    // Terminal state protection: cannot cancel a FILLED order
    assert.throws(() => mgr.markCancelled(order.orderId), /ILLEGAL_TRANSITION/);
  });

  it("P0 Execution Authorization: default-deny enforcement, mandate ceilings, and kill switch", () => {
    const auth = new ExecutionAuthorizationService();
    const agentAddr = "0xAgentHotKey123456789012345678901234567890";

    // 1. Unregistered agent is rejected by default-deny policy
    const unauth = auth.authorizeExecution({
      symbol: "BTC",
      side: "buy",
      notionalUsd: 5_000,
      agentAddress: agentAddr,
    });
    assert.strictEqual(unauth.authorized, false);
    assert.match(unauth.reason, /UNAUTHORIZED_AGENT/);

    // 2. Register valid mandate
    auth.registerMandate({
      agentAddress: agentAddr,
      masterAddress: "0xMasterColdWallet",
      maxSingleOrderUsd: 25_000,
      dailyVelocityCapUsd: 100_000,
      expiresAt: Date.now() + 3600_000, // 1 hour
      allowedSymbols: ["BTC", "ETH"],
      isRevoked: false,
    });

    // 3. Unauthorized symbol rejection
    const badSymbol = auth.authorizeExecution({
      symbol: "SOL",
      side: "buy",
      notionalUsd: 5_000,
      agentAddress: agentAddr,
    });
    assert.strictEqual(badSymbol.authorized, false);
    assert.match(badSymbol.reason, /UNAUTHORIZED_SYMBOL/);

    // 4. Single order limit breach rejection
    const excessiveOrder = auth.authorizeExecution({
      symbol: "BTC",
      side: "buy",
      notionalUsd: 30_000, // > 25,000 ceiling
      agentAddress: agentAddr,
    });
    assert.strictEqual(excessiveOrder.authorized, false);
    assert.match(excessiveOrder.reason, /SINGLE_ORDER_CEILING_BREACH/);

    // 5. Valid compliant execution approved with monotonic nonce
    const compliant = auth.authorizeExecution({
      symbol: "BTC",
      side: "buy",
      notionalUsd: 10_000,
      agentAddress: agentAddr,
    });
    assert.strictEqual(compliant.authorized, true);
    assert.ok(compliant.nonce && compliant.nonce > 0);

    // 6. Emergency Kill Switch halts execution immediately
    auth.triggerKillSwitch();
    assert.strictEqual(auth.getIsKillSwitchActive(), true);

    const killCheck = auth.authorizeExecution({
      symbol: "BTC",
      side: "buy",
      notionalUsd: 1_000,
      agentAddress: agentAddr,
    });
    assert.strictEqual(killCheck.authorized, false);
    assert.match(killCheck.reason, /KILL_SWITCH_ACTIVE/);
  });

  it("P0 Exchange State Reconciler: detects equity/margin/position divergence > $0.01 and synchronizes", () => {
    const reconciler = new ExchangeStateReconciler();

    const internalState = {
      accountValueUsd: 100_000.0,
      totalMarginUsedUsd: 20_000.0,
      freeCollateralUsd: 80_000.0,
      positions: new Map([["BTC", { size: 1.5, entryPx: 90000.0 }]]),
    };

    // Case 1: Perfect parity
    const perfectExchange = {
      accountValue: "100000.0",
      totalMarginUsed: "20000.0",
      withdrawable: "80000.0",
      assetPositions: [{ coin: "BTC", size: "1.5", entryPx: "90000.0" }],
    };

    const cleanReport = reconciler.reconcile(internalState, perfectExchange);
    assert.strictEqual(cleanReport.isSynchronized, true);
    assert.strictEqual(cleanReport.discrepancies.length, 0);

    // Case 2: Divergence detected ($500 missing on exchange account value)
    const divergentExchange = {
      accountValue: "99500.0", // Delta $500 > $0.01
      totalMarginUsed: "20000.0",
      withdrawable: "79500.0",
      assetPositions: [{ coin: "BTC", size: "1.0", entryPx: "90000.0" }], // Size delta 0.5 BTC
    };

    const alertReport = reconciler.reconcile(internalState, divergentExchange);
    assert.strictEqual(alertReport.isSynchronized, false);
    assert.ok(alertReport.discrepancies.length >= 2);
    assert.ok(alertReport.totalDivergenceUsd > 100.0);

    // Synchronize to bring internal state into parity
    reconciler.synchronize(internalState, divergentExchange);
    assert.strictEqual(internalState.accountValueUsd, 99500.0);
    assert.strictEqual(internalState.positions.get("BTC").size, 1.0);
  });

  it("P0 Market Data Recovery Engine: recovers order book from snapshot and resolves timed-out orders", async () => {
    const recovery = new MarketDataRecoveryEngine();

    // Simulate disconnect
    recovery.notifyDisconnect();
    assert.strictEqual(recovery.getHealthState(), "DISCONNECTED");

    // Mock REST snapshot fetcher
    const mockSnapshot = async (coin) => ({
      levels: [
        [{ px: "91990.0", sz: "1.2" }, { px: "91980.0", sz: "3.5" }],
        [{ px: "92010.0", sz: "0.8" }, { px: "92020.0", sz: "2.1" }],
      ],
    });

    const recovered = await recovery.recoverOrderBook("BTC", mockSnapshot);
    assert.strictEqual(recovery.getHealthState(), "HEALTHY");
    assert.strictEqual(recovered.bids.length, 2);
    assert.strictEqual(recovered.asks.length, 2);
    assert.strictEqual(recovered.midPx, 92000.0);
    assert.strictEqual(recovered.spreadBps, 2.17);

    // Resolve in-flight timed-out orders
    const pendingCloids = ["0xorderA", "0xorderB"];
    const exchangeOpenOrders = [
      { cloid: "0xorderA", oid: 5001, coin: "BTC", limitPx: "91990.0", sz: "0.5" },
    ];

    const resolution = recovery.resolveTimedOutOrders(pendingCloids, exchangeOpenOrders);
    assert.strictEqual(resolution.confirmedResting.length, 1);
    assert.strictEqual(resolution.confirmedResting[0].cloid, "0xorderA");
    assert.strictEqual(resolution.confirmedResting[0].oid, 5001);
    assert.strictEqual(resolution.presumedFilledOrCancelled.length, 1);
    assert.strictEqual(resolution.presumedFilledOrCancelled[0], "0xorderB");
  });

  it("P0 Durable Event Store: maintains SHA-256 cryptographic chain integrity", () => {
    const store = new DurableEventStore();

    const ev1 = store.appendEvent("INTENT_CREATED", { symbol: "BTC", notional: 10000 });
    const ev2 = store.appendEvent("AUTHORIZATION_GRANTED", { agent: "0xAgent", nonce: 12345 });
    const ev3 = store.appendEvent("ORDER_SUBMITTED", { oid: 9901 });

    assert.strictEqual(store.getEventCount(), 3);
    assert.strictEqual(ev2.previousHash, ev1.hash);
    assert.strictEqual(ev3.previousHash, ev2.hash);
    assert.strictEqual(store.verifyIntegrity(), true);
  });
});

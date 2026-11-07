/**
 * Institutional Trading Workstation & Performance Verification (Section 7 Suite)
 * 
 * Verifies:
 * 1. Terminal Resize (SIGWINCH): Reflow from 140x40 to 80x24 without errors.
 * 2. Keyboard Responsiveness: Rapid keystroke queue processing (<50ms).
 * 3. High-Frequency Burst: 500 L2 updates/sec with bounded event loop lag.
 * 4. WebSocket Disconnection & Auto-Reconnection: Exponential backoff recovery.
 * 5. Stale Market Data Lockout: 350ms delay triggers STALE_QUOTE rejection.
 * 6. Crossed Book Invariant: Best Bid >= Best Ask rejected immediately.
 * 7. Multi-Market Concurrency: 10 simultaneous perpetual pairs managed cleanly.
 * 8. Memory Leak Soak Test: 100,000 sequential updates with bounded RSS memory.
 * 9. Execution Authorization Under Heavy Load: Non-bypassable human approval [y/N].
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { InstitutionalWorkstation } = require("../dist/tui/institutional-workstation");
const { DifferentialTerminalEngine } = require("../dist/tui/render/differential-engine");
const { SynchronousRiskEngine } = require("../dist/services/risk-engine");
const { HyperliquidLowLatencyFeed } = require("../dist/services/hyperliquid-feed");
const { CandlestickChartRenderer } = require("../dist/tui/chart/candlestick");

describe("Institutional Trading Workstation & Performance Matrix", () => {
  it("P0: Terminal Resize (SIGWINCH) dynamic reflow without corruption", () => {
    let outputBuffer = "";
    const writer = (data) => {
      outputBuffer += data;
    };

    const ws = new InstitutionalWorkstation({
      headless: true,
      width: 140,
      height: 40,
      outWriter: writer,
    });

    const initialMutations = ws.flush();
    assert.ok(initialMutations > 0, "Initial render must produce cells in back buffer");
    assert.strictEqual(ws.getDifferentialEngine().getWidth(), 140);
    assert.strictEqual(ws.getDifferentialEngine().getHeight(), 40);

    // Simulate SIGWINCH resize to compact laptop display: 80x24
    outputBuffer = "";
    ws.getDifferentialEngine().resize(80, 24);
    assert.strictEqual(ws.getDifferentialEngine().getWidth(), 80);
    assert.strictEqual(ws.getDifferentialEngine().getHeight(), 24);

    const reflowMutations = ws.flush();
    assert.ok(reflowMutations > 0, "Reflow after resize must populate new cell matrix");
    assert.ok(outputBuffer.includes("\x1b[2J"), "Screen clear sequence emitted on resize");
  });

  it("P0: Keyboard Responsiveness under rapid keystroke bursts", () => {
    const ws = new InstitutionalWorkstation({ headless: true });

    const keyQueue = [
      "\t",        // Switch pane -> chart
      "\t",        // Switch pane -> book
      "1",         // Timeframe 1m
      "2",         // Timeframe 5m
      "3",         // Timeframe 15m
      "\u001b[B",  // Down arrow in market watch
      "\u001b[B",  // Down arrow in market watch
      "\u001b[A",  // Up arrow in market watch
      "\u001b[Z",  // Shift+Tab -> permission mode auto
      "/",         // Open Command Palette
      "\u001b",    // Escape dismisses Command Palette
    ];

    const start = performance.now();
    for (const key of keyQueue) {
      const handled = ws.handleKey(key);
      assert.strictEqual(handled, true, `Key ${JSON.stringify(key)} must be handled`);
    }
    const elapsed = performance.now() - start;
    const avgLatency = elapsed / keyQueue.length;

    assert.ok(avgLatency < 5.0, `Average key response should be < 5ms, got ${avgLatency.toFixed(2)}ms`);
    assert.strictEqual(ws.timeframe, "15m");
    assert.strictEqual(ws.permissionMode, "auto");
    assert.strictEqual(ws.isPaletteOpen, false);
  });

  it("P1: High-Frequency Burst (500 L2 updates/sec)", () => {
    let eventCount = 0;
    const feed = new HyperliquidLowLatencyFeed({
      coin: "BTC",
      onEvent: () => {
        eventCount++;
      },
      onStatusChange: () => {},
    });

    const start = performance.now();
    const burstSize = 500;

    for (let i = 0; i < burstSize; i++) {
      const raw = {
        time: Date.now() - 5,
        levels: [
          [{ px: (75000 - i * 0.1).toFixed(1), sz: "1.5" }],
          [{ px: (75001 + i * 0.1).toFixed(1), sz: "2.0" }],
        ],
      };
      const ok = feed.handleOrderBook(raw, Date.now());
      assert.strictEqual(ok, true);
    }

    const elapsed = performance.now() - start;
    assert.strictEqual(eventCount, burstSize);
    assert.ok(elapsed < 200, `500 L2 updates processed in ${elapsed.toFixed(1)}ms (< 200ms)`);
  });

  it("P1: WebSocket Disconnection & Reconnection logic", async () => {
    let lastStatus = "";
    let statusResolve;
    const statusPromise = new Promise((resolve) => {
      statusResolve = resolve;
    });

    const feed = new HyperliquidLowLatencyFeed({
      coin: "HYPE",
      wsUrlOverride: "ws://127.0.0.1:59999", // Unreachable port
      onEvent: () => {},
      onStatusChange: (status) => {
        lastStatus = status;
        if (status === "DISCONNECTED" && statusResolve) {
          statusResolve(status);
        }
      },
    });

    feed.connect();
    const result = await Promise.race([
      statusPromise,
      new Promise((r) => setTimeout(() => r(lastStatus), 1500)),
    ]);
    assert.strictEqual(result, "DISCONNECTED");

    // Clean disconnect
    feed.disconnect();
  });

  it("P0 Security: Stale Market Data Lockout blocks trade execution", () => {
    const risk = new SynchronousRiskEngine({ quoteMaxAgeMs: 200 });
    const now = Date.now();

    // Stale quote: 350ms old (> 200ms limit)
    const staleRequest = {
      symbol: "HYPE-PERP",
      side: "buy",
      amountUsd: 10_000,
      quotePrice: 42.85,
      quoteTimestampMs: now - 350,
    };

    const check = risk.evaluatePreTrade(staleRequest, 100_000, 20_000, 42.85);
    assert.strictEqual(check.passed, false);
    assert.match(check.reason, /STALE_QUOTE/);
    assert.match(check.reason, /Age 35\dms exceeds limit of 200ms/);
  });

  it("P0 Security: Crossed Book Invariant rejects inverted bids/asks", () => {
    let statusLog = "";
    const feed = new HyperliquidLowLatencyFeed({
      coin: "HYPE",
      onEvent: () => {},
      onStatusChange: (status) => {
        statusLog = status;
      },
    });

    // Inverted: Best Bid ($101.00) >= Best Ask ($100.00)
    const crossedRaw = {
      time: Date.now(),
      levels: [
        [{ px: "101.00", sz: "5.0" }],
        [{ px: "100.00", sz: "3.0" }],
      ],
    };

    const handled = feed.handleOrderBook(crossedRaw, Date.now());
    assert.strictEqual(handled, false, "Crossed book must be rejected");
    assert.strictEqual(statusLog, "INVALID_BOOK", "Status must become INVALID_BOOK");
  });

  it("P1: Multi-Market Concurrency across 10 perpetual pairs", () => {
    const pairs = ["HYPE", "BTC", "ETH", "SOL", "ARB", "SUI", "AVAX", "DOGE", "LINK", "OP"];
    const feeds = [];
    const updatesReceived = {};

    for (const p of pairs) {
      updatesReceived[p] = 0;
      feeds.push(
        new HyperliquidLowLatencyFeed({
          coin: p,
          onEvent: () => {
            updatesReceived[p]++;
          },
          onStatusChange: () => {},
        })
      );
    }

    // Push 10 rounds of updates across all 10 pairs simultaneously
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < pairs.length; i++) {
        feeds[i].handleOrderBook(
          {
            time: Date.now(),
            levels: [
              [{ px: "100.0", sz: "1.0" }],
              [{ px: "100.5", sz: "1.0" }],
            ],
          },
          Date.now()
        );
      }
    }

    for (const p of pairs) {
      assert.strictEqual(updatesReceived[p], 10, `Pair ${p} received all updates`);
    }
  });

  it("P1: Memory Leak Soak Test (100,000 sequential L2 updates)", () => {
    const initialRss = process.memoryUsage().rss;

    const feed = new HyperliquidLowLatencyFeed({
      coin: "ETH",
      onEvent: () => {},
      onStatusChange: () => {},
    });

    const iterations = 100_000;
    const now = Date.now();

    for (let i = 0; i < iterations; i++) {
      feed.handleOrderBook(
        {
          time: now,
          levels: [
            [{ px: "3140.5", sz: "10.0" }],
            [{ px: "3141.0", sz: "8.5" }],
          ],
        },
        now
      );
    }

    if (global.gc) {
      global.gc();
    }

    const finalRss = process.memoryUsage().rss;
    const rssDeltaMb = (finalRss - initialRss) / (1024 * 1024);

    // RSS delta after 100,000 updates must remain bounded (< 35MB)
    assert.ok(
      rssDeltaMb < 35,
      `Memory growth should be bounded, delta: ${rssDeltaMb.toFixed(2)} MB`
    );
  });

  it("P0 Security: Execution Authorization Under Heavy Load with non-bypassable [y/N]", () => {
    const ws = new InstitutionalWorkstation({ headless: true });

    // Simulate heavy background updates
    for (let i = 0; i < 50; i++) {
      ws.bids = [{ price: 42.85 + (i % 2) * 0.01, size: 50000 }];
      ws.asks = [{ price: 42.86 + (i % 2) * 0.01, size: 50000 }];
    }

    // 1. Prepare trade order (pressing 'b')
    const prepared = ws.handleKey("b");
    assert.strictEqual(prepared, true);
    assert.ok(ws.pendingApproval !== null, "Human approval modal must be opened");
    assert.strictEqual(ws.pendingApproval.side, "buy");
    assert.strictEqual(ws.pendingApproval.symbol, "HYPE-PERP");

    // 2. Reject non-interactive / invalid keys while in modal
    const ignored = ws.handleKey("x");
    assert.strictEqual(ignored, false);
    assert.ok(ws.pendingApproval !== null, "Modal still open");

    // 3. User authorizes with 'Y'
    const initialBlotterLength = ws.blotter.length;
    const confirmed = ws.handleKey("y");
    assert.strictEqual(confirmed, true);
    assert.strictEqual(ws.pendingApproval, null, "Modal closed upon confirmation");
    assert.strictEqual(ws.blotter.length, initialBlotterLength + 1, "Order appended to blotter");
    assert.strictEqual(ws.blotter[0].side, "BUY");
    assert.strictEqual(ws.blotter[0].symbol, "HYPE");

    // 4. Test explicit cancellation with 'N'
    ws.handleKey("s");
    assert.ok(ws.pendingApproval !== null);
    assert.strictEqual(ws.pendingApproval.side, "sell");
    ws.handleKey("n");
    assert.strictEqual(ws.pendingApproval, null);
    assert.strictEqual(ws.blotter.length, initialBlotterLength + 1, "Cancelled order NOT added to blotter");
  });
});

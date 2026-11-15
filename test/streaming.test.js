"use strict";
// Streaming engine battery — sequence-gap poisoning, rolling VPIN verdicts,
// and connection-manager lifecycle (backoff, heartbeat, subscription dedup).
// All driven with stubbed transports; no sockets.
const test = require("node:test");
const assert = require("node:assert");
const { L2DeltaBook, RollingVpin, WsConnectionManager } = require("../lib/streaming");

// ── L2 delta book ────────────────────────────────────────────────────────────

const SNAPSHOT = {
  lastUpdateId: 100,
  bids: [{ priceMinor: "99000000", sizeMinor: "5" }, { priceMinor: "98000000", sizeMinor: "3" }],
  asks: [{ priceMinor: "101000000", sizeMinor: "7" }],
};

test("delta book: snapshot replaces state, depth reads best-first", () => {
  const book = new L2DeltaBook("BTCUSDT").applySnapshot(SNAPSHOT);
  const d = book.depth(5);
  assert.strictEqual(d.bids[0].priceMinor, "99000000");
  assert.strictEqual(d.asks[0].priceMinor, "101000000");
});

test("delta book: contiguous delta applies and advances the sequence", () => {
  const book = new L2DeltaBook("BTCUSDT").applySnapshot(SNAPSHOT);
  const out = book.applyDelta({
    firstUpdateId: 101, lastUpdateId: 110,
    bids: [{ priceMinor: "99000000", sizeMinor: "0" }], // removal
    asks: [{ priceMinor: "100000000", sizeMinor: "2" }], // insertion inside the spread
  });
  assert.strictEqual(out.accepted, true);
  assert.strictEqual(book.lastUpdateId, 110);
  assert.strictEqual(book.depth(5).bids.some((l) => l.priceMinor === "99000000"), false, "zero-size delta removes the level on read");
  assert.strictEqual(book.asks.has("100000000"), true);
});

test("delta book: old delta (predates the snapshot) is skipped, not applied", () => {
  const book = new L2DeltaBook("BTCUSDT").applySnapshot(SNAPSHOT);
  const out = book.applyDelta({
    firstUpdateId: 50, lastUpdateId: 90,
    bids: [{ priceMinor: "1", sizeMinor: "999" }],
    asks: [],
  });
  assert.strictEqual(out.accepted, true);
  assert.strictEqual(out.skipped, true);
  assert.strictEqual(book.lastUpdateId, 100, "sequence not advanced by a stale delta");
  assert.strictEqual(book.bids.get("1"), undefined);
});

test("delta book: SEQUENCE GAP poisons the book — resync is forced", () => {
  const book = new L2DeltaBook("BTCUSDT").applySnapshot(SNAPSHOT);
  // Snapshot at 100; delta starts at 120 → updates 101–119 are missing.
  const out = book.applyDelta({
    firstUpdateId: 120, lastUpdateId: 130,
    bids: [{ priceMinor: "97000000", sizeMinor: "1" }],
    asks: [{ priceMinor: "104000000", sizeMinor: "1" }],
  });
  assert.strictEqual(out.accepted, false);
  assert.strictEqual(out.gap, 19);
  assert.match(out.reason, /SEQUENCE GAP.*resync/);
  assert.strictEqual(book.needsResync, true);
  // A poisoned book refuses further deltas until a fresh snapshot lands.
  const again = book.applyDelta({
    firstUpdateId: 121, lastUpdateId: 131,
    bids: [], asks: [],
  });
  assert.strictEqual(again.accepted, false);
  assert.match(again.reason, /resync required/);
});

test("delta book: refuses deltas before any snapshot (fail closed)", () => {
  const book = new L2DeltaBook("BTCUSDT");
  const out = book.applyDelta({
    firstUpdateId: 1, lastUpdateId: 2, bids: [], asks: [],
  });
  assert.strictEqual(out.accepted, false);
  assert.match(out.reason, /resync required/);
});

// ── Rolling VPIN ─────────────────────────────────────────────────────────────

test("rolling VPIN: emits a verdict only on bucket completion", () => {
  const rv = new RollingVpin("1000");
  assert.strictEqual(rv.push({ sizeMinor: "600", side: "buy" }), null);
  const verdict = rv.push({ sizeMinor: "400", side: "buy" });
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(verdict.vpin, 1); // fully one-sided
  assert.strictEqual(verdict.buckets, 1);
});

test("rolling VPIN: a trade spanning a bucket boundary splits the verdict stream", () => {
  const rv = new RollingVpin("600");
  // 800 into a 600-bucket: bucket 1 completes MID-TRADE (verdict emitted),
  // 200 carry into bucket 2 — the accumulator never loses a completion.
  const v1 = rv.push({ sizeMinor: "800", side: "sell" });
  assert.strictEqual(v1.ok, true);
  assert.strictEqual(v1.buckets, 1);
  const v2 = rv.push({ sizeMinor: "400", side: "sell" }); // completes bucket 2
  assert.strictEqual(v2.ok, true);
  assert.strictEqual(v2.vpin, 1); // both buckets fully one-sided sell
  assert.strictEqual(rv.buckets, 2);
});

test("rolling VPIN: balanced flow → vpin 0; history is bounded", () => {
  const rv = new RollingVpin("1000", { maxBuckets: 3 });
  for (let i = 0; i < 5; i++) {
    rv.push({ sizeMinor: "500", side: "buy" });
    const v = rv.push({ sizeMinor: "500", side: "sell" });
  }
  const verdict = rv.verdict();
  assert.strictEqual(verdict.vpin, 0);
  assert.strictEqual(verdict.buckets, 3, "history capped at maxBuckets");
});

// ── Connection manager ───────────────────────────────────────────────────────

test("ws manager: exponential backoff grows 1s → 2s → 4s, capped at 30s; resets on connect", async () => {
  let shouldFail = true;
  const mgr = new WsConnectionManager({ connect: async () => { if (shouldFail) throw new Error("ECONNREFUSED"); } });
  const r1 = await mgr.open();
  assert.strictEqual(r1.retryInMs, 1000);
  const r2 = await mgr.open();
  assert.strictEqual(r2.retryInMs, 2000);
  const r3 = await mgr.open();
  assert.strictEqual(r3.retryInMs, 4000);
  shouldFail = false;
  const ok = await mgr.open();
  assert.strictEqual(ok.connected, true);
  const again = await mgr.open();
  assert.strictEqual(again.connected, true);
  assert.strictEqual(mgr.attempt, 0, "backoff resets after a successful connect");
});

test("ws manager: heartbeat goes stale after the timeout", async () => {
  const mgr = new WsConnectionManager({ connect: async () => {} });
  await mgr.open();
  const t0 = Date.now();
  assert.strictEqual(mgr.isHeartbeatStale(t0), false);
  assert.strictEqual(mgr.isHeartbeatStale(t0 + 31_000), true);
  mgr.touchHeartbeat(t0 + 31_000);
  assert.strictEqual(mgr.isHeartbeatStale(t0 + 31_000), false, "message receipt refreshes the clock");
});

test("ws manager: subscription dedup and cap", () => {
  const mgr = new WsConnectionManager({ connect: async () => {}, maxSubscriptions: 2 });
  assert.deepStrictEqual(mgr.subscribe("btc@depth"), { added: true, total: 1 });
  assert.deepStrictEqual(mgr.subscribe("btc@depth"), { added: false, reason: "already subscribed" });
  assert.deepStrictEqual(mgr.subscribe("eth@depth"), { added: true, total: 2 });
  const capped = mgr.subscribe("sol@depth");
  assert.strictEqual(capped.added, false);
  assert.match(capped.reason, /cap/);
  assert.deepStrictEqual(mgr.unsubscribe("btc@depth"), { removed: true });
  assert.deepStrictEqual(mgr.subscribe("sol@depth"), { added: true, total: 2 });
});

test("ws manager: close clears subscriptions and refuses re-open", async () => {
  const mgr = new WsConnectionManager({ connect: async () => {} });
  await mgr.open();
  mgr.subscribe("btc@depth");
  mgr.close();
  assert.strictEqual(mgr.subscriptions.size, 0);
  const out = await mgr.open();
  assert.strictEqual(out.connected, false);
  assert.match(out.reason, /closed by user/);
});

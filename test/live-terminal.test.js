"use strict";
// ---------------------------------------------------------------------------
// LIVE trade terminal (lib/liveTerminal.js) — the HFT-V2 §9 P0 surface.
//
// Contract under test (socket-injected, no network, no TTY):
//   1. Frame rendering is a pure function of state — identical states render
//      identical frames (auditable TUI).
//   2. l2Book ingestion: levels mapped to integer minors, best-first sorted,
//      sides truncated to the display depth.
//   3. FEED REGRESSION freezes the book (STALE) — an older push is never
//      rendered as current; a fresher push unfreezes.
//   4. Gauges: OBI + microprice computed over the ingested book; RollingVpin
//      accumulates trades and turns toxic on one-sided flow.
//   5. Cascade composite + GLFT quotes appear in state when inputs supplied.
//   6. PANIC default prints the kill-switch command; --allow-panic spawns the
//      real subprocess (stubbed here) — never a fabricated success.
//   7. Hotkey lifecycle: q resolves run(), listeners removed, raw mode
//      restored; the run loop clears its timer.
//   8. HL decimal→minor scaling is exact integer math.
// ---------------------------------------------------------------------------

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LiveTerminal, renderFrame, hlPriceToMinor, hlSizeToMinor } = require("../lib/liveTerminal");

function fakeStdin() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; };
  input.pause = () => {};
  input.resume = () => {};
  return input;
}

/** A terminal wired to a scripted in-memory socket: open() invokes the
 *  production handler flow without any network. */
function makeTerminal(opts = {}) {
  const t = new LiveTerminal({
    symbol: "BTC",
    columns: 100,
    connect: async () => {},
    ...opts,
  });
  t.ws = {
    sent: [],
    send: (s) => t.ws.sent.push(JSON.parse(s)),
    close: () => {},
  };
  t.handleOpen(); // socket open + channels subscribed — the connected state
  return t;
}

function bookPush(time, bids, asks) {
  return JSON.stringify({
    channel: "l2Book",
    data: { coin: "BTC", time, levels: [bids, asks] },
  });
}

const BIDS = [["64820.5", "2.5"], ["64820.0", "4.0"]];
const ASKS = [["64821.0", "1.5"], ["64821.5", "3.0"]];

test("frame rendering is a pure function of state (deterministic TUI)", () => {
  const t1 = makeTerminal();
  t1.handleMessage(bookPush(1700000000000, BIDS, ASKS));
  const a = t1.snapshotFrame();
  const b = t1.snapshotFrame();
  assert.equal(a, b);
  assert.ok(a.includes("BTC-PERP"));
  assert.ok(a.includes("LIVE · Hyperliquid WebSocket"));
});

test("l2Book ingestion: minor-mapped, best-first sorted, bounded depth", () => {
  const t = makeTerminal();
  t.handleMessage(bookPush(1700000000000, BIDS, ASKS));
  assert.ok(t.book, "book ingested");
  // best bid = highest, best ask = lowest
  assert.ok(BigInt(t.book.bids[0].priceMinor) > BigInt(t.book.bids[1].priceMinor));
  assert.ok(BigInt(t.book.asks[0].priceMinor) < BigInt(t.book.asks[1].priceMinor));
  // exact minor scaling: 64820.5 × 1e5
  assert.equal(t.book.bids[0].priceMinor, "6482050000");
  assert.equal(t.book.asks[0].sizeMinor, "150000");
  // display depth bound
  const manyBids = Array.from({ length: 30 }, (_, i) => [String(64800 - i), "1"]);
  t.handleMessage(bookPush(1700000000001, manyBids, ASKS));
  assert.ok(t.book.bids.length <= 15);
});

test("feed regression freezes the book (STALE); fresher push unfreezes", () => {
  const t = makeTerminal();
  t.handleMessage(bookPush(2000, BIDS, ASKS));
  assert.equal(t.stale, false);
  t.handleMessage(bookPush(1999, [["60000.0", "9"]], ASKS)); // older push
  assert.equal(t.stale, true);
  // the older push must NOT have replaced the book
  assert.equal(t.book.bids[0].priceMinor, "6482050000");
  const frame = t.snapshotFrame();
  assert.match(frame, /STALE/);
  t.handleMessage(bookPush(2001, BIDS, ASKS));
  assert.equal(t.stale, false);
});

test("malformed l2Book pushes are ignored, not partially applied", () => {
  const t = makeTerminal();
  t.handleMessage(bookPush(2000, BIDS, ASKS));
  const before = t.book.bids[0].priceMinor;
  t.handleMessage(JSON.stringify({ channel: "l2Book", data: { coin: "BTC" } })); // no levels
  t.handleMessage("not json");
  t.handleMessage(JSON.stringify({ channel: "pong" }));
  assert.equal(t.book.bids[0].priceMinor, before);
});

test("gauges: OBI ask-wall + microprice below mid + VPIN toxic on one-sided tape", () => {
  const t = makeTerminal({ vpinBucketVolume: "1000000" });
  // Ask-heavy book: OBI very negative, microprice below mid
  t.handleMessage(bookPush(2000, [["64820.0", "1"]], [["64821.0", "50"]]));
  assert.ok(t.gauges.obi, "OBI computed");
  assert.ok(t.gauges.obi.value < -0.9, `ask wall OBI ${t.gauges.obi.value}`);
  assert.equal(t.gauges.obi.signal, "ask wall");
  assert.ok(t.gauges.micro.driftedBelowMid);
  // One-sided sell tape → VPIN 1.0 toxic
  for (let i = 0; i < 3; i++) {
    t.handleMessage(JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "A", sz: "10" }] }));
  }
  assert.ok(t.gauges.vpin, "VPIN has completed buckets");
  assert.equal(t.gauges.vpin.vpin, 1);
  assert.equal(t.gauges.vpin.toxic, true);
  // 'A' (ask) trades count as sells in the VPIN accumulator
  const frame = t.snapshotFrame();
  assert.match(frame, /TOXIC/);
});

test("cascade composite and GLFT quotes appear when inputs are supplied", () => {
  const t = makeTerminal({
    fundingPer8h: 0.0006,
    gamma: 0.1,
    sigma: 0.02,
    kappa: 1.5,
    vpinBucketVolume: "1000000", // small bucket so the test tape completes buckets
  });
  t.handleMessage(bookPush(2000, [["64820.0", "1"]], [["64821.0", "50"]]));
  for (let i = 0; i < 3; i++) {
    t.handleMessage(JSON.stringify({ channel: "trades", data: [{ coin: "BTC", side: "A", sz: "10" }] }));
  }
  assert.ok(t.cascade, "cascade computed");
  assert.equal(t.cascade.regime, "CASCADE-LIKELY"); // spike + ask wall + toxic
  assert.ok(t.reservation, "GLFT quotes computed");
  assert.match(t.reservation.bidMinor, /^[0-9]+$/);
  assert.match(t.reservation.askMinor, /^[0-9]+$/);
  assert.ok(BigInt(t.reservation.bidMinor) < BigInt(t.reservation.askMinor));
  const frame = t.snapshotFrame();
  assert.match(frame, /CASCADE-LIKELY/);
  assert.match(frame, /no sniping edge exists/);
});

test("PANIC default prints the command; --allow-panic spawns the subprocess", () => {
  const t = makeTerminal();
  const r = t.panic();
  assert.equal(r.spawned, false);
  assert.match(r.cmd, /furlpay trading kill-switch --symbol BTC/);
  assert.ok(t.log.some((l) => l.includes("PANIC requested")));

  // allow-panic path with a stubbed spawn: patch child_process at require level
  const cp = require("child_process");
  const origSpawn = cp.spawn;
  let spawned = null;
  cp.spawn = (cmd, args) => {
    spawned = { cmd, args };
    return { on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } };
  };
  try {
    const t2 = makeTerminal({ allowPanic: true });
    const r2 = t2.panic();
    assert.equal(r2.spawned, true);
    assert.equal(spawned.args[2], "kill-switch");
    assert.equal(spawned.args[spawned.args.length - 1], "BTC");
  } finally {
    cp.spawn = origSpawn;
  }
});

test("hotkey lifecycle: q resolves run(), listeners detached, raw mode restored", async () => {
  const t = makeTerminal();
  // Never actually open a socket or a render interval leak: stub run internals.
  t.enterAlternateScreen = () => {};
  t.draw = () => {};
  const stdin = fakeStdin();
  const runPromise = (async () => {
    // mirror run()'s promise wiring without the interval
    return new Promise((resolve) => {
      t.resolveRun = resolve;
      t.attachKeys(stdin);
    });
  })();
  assert.equal(stdin.isRaw, true);
  assert.ok(stdin.listenerCount("data") > 0);
  stdin.emit("data", "q");
  const result = await runPromise;
  assert.equal(result.reason, "quit");
  assert.equal(stdin.listenerCount("data"), 0);
  assert.equal(stdin.isRaw, false);
});

test("HL scaling is exact integer math", () => {
  assert.equal(hlPriceToMinor("64821.5"), "6482150000");
  assert.equal(hlPriceToMinor("0.00001"), "1");
  assert.equal(hlSizeToMinor("12.34567"), "1234567");
  assert.equal(hlPriceToMinor("-1"), null);
  assert.equal(hlPriceToMinor("NaN"), null);
  assert.equal(hlSizeToMinor("-0.5"), null);
});

test("disconnected socket renders DISCONNECTED, never a fake book", () => {
  // Built WITHOUT the auto-open helper: connect null, never opened.
  const t = new LiveTerminal({ symbol: "BTC", columns: 100, connect: null });
  t.ws = { send: () => {}, close: () => {} };
  const frame = t.snapshotFrame();
  assert.match(frame, /DISCONNECTED/);
  assert.match(frame, /waiting for the first l2Book push/);
  t.handleClose();
  assert.equal(t.connected, false);
  assert.match(t.snapshotFrame(), /DISCONNECTED/);
});

test("construction fail-closes without a symbol", () => {
  assert.throws(() => new LiveTerminal({}), /symbol is required/);
});

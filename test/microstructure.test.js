"use strict";
// Microstructure analytics battery — hand-computed values, deterministic.
const test = require("node:test");
const assert = require("node:assert");
const { orderBookImbalance, microprice, vpin, avellanedaStoikov } = require("../lib/microstructure");

const BOOK = {
  bids: [
    { priceMinor: "99000000", sizeMinor: "1000000" },
    { priceMinor: "98000000", sizeMinor: "2000000" },
  ],
  asks: [
    { priceMinor: "101000000", sizeMinor: "3000000" },
    { priceMinor: "102000000", sizeMinor: "1000000" },
  ],
};

test("OBI: balanced book is 0; ask-heavy book is negative; bounded [-1, 1]", () => {
  const balanced = orderBookImbalance({
    bids: [{ priceMinor: "1", sizeMinor: "100" }],
    asks: [{ priceMinor: "2", sizeMinor: "100" }],
  }, { levels: 1 });
  assert.strictEqual(balanced.obi, 0);
  const askHeavy = orderBookImbalance({
    bids: [{ priceMinor: "1", sizeMinor: "10" }],
    asks: [{ priceMinor: "2", sizeMinor: "90" }],
  }, { levels: 1 });
  assert.strictEqual(askHeavy.obi, -0.8);
  assert.ok(askHeavy.obi >= -1 && askHeavy.obi <= 1);
});

test("OBI: exponential weighting makes the top level dominate deeper levels", () => {
  // λ=0.5: w0=1, w1≈0.6065. A 1M ask wall at L1 outweighs a 2M bid wall at L2.
  const out = orderBookImbalance({
    bids: [{ priceMinor: "1", sizeMinor: "2000000" }],
    asks: [{ priceMinor: "2", sizeMinor: "1000000" }],
  }, { levels: 2, lambda: 0.5 });
  // bid: 2e6·1 = 2e6; ask: 1e6·1 = 1e6 → OBI positive
  assert.ok(out.obi > 0);
  const out2 = orderBookImbalance({
    bids: [{ priceMinor: "1", sizeMinor: "1000000" }],
    asks: [{ priceMinor: "2", sizeMinor: "2000000" }],
  }, { levels: 2, lambda: 0.5 });
  assert.ok(out2.obi < 0);
});

test("OBI refuses an empty side and throws on negative sizes (fail closed)", () => {
  assert.strictEqual(orderBookImbalance({ bids: [], asks: BOOK.asks }).ok, false);
  assert.throws(() => orderBookImbalance({
    bids: [{ priceMinor: "1", sizeMinor: "-5" }],
    asks: [{ priceMinor: "2", sizeMinor: "1" }],
  }), /not a valid non-negative number/);
});

test("microprice tilts toward the heavier side and never crosses the book", () => {
  // bids 99 @ 2M, asks 101 @ 1M → micro = (99·1 + 101·2)/3 = 100.333…
  const out = microprice({
    bids: [{ priceMinor: "99000000", sizeMinor: "2000000" }],
    asks: [{ priceMinor: "101000000", sizeMinor: "1000000" }],
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.microMinor, "100333333"); // floor of 100333333.33
  assert.ok(BigInt(out.microMinor) >= BigInt("99000000"));
  assert.ok(BigInt(out.microMinor) <= BigInt("101000000"));
  // Symmetric book → micro = mid exactly.
  const sym = microprice({
    bids: [{ priceMinor: "99000000", sizeMinor: "1000000" }],
    asks: [{ priceMinor: "101000000", sizeMinor: "1000000" }],
  });
  assert.strictEqual(sym.microMinor, "100000000");
});

test("microprice refuses malformed top-of-book", () => {
  assert.strictEqual(microprice({ bids: [], asks: BOOK.asks }).ok, false);
  assert.strictEqual(microprice({
    bids: [{ priceMinor: "abc", sizeMinor: "1" }],
    asks: [{ priceMinor: "2", sizeMinor: "1" }],
  }).ok, false);
});

test("VPIN: perfectly balanced flow → 0; one-sided flow → 1", () => {
  const balanced = [];
  for (let i = 0; i < 4; i++) {
    balanced.push({ sizeMinor: "500", side: "buy" });
    balanced.push({ sizeMinor: "500", side: "sell" });
  }
  const out = vpin(balanced, "1000");
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.vpin, 0);
  const toxic = [];
  for (let i = 0; i < 4; i++) toxic.push({ sizeMinor: "1000", side: "sell" });
  const out2 = vpin(toxic, "1000");
  assert.strictEqual(out2.vpin, 1);
  assert.strictEqual(out2.toxic, true);
});

test("VPIN: trade spanning a bucket boundary splits exactly across buckets", () => {
  // Bucket 600: one 1000 buy splits 600/400 → bucket1 imbalanced 600,
  // bucket2 needs more volume… only 1 complete bucket → excluded partial.
  const out = vpin([{ sizeMinor: "1000", side: "buy" }], "600");
  // 1000 fills bucket 1 (600) completely + leaves a 400 partial → 1 complete bucket, fully one-sided.
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.buckets, 1);
  assert.strictEqual(out.vpin, 1);
  assert.strictEqual(out.excludedPartialBucket, true);
});

test("VPIN: partial trailing bucket is excluded per Easley et al.", () => {
  const out = vpin([
    { sizeMinor: "1000", side: "buy" },
    { sizeMinor: "1000", side: "sell" },
    { sizeMinor: "500", side: "buy" }, // trailing partial
  ], "1000");
  assert.strictEqual(out.buckets, 2);
  assert.strictEqual(out.excludedPartialBucket, true);
  // Each complete bucket fully one-sided → VPIN 1.
  assert.strictEqual(out.vpin, 1);
});

test("VPIN: toxic threshold is configurable", () => {
  const half = vpin([
    { sizeMinor: "500", side: "buy" }, { sizeMinor: "500", side: "sell" },
    { sizeMinor: "1000", side: "buy" }, { sizeMinor: "1000", side: "buy" },
  ], "1000", { toxicThreshold: 0.4 });
  // buckets: [500 buy/500 sell] → 0; [1000 buy] → 1000; [1000 buy] → 1000 → 2000/3000
  assert.strictEqual(half.vpin, 0.6666);
  assert.strictEqual(half.toxic, true);
});

test("Avellaneda-Stoikov: neutral inventory quotes symmetrically around mid", () => {
  const out = avellanedaStoikov({
    midMinor: "100000000", inventory: 0, riskAversion: 0.1, sigma: 0.02, kappa: 1.5, timeLeft: 1,
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.inventorySkew, "neutral");
  // reservation = mid exactly; quotes symmetric.
  const mid = 100000000n;
  assert.strictEqual(BigInt(out.reservationMinor), mid);
  assert.ok(BigInt(out.askMinor) > mid);
  assert.ok(BigInt(out.bidMinor) < mid);
});

test("Avellaneda-Stoikov: a net-short desk's reservation price RISES (cover bias)", () => {
  const neutral = avellanedaStoikov({ midMinor: "100000000", inventory: 0, riskAversion: 0.1, sigma: 0.02, kappa: 1.5, timeLeft: 1 });
  const short = avellanedaStoikov({ midMinor: "100000000", inventory: -100, riskAversion: 0.1, sigma: 0.5, kappa: 1.5, timeLeft: 1 });
  assert.strictEqual(short.inventorySkew, "short-skew (reservation raised)");
  assert.ok(BigInt(short.reservationMinor) > BigInt(neutral.reservationMinor));
  // A long inventory lowers it.
  const long = avellanedaStoikov({ midMinor: "100000000", inventory: 100, riskAversion: 0.1, sigma: 0.5, kappa: 1.5, timeLeft: 1 });
  assert.strictEqual(long.inventorySkew, "long-skew (reservation lowered)");
  assert.ok(BigInt(long.reservationMinor) < BigInt(neutral.reservationMinor));
});

test("Avellaneda-Stoikov refuses non-positive risk parameters (fail closed)", () => {
  for (const bad of [{ riskAversion: 0 }, { sigma: -0.1 }, { kappa: 0 }, { timeLeft: 0 }]) {
    assert.strictEqual(
      avellanedaStoikov({ midMinor: "100000000", inventory: 0, riskAversion: 0.1, sigma: 0.02, kappa: 1.5, timeLeft: 1, ...bad }).ok,
      false
    );
  }
});

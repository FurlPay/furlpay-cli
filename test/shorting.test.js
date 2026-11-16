"use strict";
// Bitcoin shorting surface battery — mechanism honesty + signal-gate logic.
const test = require("node:test");
const assert = require("node:assert");
const { MECHANISMS, listMechanisms, shortSignalCheck } = require("../lib/shorting");
const shortCommands = require("../lib/shortCommands");

test("mechanisms: Hyperliquid perp short is LIVE and implemented; Binance futures is NOT", () => {
  const hl = MECHANISMS.find((m) => m.id === "hyperliquid-perp");
  assert.strictEqual(hl.implemented, true);
  assert.match(hl.status, /LIVE/);
  assert.match(hl.how, /hyperliquid trade --symbol BTC --side sell/);
  const bn = MECHANISMS.find((m) => m.id === "binance-usdm-futures-short");
  assert.strictEqual(bn.implemented, false);
  assert.match(bn.status, /NOT IMPLEMENTED/);
  // No fabricated venue: CME is N/A.
  assert.strictEqual(MECHANISMS.find((m) => m.id === "cme-futures").implemented, false);
});

const BOOK_SHORT_READY = {
  bids: [{ priceMinor: "99000000", sizeMinor: "10" }],
  asks: [{ priceMinor: "101000000", sizeMinor: "90" }], // ask wall
};

test("signal gate: ask wall + microprice-below-mid passes all short-entry signals", () => {
  const out = shortSignalCheck({ book: BOOK_SHORT_READY });
  assert.strictEqual(out.ok, true);
  assert.match(out.verdict, /SHORT-READY/);
  const obiSig = out.signals.find((s) => s.signal === "order-book-imbalance");
  assert.strictEqual(obiSig.passed, true);
  const mpSig = out.signals.find((s) => s.signal === "microprice-below-mid");
  assert.strictEqual(mpSig.passed, true);
  assert.strictEqual(out.analysisOnly, true);
});

test("signal gate: balanced book fails the short-readiness check", () => {
  const out = shortSignalCheck({
    book: {
      bids: [{ priceMinor: "99000000", sizeMinor: "50" }],
      asks: [{ priceMinor: "101000000", sizeMinor: "50" }],
    },
  });
  assert.strictEqual(out.ok, true);
  assert.match(out.verdict, /NOT-READY/);
});

test("signal gate: toxic tape blocks the short entry (squeeze risk)", () => {
  const toxicTape = [];
  for (let i = 0; i < 3; i++) toxicTape.push({ sizeMinor: "1000", side: "sell" });
  // Book is short-ready but the tape is one-sided sell = informed dump already happened.
  const out = shortSignalCheck({ book: BOOK_SHORT_READY, tape: toxicTape, bucketVolume: "1000" });
  assert.strictEqual(out.ok, true);
  const vpSig = out.signals.find((s) => s.signal === "vpin-not-toxic");
  assert.strictEqual(vpSig.passed, false, "one-sided selling = toxic, short must wait");
  assert.match(out.verdict, /NOT-READY/);
});

test("signal gate: non-toxic tape alongside a short-ready book passes", () => {
  const cleanTape = [
    { sizeMinor: "500", side: "buy" }, { sizeMinor: "500", side: "sell" },
    { sizeMinor: "1000", side: "sell" },
  ];
  const out = shortSignalCheck({ book: BOOK_SHORT_READY, tape: cleanTape, bucketVolume: "1000" });
  assert.strictEqual(out.ok, true);
  assert.match(out.verdict, /SHORT-READY/);
});

test("signal gate: funding dimension joins the composite (HFT-V2 §5/§9)", () => {
  // Calm funding → new signal row passes; verdict unaffected.
  const calm = shortSignalCheck({ book: BOOK_SHORT_READY, fundingPer8h: 0.0001 });
  assert.strictEqual(calm.ok, true);
  const calmRow = calm.signals.find((s) => s.signal === "funding-not-in-cascade");
  assert.strictEqual(calmRow.passed, true);
  assert.match(calm.verdict, /SHORT-READY/);
  assert.match(calm.disclaimer, /no sniping edge|undiscounted/);

  // Spike funding (≥5bp/8h) + the ask wall already present → CASCADE-LIKELY,
  // the funding row fails, and the verdict flips to NOT-READY (squeeze risk).
  const spike = shortSignalCheck({ book: BOOK_SHORT_READY, fundingPer8h: 0.0006 });
  assert.strictEqual(spike.ok, true);
  const spikeRow = spike.signals.find((s) => s.signal === "funding-not-in-cascade");
  assert.strictEqual(spikeRow.passed, false);
  assert.strictEqual(spike.cascadeRegime.regime, "CASCADE-LIKELY");
  assert.match(spike.verdict, /NOT-READY/);
  assert.ok(spike.reasons.some((r) => r.includes("WARNING: funding spike")));
});

test("signal gate: missing book fails closed", () => {
  assert.strictEqual(shortSignalCheck({}).ok, false);
  assert.match(shortSignalCheck({}).reason, /book/);
});

test("every signal result carries the analysis-only disclaimer and execution pointer", () => {
  const out = shortSignalCheck({ book: BOOK_SHORT_READY });
  assert.strictEqual(out.analysisOnly, true);
  assert.match(out.execution, /hyperliquid trade/);
  assert.match(out.execution, /risk engine/);
  assert.match(out.disclaimer, /liquidation risk/);
});

test("CLI: default usage lists mechanisms and signal; execution pointer is the live path", () => {
  const buf = [];
  const orig = console.error;
  console.error = (m) => buf.push(m);
  try {
    const code = shortCommands.run({ subcommand: undefined, args: [], flags: {} });
    assert.strictEqual(code, 1);
    const text = buf.join("\n");
    assert.match(text, /mechanisms/);
    assert.match(text, /hyperliquid trade --symbol BTC --side sell/);
  } finally {
    console.error = orig;
  }
});

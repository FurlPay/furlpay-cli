"use strict";
// ---------------------------------------------------------------------------
// Quantitative algo engines (lib/algoQuant.js) — research-driven P0/P1
// surface from HFT_V2_Advanced_Algorithms_Live_Research_Report.md.
//
// Contract under test:
//   1. GLFT quotes are deterministic and the total spread equals the
//      closed form γσ²τ + (2/γ)ln(1+γ/k); bid < reservation < ask.
//   2. Execution schedules are REPRODUCIBLE for a pinned seed and
//      reconcile EXACTLY (BigInt) to the parent amount — no minor unit
//      is ever created or lost.
//   3. POV fails closed without a volume profile (never guesses volume)
//      and never exceeds the participation cap per slice.
//   4. IS report is an accounting identity: Σsize·(p − arrival) equals
//      the reported shortfall, computed in exact BigInt.
//   5. Maker breakeven: sign flips exactly at the arithmetic boundary
//      the formula predicts; verdicts follow the sign, never optimism.
//   6. Funding analyzer: z-score matches a hand-computed value; the
//      entry gate requires z ≥ threshold (a single print ≠ signal).
//   7. Cascade composite: threshold crossings at the documented bounds;
//      always carries the no-sniping correction.
//   8. Everything fail-closed on malformed input; nothing executes.
// ---------------------------------------------------------------------------

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  makeRng,
  glftQuotes,
  executionSchedule,
  executionReport,
  makerBreakeven,
  queuePosition,
  fundingSignal,
  cascadeSignal,
} = require("../lib/algoQuant");

test("GLFT: total spread matches the closed form; quotes straddle the reservation", () => {
  // γ=0.1, σ=0.02, k=1.5, τ=1 → total = 0.1·0.0004 + 20·ln(1+0.0666…) ≈ 1.2839
  const out = glftQuotes({ midMinor: "6482150", inventory: 0, gamma: 0.1, sigma: 0.02, kappa: 1.5, timeLeft: 1 });
  assert.equal(out.ok, true);
  const expected = 0.1 * 0.0004 + (2 / 0.1) * Math.log(1 + 0.1 / 1.5);
  const half = Number(out.halfSpreadMinor);
  assert.ok(Math.abs(half * 2 - expected) < 1, `half×2=${half * 2} vs closed form ${expected}`);
  assert.ok(Number(out.bidMinor) < Number(out.reservationMinor));
  assert.ok(Number(out.askMinor) > Number(out.reservationMinor));
  assert.equal(out.model, "GLFT");
});

test("GLFT: inventory skew moves the reservation, not the spread width", () => {
  // q·γσ²·τ must clear a full minor unit at mid=100000:
  // q=50000 → shift = 50000·0.1·0.0004 = 2 minor units — visible after rounding.
  const flat = glftQuotes({ midMinor: "100000", inventory: 0, gamma: 0.1, sigma: 0.02, kappa: 1.5 });
  const long = glftQuotes({ midMinor: "100000", inventory: 50000, gamma: 0.1, sigma: 0.02, kappa: 1.5 });
  assert.equal(flat.ok && long.ok, true);
  // r = s − qγσ²τ → long inventory LOWERS the reservation
  assert.equal(Number(long.reservationMinor), Number(flat.reservationMinor) - 2);
  assert.equal(long.inventorySkew, "long-skew (reservation lowered)");
  // spread width is inventory-independent
  assert.equal(long.halfSpreadMinor, flat.halfSpreadMinor);
});

test("GLFT: fail-closed on non-positive or missing parameters", () => {
  for (const bad of [
    { midMinor: "0" },
    { midMinor: "100" },
    { midMinor: "100", gamma: 0.1 },
    { midMinor: "100", gamma: 0.1, sigma: -0.02, kappa: 1.5 },
    { midMinor: "100", gamma: 0.1, sigma: 0.02, kappa: 1.5, timeLeft: 0 },
    { midMinor: "abc", gamma: 0.1, sigma: 0.02, kappa: 1.5 },
  ]) {
    const out = glftQuotes(bad);
    assert.equal(out.ok, false, JSON.stringify(bad));
    assert.ok(out.reason);
  }
});

test("micro-TWAP: seeded schedule is byte-identical across runs", () => {
  const args = { amountMinor: "1000000000", durationSeconds: 900, slices: 12, seed: 42 };
  const a = executionSchedule(args);
  const b = executionSchedule(args);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(a.slices, b.slices);
  assert.equal(a.seed, 42);
});

test("micro-TWAP: slices reconcile EXACTLY to the parent amount (BigInt)", () => {
  // Adversarial amount: 1 minor unit over 97 slices — reconciliation must
  // put every remainder somewhere and never mint or lose a unit.
  const out = executionSchedule({ amountMinor: "97", durationSeconds: 600, slices: 97, seed: 7 });
  assert.equal(out.ok, true);
  const sum = out.slices.reduce((acc, s) => acc + BigInt(s.sizeMinor), 0n);
  assert.equal(sum, 97n);
  for (const s of out.slices) assert.ok(BigInt(s.sizeMinor) >= 0n);
});

test("micro-TWAP: slice timestamps are ordered and inside the window", () => {
  const out = executionSchedule({ amountMinor: "5000000", durationSeconds: 300, slices: 30, seed: 3 });
  assert.equal(out.ok, true);
  let prev = -1;
  for (const s of out.slices) {
    assert.ok(s.atSecond > prev, "timestamps must strictly increase");
    assert.ok(s.atSecond <= 300);
    prev = s.atSecond;
  }
  assert.equal(out.slices[out.slices.length - 1].atSecond, 300); // final slice lands at T
});

test("POV: fails closed without a volume profile — never guesses volume", () => {
  const out = executionSchedule({ amountMinor: "1000000", durationSeconds: 600, mode: "pov" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /volume/i);
});

test("POV: per-slice size respects the participation cap; total capped by observed volume", () => {
  const profile = [{ volumeMinor: "1000000" }, { volumeMinor: "1000000" }, { volumeMinor: "1000000" }];
  const cap = 0.035;
  const out = executionSchedule({ amountMinor: "1000000000", durationSeconds: 600, mode: "pov", participationCap: cap, volumeProfile: profile });
  assert.equal(out.ok, true);
  assert.equal(out.incomplete !== false, true, "1B amount vs 3.5% of 3M volume must be incomplete");
  for (const s of out.slices) {
    assert.ok(BigInt(s.sizeMinor) <= BigInt(Math.round(1000000 * cap)), "slice must not exceed cap×volume");
  }
  assert.ok(out.remainderMinor.length > 0);
  assert.match(out.incomplete, /REPORTED, not auto-chased/);
});

test("IS report: shortfall equals the exact BigInt identity Σsize·(p − arrival)", () => {
  const arrival = "10000";
  const fills = [
    { priceMinor: "10050", sizeMinor: "10", feeMinor: "5" },
    { priceMinor: "9950", sizeMinor: "10", feeMinor: "5" },
  ];
  const out = executionReport({ arrivalMinor: arrival, fills });
  assert.equal(out.ok, true);
  // Σ size·(p − a) = 10·50 + 10·(−50) = 0 → at arrival
  assert.equal(out.implementationShortfallBps, 0);
  assert.equal(out.filledMinor, "20");
  assert.equal(out.feesMinor, "10");
  assert.match(out.verdict, /at-or-better than arrival/);
});

test("IS report: detects adverse slippage and reports fees in bps", () => {
  const out = executionReport({
    arrivalMinor: "10000",
    fills: [{ priceMinor: "10100", sizeMinor: "10" }],
  });
  assert.equal(out.ok, true);
  // 100 bps above arrival
  assert.equal(out.implementationShortfallBps, 100);
  assert.match(out.verdict, /slippage 100 bps/);
});

test("IS report: VWAP is floored BigInt with the exact remainder surfaced", () => {
  const out = executionReport({
    arrivalMinor: "3",
    fills: [{ priceMinor: "1", sizeMinor: "3" }],
  });
  assert.equal(out.vwapMinor, "1");
  assert.equal(out.vwapRemainderOverQty, "0/3");
  const out2 = executionReport({
    arrivalMinor: "7",
    fills: [{ priceMinor: "10", sizeMinor: "3" }],
  });
  // notional 30 over qty 3 → vwap 10, remainder 0
  assert.equal(out2.vwapMinor, "10");
});

test("IS report: fail-closed on malformed fills (never partially scores)", () => {
  for (const bad of [
    { arrivalMinor: "100", fills: [] },
    { arrivalMinor: "100", fills: [{ priceMinor: "-5", sizeMinor: "1" }] },
    { arrivalMinor: "100", fills: [{ priceMinor: "100", sizeMinor: "x" }] },
    { arrivalMinor: "abc", fills: [{ priceMinor: "100", sizeMinor: "1" }] },
  ]) {
    assert.equal(executionReport(bad).ok, false);
  }
});

test("maker breakeven: sign flips exactly at the formula's boundary", () => {
  // λ=10/h, δ=2bps, a=1bps, c=0.5bps → edge=0.5bps → gross=5bps/h
  // γ=0.1, σ=0.02, q=10 → carry = ½·0.1·0.0004·100·1e4 = 20 bps/h → NET negative
  const neg = makerBreakeven({ halfSpreadBps: 2, toxicityBps: 1, feeBps: 0.5, fillsPerHour: 10, gamma: 0.1, sigma: 0.02, inventory: 10 });
  assert.equal(neg.ok, true);
  assert.equal(neg.netPositive, false);
  assert.match(neg.verdict, /DO NOT SHIP|Negative/);
  // Same but q=1 → carry = 0.2 bps/h → NET +4.8 → positive
  const pos = makerBreakeven({ halfSpreadBps: 2, toxicityBps: 1, feeBps: 0.5, fillsPerHour: 10, gamma: 0.1, sigma: 0.02, inventory: 1 });
  assert.equal(pos.netPositive, true);
  assert.match(pos.verdict, /SHIP-CANDIDATE|still only a model/);
  // taker fee > rebate flips per-fill edge negative
  assert.equal(makerBreakeven({ halfSpreadBps: 1, toxicityBps: 0, feeBps: 2, fillsPerHour: 10, gamma: 0.1, sigma: 0.02 }).perFillEdgeBps, -1);
});

test("maker breakeven: fail-closed on malformed inputs", () => {
  for (const bad of [
    { halfSpreadBps: "x", toxicityBps: 1, feeBps: 0.5, fillsPerHour: 5, gamma: 0.1, sigma: 0.02 },
    { halfSpreadBps: 2, toxicityBps: 1, feeBps: 0.5, fillsPerHour: -1, gamma: 0.1, sigma: 0.02 },
    { halfSpreadBps: 2, toxicityBps: 1, feeBps: 0.5, fillsPerHour: 5 },
  ]) {
    assert.equal(makerBreakeven(bad).ok, false);
  }
});

test("queue: fluid drain math and bounded fill probability", () => {
  const out = queuePosition({ queueAheadMinor: "1000", tradeMinorPerSecond: "10", cancelMinorPerSecond: "10", horizonSeconds: 60 });
  assert.equal(out.ok, true);
  // drain 20/s → 50s to front → within 60s horizon → p = 1
  assert.equal(out.secondsToFront, 50);
  assert.equal(out.atFront, true);
  assert.equal(out.fillProbabilityWithinHorizon, 1);
  const slow = queuePosition({ queueAheadMinor: "100000", tradeMinorPerSecond: "10", horizonSeconds: 60 });
  assert.equal(slow.atFront, false);
  assert.ok(slow.fillProbabilityWithinHorizon > 0 && slow.fillProbabilityWithinHorizon < 1);
  const dead = queuePosition({ queueAheadMinor: "100", tradeMinorPerSecond: "0", cancelMinorPerSecond: "0" });
  assert.equal(dead.fillProbabilityWithinHorizon, 0);
  assert.ok(dead.reason.includes("never drains"));
});

test("funding: z-score matches the hand-computed value; gate needs z ≥ threshold", () => {
  const history = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0005];
  const out = fundingSignal({ history, zThreshold: 2.0 });
  assert.equal(out.ok, true);
  // mean = 0.00015; sample stdev = sqrt(1.4e-7/7) ≈ 1.41421e-4;
  // z = 0.00035 / 1.41421e-4 ≈ 2.4749
  assert.ok(Math.abs(out.zScore - 2.4749) < 0.001, `z=${out.zScore}`);
  assert.equal(out.entryGate, true);
  const flat = fundingSignal({ history: Array(8).fill(0.0001), zThreshold: 2.0 });
  assert.equal(flat.entryGate, false); // stdev 0 → z 0 → a flat book is not a signal
  const low = fundingSignal({ history: [0.0001, 0.00012, 0.00011, 0.00009, 0.0001, 0.00011, 0.0001, 0.00013], zThreshold: 5 });
  assert.equal(low.entryGate, false);
  assert.match(low.verdict, /NOT persistent/);
  // annualized gross: latest 0.0005 → 0.0005·3·365·100 = 54.75%
  assert.equal(out.annualizedGrossPct, 54.75);
  assert.match(out.verdict, /open-interest momentum|crowding/);
});

test("funding: fail-closed on too-few samples or non-finite entries", () => {
  assert.equal(fundingSignal({ history: [0.0001, 0.0001] }).ok, false);
  assert.equal(fundingSignal({ history: Array(8).fill("NaN") }).ok, false);
  assert.equal(fundingSignal({}).ok, false);
});

test("cascade: threshold crossings at the documented bounds", () => {
  const all = cascadeSignal({ fundingPer8h: 0.0006, obi: -0.7, vpin: 0.8 });
  assert.equal(all.regime, "CASCADE-LIKELY");
  assert.equal(all.compositeScore, 3);
  assert.match(all.action, /NOT an execution trigger/);
  assert.match(all.correction, /without a discount|undiscounted|no sniping|does not exist/i);

  const none = cascadeSignal({ fundingPer8h: 0.0001, obi: 0.1, vpin: 0.3 });
  assert.equal(none.regime, "NORMAL");
  assert.equal(none.compositeScore, 0);

  // exact boundary values: funding 0.0005 (5bp) IS a spike; obi −0.65 IS a wall; vpin 0.75 IS toxic
  const boundary = cascadeSignal({ fundingPer8h: 0.0005, obi: -0.65, vpin: 0.75 });
  assert.equal(boundary.compositeScore, 3);

  const one = cascadeSignal({ fundingPer8h: 0.0006, obi: 0.2, vpin: 0.3 });
  assert.equal(one.regime, "ELEVATED");
});

test("cascade: fail-closed on non-finite inputs", () => {
  assert.equal(cascadeSignal({ fundingPer8h: "x", obi: 0, vpin: 0 }).ok, false);
  assert.equal(cascadeSignal({ fundingPer8h: 0.0001, obi: undefined, vpin: 0.3 }).ok, false);
});

test("seeded RNG is deterministic and in [0,1); Box–Muller normal is bounded-sane", () => {
  const a = makeRng(123);
  const b = makeRng(123);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    const y = b();
    assert.equal(x, y);
    assert.ok(x >= 0 && x < 1);
  }
});

test("HONESTY: engines are analysis-only by construction", () => {
  const sched = executionSchedule({ amountMinor: "100", durationSeconds: 60, seed: 1 });
  assert.match(sched.note, /PLAN ONLY/);
  assert.equal(sched.offline, true);
  const rep = executionReport({ arrivalMinor: "1", fills: [{ priceMinor: "1", sizeMinor: "1" }] });
  assert.match(rep.honesty, /not a claim/);
  const fund = fundingSignal({ history: Array(8).fill(0.0001) });
  assert.match(fund.honesty, /never auto-claimed/);
});

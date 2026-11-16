"use strict";

// ---------------------------------------------------------------------------
// Quantitative algorithm engines — PURE, deterministic, OFFLINE.
//
// Implements the P0/P1 analysis surface of the HFT research volumes
// (HFT_V2_Advanced_Algorithms_Live_Research_Report.md §4/§7/§9):
//   glftQuotes        — Guéant–Lehalle–Fernandez-Tapia closed-form quotes
//   executionSchedule — adaptive micro-TWAP / POV slicer (Poisson jitter,
//                       participation cap, micro-price pegging)
//   executionReport   — Implementation-Shortfall / VWAP / fee accounting
//   makerBreakeven    — the §7.1 objective: λ·(δ − a − c) − inventory carry
//   queuePosition     — fluid queue-ahead/front-of-queue estimator
//   fundingSignal     — funding z-score + honest annualized carry math
//   cascadeSignal     — funding-spike + OBI-flip + VPIN-toxicity composite
//
// HONESTY SCOPE (honesty matrix): these are ANALYSIS engines over
// caller-supplied data. Nothing here places, signs or broadcasts an order;
// nothing claims a live feed or a validated live edge. All prices/amounts are
// integer-minor strings; all rates/ratios are dimensionless Numbers.
// ---------------------------------------------------------------------------

/** Deterministic seeded RNG (mulberry32) — Poisson slice jitter must be
 *  reproducible: a schedule you cannot reproduce is a schedule you cannot
 *  audit. Seeded from crypto when the caller does not pin one. */
function makeRng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller from a uniform RNG. */
function normal(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// 1. GLFT quoting (Guéant–Lehalle–Fernandez-Tapia closed form)
//
// Total spread (ask δa + bid δb around the reservation price):
//     δa + δb = γ·σ²·(T−t) + (2/γ)·ln(1 + γ/k)
// Reservation price with inventory q:
//     r = s − q·γ·σ²·(T−t)
// Quotes: bid = r − half, ask = r + half. Fill intensity at distance δ:
//     p(δ) = e^(−k·δ)          (exponential fill decay, GLFT assumption)
//
// Difference from the Avellaneda-Stoikov implementation in
// lib/microstructure.js: GLFT adds the ½·γ·σ²·(T−t) term to each side's
// edge (the AS engine quotes a pure (1/γ)ln(1+γ/k) edge) — the volatility
// component of the spread the AS variant omits.
// ---------------------------------------------------------------------------
function glftQuotes(opts) {
  const mid = parsePositiveMinor(opts.midMinor);
  if (mid === null) return fail("midMinor must be a positive integer-minor string");
  const { gamma, sigma, kappa, timeLeft } = numericOpts(opts, ["gamma", "sigma", "kappa"], { timeLeft: 1 });
  if (gamma === null) return fail("gamma, sigma and kappa must be positive finite numbers");
  if (timeLeft <= 0) return fail("timeLeft must be positive");

  const variance = sigma * sigma;
  const totalSpread = gamma * variance * timeLeft + (2 / gamma) * Math.log(1 + gamma / kappa);
  const half = totalSpread / 2;
  const reservation = Number(mid) - opts.inventory * gamma * variance * timeLeft;
  const bid = Math.max(1, Math.round(reservation - half));
  const ask = Math.max(bid + 1, Math.round(reservation + half));
  return {
    ok: true,
    model: "GLFT",
    reservationMinor: String(Math.round(reservation)),
    bidMinor: String(bid),
    askMinor: String(ask),
    halfSpreadMinor: String(Math.round(half)),
    totalSpreadMinor: String(Math.round(totalSpread)),
    /** Fill probability at the quoted distance, GLFT intensity decay. */
    fillProbabilityBid: Number(Math.exp(-kappa * half).toFixed(6)),
    fillProbabilityAsk: Number(Math.exp(-kappa * half).toFixed(6)),
    inventorySkew: opts.inventory < 0 ? "short-skew (reservation raised)" : opts.inventory > 0 ? "long-skew (reservation lowered)" : "neutral",
    formula: "δa+δb = γσ²τ + (2/γ)ln(1+γ/k); r = s − qγσ²τ (GLFT closed form)",
  };
}

// ---------------------------------------------------------------------------
// 2. Adaptive execution scheduler (micro-TWAP / POV)
//
// micro-twap: N slices at Exp(λ) inter-arrival times (Poisson process —
//   deterministic given the seed), each pegged to the supplied reference
//   price, summing EXACTLY to the parent amount.
// pov: participation-of-volume — each slice = cap × the supplied rolling
//   volume for that minute; fails closed without a volume profile.
// The schedule is a PLAN, not an execution: nothing is sent anywhere.
// ---------------------------------------------------------------------------
function executionSchedule(opts) {
  const amount = parsePositiveMinor(opts.amountMinor);
  if (amount === null) return fail("amountMinor must be a positive integer-minor string");
  const duration = Number(opts.durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return fail("durationSeconds must be positive");
  const mode = String(opts.mode || "micro-twap").toLowerCase();
  const seed = Number.isInteger(opts.seed) ? opts.seed : require("crypto").randomInt(1, 2 ** 31);
  const rng = makeRng(seed);

  if (mode === "micro-twap") {
    const slices = Math.max(1, Math.floor(Number(opts.slices ?? 20)));
    if (!Number.isInteger(slices) || slices <= 0) return fail("slices must be a positive integer");
    // Exponential(λ=N/duration) inter-arrivals, clipped into the window.
    const lambda = slices / duration;
    const times = [];
    let t = 0;
    while (times.length < slices - 1) {
      t += -Math.log(1 - rng()) / lambda; // inverse-CDF exponential
      if (t >= duration) break;
      times.push(t);
    }
    while (times.length < slices - 1) times.push(duration * ((times.length + 1) / slices)); // degenerate backfill
    times.push(duration);
    // Randomized sizes (uniform jitter ±40%), then exact reconciliation so
    // the slices sum to the parent amount to the last minor unit.
    const weights = times.map(() => 0.6 + 0.8 * rng());
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const raw = weights.map((w) => (amount * BigInt(Math.round(w * 1e6))) / BigInt(Math.round(weightSum * 1e6)));
    let assigned = raw.reduce((a, b) => a + b, 0n);
    raw[raw.length - 1] += amount - assigned; // exact reconciliation
    return {
      ok: true,
      mode: "micro-twap",
      offline: true,
      seed,
      slices: times.map((at, i) => ({
        atSecond: Number(at.toFixed(3)),
        sizeMinor: raw[i].toString(),
        limitMinor: opts.pegMinor !== undefined ? String(opts.pegMinor) : null,
      })),
      totalMinor: amount.toString(),
      durationSeconds: duration,
      note: "PLAN ONLY — Poisson-jittered micro-TWAP over the supplied window; nothing is placed, signed or broadcast.",
    };
  }

  if (mode === "pov") {
    const cap = Number(opts.participationCap ?? 0.035);
    if (!Number.isFinite(cap) || cap <= 0 || cap > 1) return fail("participationCap must be in (0, 1]");
    const profile = opts.volumeProfile;
    if (!Array.isArray(profile) || profile.length === 0) {
      return fail("POV requires --volume <file.json>: a per-minute volume profile [{ volumeMinor }]. Without observed volume, participation cannot be computed — refusing to guess.");
    }
    const slices = [];
    let allocated = 0n;
    for (let i = 0; i < profile.length; i++) {
      const v = parsePositiveMinor(String(profile[i].volumeMinor));
      if (v === null) return fail(`volumeProfile[${i}].volumeMinor must be a positive integer-minor string`);
      const take = (v * BigInt(Math.round(cap * 1e6))) / 1_000_000n;
      if (take <= 0n) continue;
      const room = amount - allocated;
      const size = take > room ? room : take;
      if (size <= 0n) break;
      slices.push({ atSecond: (i + 1) * 60, sizeMinor: size.toString() });
      allocated += size;
      if (allocated === amount) break;
    }
    const incomplete = allocated < amount;
    return {
      ok: true,
      mode: "pov",
      offline: true,
      participationCap: cap,
      slices,
      totalMinor: allocated.toString(),
      remainderMinor: (amount - allocated).toString(),
      incomplete: incomplete
        ? `Observed volume only supports ${allocated}/${amount} at cap ${cap}. The remainder is REPORTED, not auto-chased — chasing the tail is how POV orders become impact events.`
        : false,
      note: "PLAN ONLY — participation-of-volume over the supplied profile; nothing is placed, signed or broadcast.",
    };
  }

  return fail(`unknown mode '${mode}' (micro-twap | pov)`);
}

// ---------------------------------------------------------------------------
// 3. Execution report — Implementation Shortfall vs arrival price.
//
// IS is the only honest scorecard for an execution algo: it is measured
// against the decision price, not against a mid the executor can pick.
// ---------------------------------------------------------------------------
function executionReport(opts) {
  const arrival = parsePositiveMinor(opts.arrivalMinor);
  if (arrival === null) return fail("arrivalMinor must be a positive integer-minor string");
  if (!Array.isArray(opts.fills) || opts.fills.length === 0) return fail("fills must be a non-empty array");
  let qty = 0n;
  let notional = 0n; // Σ price·size in minor² — exact BigInt, no float drift
  let fees = 0n;
  const parsed = [];
  for (let i = 0; i < opts.fills.length; i++) {
    const price = parsePositiveMinor(String(opts.fills[i].priceMinor));
    const size = parsePositiveMinor(String(opts.fills[i].sizeMinor));
    if (price === null || size === null) return fail(`fills[${i}] needs positive integer-minor priceMinor and sizeMinor`);
    const fee = opts.fills[i].feeMinor !== undefined ? parseNonNegativeMinor(String(opts.fills[i].feeMinor)) : 0n;
    if (fee === null) return fail(`fills[${i}].feeMinor must be a non-negative integer-minor string`);
    qty += size;
    notional += price * size;
    fees += fee;
    parsed.push({ priceMinor: price, sizeMinor: size, feeMinor: fee });
  }
  const vwap = notional / qty; // floor — report exact division parts too
  const remainder = notional - vwap * qty;
  // IS in minor units per unit quantity: Σ size·(price − arrival) = notional − arrival·qty
  const shortfallMinor = notional - arrival * qty;
  const isPerUnit = Number(shortfallMinor) / Number(qty);
  const isBps = (isPerUnit / Number(arrival)) * 10_000;
  return {
    ok: true,
    filledMinor: qty.toString(),
    vwapMinor: vwap.toString(),
    vwapRemainderOverQty: `${remainder}/${qty}`,
    arrivalMinor: arrival.toString(),
    implementationShortfallPerUnitMinor: Number.isInteger(isPerUnit) ? String(isPerUnit) : Number(isPerUnit.toFixed(6)),
    implementationShortfallBps: Number(isBps.toFixed(4)),
    feesMinor: fees.toString(),
    feesBps: Number(((Number(fees) / Number(notional)) * 10_000).toFixed(4)),
    verdict: isBps <= 0 ? "at-or-better than arrival" : `slippage ${Number(isBps.toFixed(2))} bps vs arrival`,
    honesty: "IS is computed against YOUR supplied arrival price over YOUR supplied fills — an accounting identity, not a claim about an algo's live edge.",
  };
}

// ---------------------------------------------------------------------------
// 4. Maker breakeven — the §7.1 objective function as a decision tool.
//
//   E[PnL/hour] = λ · (δ − a − c_fee) − inventoryCarryPerHour
//   inventory carry = ½·γ·σ²·q²  (per hour, on the positioned notional)
// Ship verdicts only from the arithmetic, never from optimism. The
// fill-probability adjustment (arXiv:2502.18625) enters through λ itself:
// the caller supplies the fill rate OBSERVED at that spread — raising δ
// lowers λ, and the tool refuses to pretend otherwise.
// ---------------------------------------------------------------------------
function makerBreakeven(opts) {
  const delta = bps(opts.halfSpreadBps);
  const adverse = bps(opts.toxicityBps);
  const fee = bps(opts.feeBps);
  const lambda = Number(opts.fillsPerHour);
  if (delta === null || adverse === null || fee === null) return fail("halfSpreadBps, toxicityBps and feeBps must be finite numbers (fee may be negative for rebates)");
  if (!Number.isFinite(lambda) || lambda < 0) return fail("fillsPerHour must be a non-negative finite number");
  const perFillEdgeBps = delta - adverse - fee;
  const { gamma, sigma } = numericOpts(opts, ["gamma", "sigma"], {});
  if (gamma === null) return fail("gamma and sigma must be positive finite numbers for the inventory carry term");
  const q = Number(opts.inventory ?? 0);
  const horizonHours = Number(opts.horizonHours ?? 1);
  if (!Number.isFinite(q) || !Number.isFinite(horizonHours) || horizonHours <= 0) return fail("inventory must be finite and horizonHours positive");
  const carryPerHourBps = 0.5 * gamma * sigma * sigma * q * q * 10_000;
  const grossBps = lambda * perFillEdgeBps;
  const netBps = grossBps - carryPerHourBps;
  return {
    ok: true,
    perFillEdgeBps: Number(perFillEdgeBps.toFixed(4)),
    grossCaptureBpsPerHour: Number(grossBps.toFixed(4)),
    inventoryCarryBpsPerHour: Number(carryPerHourBps.toFixed(4)),
    netBpsPerHour: Number(netBps.toFixed(4)),
    netPositive: netBps > 0,
    verdict:
      netBps > 0
        ? `Arithmetic is positive at these parameters (${Number(netBps.toFixed(2))} bps/hour) — still only a model: adverse selection is regime-dependent and λ is YOUR observed fill rate.`
        : `Negative at these parameters (${Number(netBps.toFixed(2))} bps/hour) — widen the spread (and accept lower λ), reduce toxicity exposure, or do not ship the maker.`,
    formula: "E[PnL/h] = λ(δ − a − c) − ½γσ²q²·10⁴ bps  (HFT-V2 report §7.1)",
  };
}

// ---------------------------------------------------------------------------
// 5. Queue position — fluid front-of-queue estimator.
//
// Honest scope: a transparent FLUID approximation (queue consumed by trades
// at the level plus cancels ahead of you), not Moallemi's full queue-value
// model. Useful for ALO quoting sanity: if the queue cannot clear within
// your horizon, the quote is dead inventory.
// ---------------------------------------------------------------------------
function queuePosition(opts) {
  const ahead = parseNonNegativeMinor(opts.queueAheadMinor);
  if (ahead === null) return fail("queueAheadMinor must be a non-negative integer-minor string");
  const tradeRate = Number(opts.tradeMinorPerSecond);
  const cancelRate = Number(opts.cancelMinorPerSecond ?? 0);
  if (!Number.isFinite(tradeRate) || tradeRate < 0 || !Number.isFinite(cancelRate) || cancelRate < 0) {
    return fail("tradeMinorPerSecond and cancelMinorPerSecond must be non-negative numbers");
  }
  const horizon = Number(opts.horizonSeconds ?? 60);
  if (!Number.isFinite(horizon) || horizon <= 0) return fail("horizonSeconds must be positive");
  const drain = tradeRate + cancelRate;
  if (ahead === 0n) {
    return { ok: true, atFront: true, secondsToFront: 0, fillProbabilityWithinHorizon: 1, model: "fluid (trades + cancels drain the queue)" };
  }
  if (drain <= 0) {
    return { ok: true, atFront: false, secondsToFront: null, fillProbabilityWithinHorizon: 0, model: "fluid (trades + cancels drain the queue)", reason: "no trade or cancel flow supplied — the queue never drains in this model" };
  }
  const secondsToFront = Number(ahead) / drain;
  const p = Math.max(0, Math.min(1, horizon / secondsToFront));
  return {
    ok: true,
    atFront: secondsToFront <= horizon,
    secondsToFront: Number(secondsToFront.toFixed(3)),
    fillProbabilityWithinHorizon: Number(p.toFixed(4)),
    model: "fluid (trades + cancels drain the queue) — approximation, not the Moallemi queue-value model",
  };
}

// ---------------------------------------------------------------------------
// 6. Funding analyzer — z-score + honest carry arithmetic.
//
// The report's §7.2 discipline: carry = f̄·3·365 − fees(both legs) − drift;
// entry needs BOTH a high z-score AND OI-confirmation the caller asserts.
// We compute the math; the crowding/confirmation judgment stays with the
// operator and is never auto-claimed.
// ---------------------------------------------------------------------------
function fundingSignal(opts) {
  const history = opts.history;
  if (!Array.isArray(history) || history.length < 8) return fail("history must be an array of at least 8 per-8h funding rates (fractions, e.g. 0.0001 = 1bp)");
  const rates = history.map(Number);
  if (rates.some((r) => !Number.isFinite(r))) return fail("history entries must be finite numbers");
  const n = rates.length;
  const mean = rates.reduce((a, b) => a + b, 0) / n;
  const variance = rates.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1);
  const stdev = Math.sqrt(variance);
  const latest = rates[n - 1];
  const z = stdev > 0 ? (latest - mean) / stdev : 0;
  const threshold = Number(opts.zThreshold ?? 2.0);
  if (!Number.isFinite(threshold)) return fail("zThreshold must be finite");
  const roundTripFeeBps = Number(opts.roundTripFeeBps ?? 8);
  if (!Number.isFinite(roundTripFeeBps) || roundTripFeeBps < 0) return fail("roundTripFeeBps must be non-negative");
  const annualizedGrossPct = latest * 3 * 365 * 100; // per-8h → annual
  const dailyBps = latest * 3 * 10_000;
  const entryGate = z >= threshold;
  return {
    ok: true,
    samples: n,
    meanPer8h: Number(mean.toFixed(8)),
    stdevPer8h: Number(stdev.toFixed(8)),
    latestPer8h: latest,
    zScore: Number(z.toFixed(4)),
    dailyBps: Number(dailyBps.toFixed(2)),
    annualizedGrossPct: Number(annualizedGrossPct.toFixed(3)),
    roundTripFeeBps,
    entryGate,
    verdict: entryGate
      ? `z ${Number(z.toFixed(2))} ≥ ${threshold}: persistence gate PASSED — confirm open-interest momentum before sizing (crowding compresses f̄; both legs pay fees; basis drift forces rebalances).`
      : `z ${Number(z.toFixed(2))} < ${threshold}: funding is NOT persistent vs its own history — a single high print is not an entry signal.`,
    honesty: "Entry gate is arithmetic on YOUR supplied history. OI confirmation, crowding and liquidation buffer sizing are operator judgments — never auto-claimed.",
  };
}

// ---------------------------------------------------------------------------
// 7. Cascade composite — liquidation-cascade regime flag (ANALYSIS ONLY).
//
// Per HFT-V2 §5: liquidations route to the book WITHOUT discount on
// Hyperliquid; there is no sniping edge. What analysis CAN do is flag the
// cascade regime (funding spike + ask-wall OBI + toxic VPIN) so a maker
// reduces exposure. This composite is never wired to execution.
// ---------------------------------------------------------------------------
function cascadeSignal(opts) {
  const funding = Number(opts.fundingPer8h);
  const obi = Number(opts.obi);
  const vpinValue = Number(opts.vpin);
  for (const [name, val] of [["fundingPer8h", funding], ["obi", obi], ["vpin", vpinValue]]) {
    if (!Number.isFinite(val)) return fail(`${name} must be a finite number`);
  }
  const fundingSpike = funding >= 0.0005; // ≥5 bps per 8h — cascade fuel
  const askWall = obi <= -0.65;
  const toxic = vpinValue >= 0.75;
  const flags = { fundingSpike, askWall, toxic };
  const score = Number(flags.fundingSpike) + Number(flags.askWall) + Number(flags.toxic);
  return {
    ok: true,
    ...flags,
    compositeScore: score,
    regime: score >= 2 ? "CASCADE-LIKELY" : score === 1 ? "ELEVATED" : "NORMAL",
    action: score >= 2 ? "Reduce maker exposure / pull resting bids — analysis output, NOT an execution trigger." : "No cascade signature at these inputs.",
    correction: "Liquidation 'sniping' at a discount does not exist on Hyperliquid — liquidations hit the book undiscounted, and failed ones go to the HLP backstop (HFT-V2 §5).",
    honesty: "ANALYSIS ONLY over supplied inputs; never wired to any execution path.",
  };
}

// -- shared strict parsers ---------------------------------------------------

function fail(reason) {
  return { ok: false, reason };
}

const MINOR = /^[0-9]+$/;

function parsePositiveMinor(v) {
  if (typeof v !== "string" || !MINOR.test(v) || v.trim() !== v) return null;
  try {
    const b = BigInt(v);
    return b > 0n ? b : null;
  } catch {
    return null;
  }
}

function parseNonNegativeMinor(v) {
  if (typeof v !== "string" || !MINOR.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/** Validate positive-finite numeric opts; returns {field: value|null} with defaults applied.
 *  Caller-supplied values for defaulted keys are respected — a caller passing
 *  timeLeft: 0 must be FAILED on, never silently upgraded to the default. */
function numericOpts(opts, required, defaults) {
  const out = { ...defaults };
  let bad = false;
  for (const name of required) {
    const v = Number(opts[name]);
    if (!Number.isFinite(v) || v <= 0) bad = true;
    out[name] = v;
  }
  for (const k of Object.keys(defaults)) {
    if (opts[k] === undefined) {
      out[k] = Number(defaults[k]);
    } else {
      const v = Number(opts[k]);
      if (!Number.isFinite(v)) bad = true;
      out[k] = v;
    }
  }
  if (bad) return { gamma: null };
  return out;
}

function bps(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  makeRng,
  normal,
  glftQuotes,
  executionSchedule,
  executionReport,
  makerBreakeven,
  queuePosition,
  fundingSignal,
  cascadeSignal,
};

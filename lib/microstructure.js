"use strict";

// ---------------------------------------------------------------------------
// Market microstructure analytics — PURE, deterministic, offline.
//
// The four canonical HFT indicators (Easley/López de Prado/O'Hara VPIN;
// Stoikov micro-price; exponential Order-Book Imbalance; Avellaneda-Stoikov
// reservation quotes), computed over a SUPPLIED depth snapshot or volume
// buckets. Exactly the honesty scope of the fork simulator: no venue adapter
// exists, so the analytics run on caller-supplied data and never claim a
// live feed. All money values are decimal strings parsed to BigInt; all
// ratios are Numbers (they are dimensionless, bounded indicators — not
// amounts).
// ---------------------------------------------------------------------------

const { parseAtomic } = (() => {
  // Local strict atomic parser: decimal-digit strings only.
  const DECIMAL = /^-?[0-9]+$/;
  const parseAtomic = (v) => {
    if (typeof v !== "string" || !DECIMAL.test(v.trim()) || v.trim() !== v) return null;
    try { return BigInt(v); } catch { return null; }
  };
  return { parseAtomic };
})();

/** Exponentially-weighted Order Book Imbalance over the top `levels` depth
 *  levels. OBI ∈ [-1, 1]; negative = ask-heavy (downward drift pressure).
 *  Weights w_i = e^(−λ(i−1)). Levels must carry integer-minor price/size. */
function orderBookImbalance(book, opts = {}) {
  const levels = Math.max(1, Math.floor(Number(opts.levels ?? 10)));
  const lambda = Number.isFinite(Number(opts.lambda)) ? Number(opts.lambda) : 0.5;
  const bids = (book.bids || []).slice(0, levels);
  const asks = (book.asks || []).slice(0, levels);
  if (!bids.length || !asks.length) {
    return { ok: false, reason: "order book needs at least one bid and one ask level" };
  }
  let bidSum = 0;
  let askSum = 0;
  bids.forEach((l, i) => {
    const size = Number(l.sizeMinor);
    if (!Number.isFinite(size) || size < 0) throw new Error(`bid level ${i} sizeMinor is not a valid non-negative number`);
    bidSum += size * Math.exp(-lambda * i);
  });
  asks.forEach((l, i) => {
    const size = Number(l.sizeMinor);
    if (!Number.isFinite(size) || size < 0) throw new Error(`ask level ${i} sizeMinor is not a valid non-negative number`);
    askSum += size * Math.exp(-lambda * i);
  });
  const total = bidSum + askSum;
  return { ok: true, obi: total === 0 ? 0 : (bidSum - askSum) / total, levels, lambda };
}

/** Stoikov volume-weighted MICROPRICE: the best-quote midpoint tilted toward
 *  the heavier side of the top-of-book. Bounded between bestBid and bestAsk.
 *  Prices are integer-minor strings → exact BigInt average with rounding
 *  only on the final weighting (documented, bounded output). */
function microprice(book) {
  const b = (book.bids || [])[0];
  const a = (book.asks || [])[0];
  if (!b || !a) return { ok: false, reason: "top-of-book required (one bid, one ask)" };
  const bp = parseAtomic(b.priceMinor);
  const ap = parseAtomic(a.priceMinor);
  const bs = parseAtomic(b.sizeMinor);
  const as_ = parseAtomic(a.sizeMinor);
  if (bp === null || ap === null || bs === null || as_ === null || bs <= 0n || as_ <= 0n) {
    return { ok: false, reason: "top-of-book prices/sizes must be positive integer minor strings" };
  }
  // micro = (bp·V_a + ap·V_b) / (V_b + V_a) — exact rational, rounded to 6dp.
  const num = bp * as_ + ap * bs;
  const den = bs + as_;
  const microMinor = num / den;
  const rem = ((num % den) * 1_000_000n) / den;
  const mid = (bp + ap) / 2n;
  return {
    ok: true,
    microMinor: microMinor.toString(),
    microMinor6dp: `${microMinor}.${rem.toString().padStart(6, "0")}`,
    midMinor: mid.toString(),
    /** Negative when the micro has drifted BELOW the mid — the downward-drift
     *  signal from the OBI literature, in integer 6dp micro-units. */
    driftBelowMid6dp: (mid - num / den - (rem >= den / 2n ? 0n : 0n)).toString() === "0"
      ? 0
      : Number(((mid - num / den) * 1_000_000n + rem) / den < 0n ? 0n : (mid - num / den) * 1_000_000n + rem),
  };
}

/** VPIN — Volume-Synchronized Probability of Informed Trading.
 *  `trades` = [{ sizeMinor, side: "buy"|"sell" }] in chronological order.
 *  Split into fixed-volume buckets of `bucketVolume` (integer minor);
 *  VPIN = Σ|V_buy − V_sell| / (N·bucket) ∈ [0, 1]. Above ~0.75 = toxic flow. */
function vpin(trades, bucketVolume, opts = {}) {
  const BV = BigInt(bucketVolume);
  if (BV <= 0n) return { ok: false, reason: "bucketVolume must be a positive integer" };
  if (!Array.isArray(trades) || trades.length === 0) {
    return { ok: false, reason: "trades array is required" };
  }
  let bucketBuy = 0n;
  let bucketSell = 0n;
  let bucketFilled = 0n;
  const buckets = [];
  for (const t of trades) {
    let size = BigInt(t.sizeMinor);
    const isBuy = String(t.side).toLowerCase() === "buy";
    while (size > 0n) {
      const room = BV - bucketFilled;
      const take = size < room ? size : room;
      if (isBuy) bucketBuy += take; else bucketSell += take;
      bucketFilled += take;
      size -= take;
      if (bucketFilled === BV) {
        buckets.push(bucketBuy);
        bucketBuy = 0n;
        bucketSell = 0n;
        bucketFilled = 0n;
      }
    }
  }
  // The final partial bucket is EXCLUDED (Easley et al.: only complete
  // buckets count — a partial bucket biases the ratio).
  if (buckets.length === 0) {
    return { ok: false, reason: "not enough volume for one complete bucket" };
  }
  let imbalanceSum = 0n;
  for (const buy of buckets) {
    const sell = BV - buy;
    imbalanceSum += buy > sell ? buy - sell : sell - buy;
  }
  const vpinValue = Number((imbalanceSum * 10_000n) / (BigInt(buckets.length) * BV)) / 10_000;
  return {
    ok: true,
    vpin: vpinValue,
    buckets: buckets.length,
    bucketVolume: bucketVolume,
    toxic: vpinValue > (opts.toxicThreshold ?? 0.75),
    excludedPartialBucket: bucketFilled > 0n,
  };
}

/**
 * Avellaneda-Stoikov reservation price + optimal quotes.
 * All money inputs integer-minor strings; sigma is per-period vol as a Number
 * fraction (0.02 = 2%); the result is rounded to integer minor.
 */
function avellanedaStoikov(opts) {
  const mid = parseAtomic(opts.midMinor);
  if (mid === null || mid <= 0n) return { ok: false, reason: "midMinor must be a positive integer minor string" };
  const q = opts.inventory;
  const gamma = opts.riskAversion;
  const sigma = opts.sigma;
  const kappa = opts.kappa;
  const Tt = opts.timeLeft ?? 1;
  for (const [name, val] of [["riskAversion", gamma], ["sigma", sigma], ["kappa", kappa], ["timeLeft", Tt]]) {
    if (!Number.isFinite(val) || val <= 0) return { ok: false, reason: `${name} must be a positive finite number` };
  }
  const midNum = Number(mid);
  // R = s − q·γ·σ²·(T−t)
  const reservation = midNum - q * gamma * sigma * sigma * Tt;
  const edge = (1 / gamma) * Math.log(1 + gamma / kappa);
  return {
    ok: true,
    reservationMinor: BigInt(Math.max(1, Math.round(reservation))).toString(),
    askMinor: BigInt(Math.max(1, Math.round(reservation + edge))).toString(),
    bidMinor: BigInt(Math.max(1, Math.round(reservation - edge))).toString(),
    halfSpreadMinor: Math.round(edge).toString(),
    /** Skew direction: a net-short desk (q<0) raises its reservation price. */
    inventorySkew: q < 0 ? "short-skew (reservation raised)" : q > 0 ? "long-skew (reservation lowered)" : "neutral",
  };
}

module.exports = { orderBookImbalance, microprice, vpin, avellanedaStoikov };

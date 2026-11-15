"use strict";

// ---------------------------------------------------------------------------
// Fork slippage simulator — PURE math over a SUPPLIED order book.
//
// HONEST SCOPE. This simulates fills against an order book the CALLER
// supplies (a venue snapshot file, or later, a live adapter's response). It
// does NOT fetch market data — no venue adapter exists in this build — so
// `furlpay fork market` remains NOT_IMPLEMENTED. What the simulator proves is
// arithmetic: given these levels, this quantity fills at this average price
// with this much slippage, or REFUSES when the book is too thin or the
// slippage cap would be breached.
//
// ALL PRICES/SIZES ARE DECIMAL STRINGS and all math is done via BigInt on
// integer-minor representations supplied by the caller (the book file carries
// `priceMinor`/`sizeMinor` integers — no floats anywhere in the fill math).
// ---------------------------------------------------------------------------

/**
 * Simulate a market fill.
 *
 * @param {object} book - { bids: [{priceMinor, sizeMinor}], asks: [...] }
 *   Levels sorted best-first by the CALLER (bids high→low, asks low→high);
 *   the simulator sorts defensively anyway — deterministic output.
 * @param {object} opts
 *   side: "buy" | "sell"            — buy consumes asks, sell consumes bids
 *   amountMinor: BigInt-able string — base-asset quantity to fill
 *   maxSlippageBps: int             — refusal threshold vs best price
 * @returns fill schedule, average price (string minor), slippage bps,
 *   and { refused, reason } when depth/cap make the order inadvisable.
 */
function simulateFill(book, opts) {
  const side = String(opts.side || "").toLowerCase();
  if (side !== "buy" && side !== "sell") {
    return { refused: true, reason: `side must be "buy" or "sell", got ${String(opts.side)}` };
  }
  const levels = (side === "buy" ? book.asks : book.bids) || [];
  if (!Array.isArray(levels) || levels.length === 0) {
    return { refused: true, reason: "order book has no levels on the requested side" };
  }

  let remaining = BigInt(opts.amountMinor);
  if (remaining <= 0n) {
    return { refused: true, reason: "amountMinor must be a positive integer" };
  }

  // Defensive best-first sort: asks ascending, bids descending. Deterministic
  // regardless of the caller's file ordering.
  const sorted = levels
    .map((l) => ({ price: BigInt(l.priceMinor), size: BigInt(l.sizeMinor) }))
    .sort((a, b) => (side === "buy" ? (a.price < b.price ? -1 : 1) : a.price > b.price ? -1 : 1));

  const best = sorted[0].price;
  const fills = [];
  let notional = 0n; // price × size, in minor² — caller converts
  let filled = 0n;
  let worst = best;

  for (const level of sorted) {
    if (remaining <= 0n) break;
    const take = level.size < remaining ? level.size : remaining;
    fills.push({ priceMinor: level.price.toString(), sizeMinor: take.toString() });
    notional += level.price * take;
    filled += take;
    remaining -= take;
    worst = level.price;
  }

  if (remaining > 0n) {
    return {
      refused: true,
      reason:
        `insufficient depth: book fills only ${filled.toString()} of ${opts.amountMinor} ` +
        `base units on the ${side} side`,
      measured: { fillable: filled.toString(), requested: opts.amountMinor },
    };
  }

  // Slippage vs the best level, in integer bps: (worst/best − 1) × 10000,
  // computed in BigInt — no float on the decision path.
  const slippageBps = Number(((worst - best) * 10_000n) / best);
  const avgPriceMinor = (notional / filled).toString();

  if (opts.maxSlippageBps !== undefined && slippageBps > opts.maxSlippageBps) {
    return {
      refused: true,
      reason:
        `slippage ${slippageBps}bps exceeds the cap ${opts.maxSlippageBps}bps — ` +
        `this fill would walk ${fills.length} level(s) to ${worst.toString()}`,
      measured: { slippageBps, avgPriceMinor, worstPriceMinor: worst.toString() },
    };
  }

  return {
    refused: false,
    side,
    fills,
    levelsConsumed: fills.length,
    filledMinor: filled.toString(),
    avgPriceMinor,
    worstPriceMinor: worst.toString(),
    bestPriceMinor: best.toString(),
    slippageBps,
  };
}

module.exports = { simulateFill };

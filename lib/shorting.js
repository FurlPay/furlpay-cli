"use strict";

// ---------------------------------------------------------------------------
// `furlpay short …` — Bitcoin shorting surface.
//
// THE HONEST ANSWER to "can this CLI short Bitcoin": YES, on the Hyperliquid
// rail — a short IS a signed EIP-712 order with side "sell" through the
// exchange endpoint, and `furlpay hyperliquid trade --symbol BTC --side sell`
// already does exactly that (LIVE, risk-engine enforced). This module adds
// the missing SHORT-SPECIFIC intelligence on top:
//
//   1. Mechanism registry: which shorting venues/mechanisms exist, with
//      honest status (Hyperliquid perps LIVE; Binance futures NOT
//      IMPLEMENTED; CME/Others N/A for this CLI).
//   2. Signal-gated short readiness: the four microstructure indicators
//      (OBI, microprice drift, VPIN) evaluated against short-entry criteria
//      over SUPPLIED data — read-only research, never an execution trigger.
//      Per the architectural axiom: analytics never bypass the risk engine;
//      execution remains `hyperliquid trade --side sell` behind the mandate
//      gate and kill-switch.
// ---------------------------------------------------------------------------

const MECHANISMS = [
  {
    id: "hyperliquid-perp",
    name: "Hyperliquid Perpetual Short",
    status: "LIVE (signed)",
    how: "furlpay hyperliquid trade --symbol BTC --side sell --size <n> --leverage <n>",
    notes:
      "Real EIP-712 signed order on Hyperliquid L1. Funding-rate mechanics " +
      "apply (positive funding pays shorts). Pre-trade risk engine enforced; " +
      "requires HYPERLIQUID_PRIVATE_KEY/ETH_PRIVATE_KEY.",
    implemented: true,
  },
  {
    id: "binance-usdm-futures-short",
    name: "Binance USD-M Futures Short",
    status: "NOT IMPLEMENTED",
    how: "—",
    notes:
      "The Binance adapter implements spot only in this build; futures " +
      "(including reduce-only/short orders) are declared false in the " +
      "capability registry. No partial implementation exists.",
    implemented: false,
  },
  {
    id: "cme-futures",
    name: "CME Cash-Settled Futures / Basis Trade",
    status: "N/A (no institutional venue access)",
    how: "—",
    notes:
      "Regulated-venue shorting (5 BTC contracts, BRR settlement) is outside " +
      "this CLI's scope — no CME integration exists or is planned here.",
    implemented: false,
  },
];

function listMechanisms() {
  return MECHANISMS.slice();
}

/**
 * Short-signal readiness check over SUPPLIED data — read-only research.
 *
 * Combines the three entry-criteria signals from the shorting literature:
 *   OBI strongly negative (ask wall), microprice drifted below mid,
 *   VPIN below toxicity (shorting into YOUR OWN toxic dump is how you get
 *   squeezed — high VPIN means informed sellers already front-ran you).
 * This is ANALYSIS, not execution. It returns a verdict + the exact live
 * command; the risk engine and kill-switch still gate any real order.
 */
function shortSignalCheck(input) {
  const { orderBookImbalance, microprice, vpin } = require("./microstructure");
  const reasons = [];
  const signals = [];

  if (input.book) {
    const obi = orderBookImbalance(input.book, { levels: input.levels, lambda: input.lambda });
    if (!obi.ok) return { ok: false, reason: `OBI: ${obi.reason}` };
    const downward = obi.obi < (input.obiThreshold ?? -0.65);
    signals.push({ signal: "order-book-imbalance", value: Number(obi.obi.toFixed(6)), passed: downward, threshold: input.obiThreshold ?? -0.65 });
    if (downward) reasons.push("ask-wall imbalance");
    const mp = microprice(input.book);
    if (!mp.ok) return { ok: false, reason: `microprice: ${mp.reason}` };
    const drifted = BigInt(mp.microMinor) < BigInt(mp.midMinor);
    signals.push({ signal: "microprice-below-mid", microMinor: mp.microMinor, midMinor: mp.midMinor, passed: drifted });
    if (drifted) reasons.push("microprice drifted below mid");
  } else {
    return { ok: false, reason: "book (depth snapshot) is required for the signal check" };
  }

  if (input.tape && input.bucketVolume) {
    const vp = vpin(input.tape, input.bucketVolume, { toxicThreshold: input.toxicThreshold ?? 0.75 });
    if (!vp.ok) return { ok: false, reason: `VPIN: ${vp.reason}` };
    // Short entry wants NON-toxic conditions: VPIN above threshold means
    // informed sellers already dumped — entering here risks a squeeze.
    const clean = !vp.toxic;
    signals.push({ signal: "vpin-not-toxic", value: vp.vpin, threshold: input.toxicThreshold ?? 0.75, passed: clean });
    if (clean) reasons.push("order-flow not toxic");
  }

  // HFT-V2 §5/§9: optional cascade composite — when the caller supplies the
  // funding rate, the funding-spike dimension joins the regime read. A
  // spike + ask-wall + toxic tape is a CASCADE-LIKELY regime: shorting into
  // it is squeeze risk, so the row warns instead of cheering the ask wall.
  let cascade = null;
  if (input.fundingPer8h !== undefined) {
    const obiValue = signals.find((s) => s.signal === "order-book-imbalance");
    const vpinRow = signals.find((s) => s.signal === "vpin-not-toxic");
    const cs = require("./algoQuant").cascadeSignal({
      fundingPer8h: input.fundingPer8h,
      obi: obiValue ? obiValue.value : 0,
      vpin: vpinRow ? vpinRow.value : 0,
    });
    if (!cs.ok) return { ok: false, reason: `cascade: ${cs.reason}` };
    cascade = { regime: cs.regime, score: cs.compositeScore, fundingSpike: cs.fundingSpike };
    signals.push({
      signal: "funding-not-in-cascade",
      value: input.fundingPer8h,
      passed: !cs.fundingSpike,
      threshold: 0.0005,
      note: cs.regime === "CASCADE-LIKELY"
        ? `cascade regime ${cs.regime} (${cs.score}/3) — shorting into a liquidation cascade is squeeze risk`
        : `cascade regime ${cs.regime}`,
    });
    if (!cs.fundingSpike) reasons.push("funding not in cascade spike");
    else reasons.push("WARNING: funding spike — cascade regime");
  }

  const passed = signals.every((s) => s.passed);
  return {
    ok: true,
    verdict: passed ? "SHORT-READY (all signals passed)" : "NOT-READY",
    ...(cascade ? { cascadeRegime: cascade } : {}),
    signals,
    reasons,
    analysisOnly: true,
    execution:
      "read-only analysis — execution remains 'furlpay hyperliquid trade " +
      "--symbol BTC --side sell' behind the risk engine, mandate gate and kill-switch",
    disclaimer:
      "ANALYSIS ONLY over supplied data — not financial advice, not a live " +
      "market view, and not an execution trigger. Shorting carries liquidation " +
      "risk; the risk engine (limits, leverage caps, kill-switch) gates every " +
      "real order. Liquidations route to the book undiscounted on Hyperliquid — " +
      "there is no sniping edge (HFT-V2 §5).",
  };
}

module.exports = { MECHANISMS, listMechanisms, shortSignalCheck };

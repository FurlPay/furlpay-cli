"use strict";

// ---------------------------------------------------------------------------
// `furlpay algo …` — the research-driven analysis surface (HFT-V2 §9 P0/P1).
//
// HONESTY: every subcommand is OFFLINE over caller-supplied data. Schedules
// are plans, not orders; verdicts are arithmetic, not live-edge claims. See
// HFT_V2_Advanced_Algorithms_Live_Research_Report.md — every formula here
// cites its section. When the live WebSocket engine ships, it feeds these
// same pure engines in lib/algoQuant.js.
// ---------------------------------------------------------------------------

const fs = require("fs");
const {
  glftQuotes,
  executionSchedule,
  executionReport,
  makerBreakeven,
  queuePosition,
  fundingSignal,
  cascadeSignal,
} = require("./algoQuant");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    return null;
  }
}

function emit(asJson, out, humanLines) {
  if (asJson) {
    console.log(JSON.stringify({ offline: true, ...out }, null, 2));
  } else {
    for (const line of humanLines) console.log(line);
  }
  return out.ok ? 0 : 1;
}

function failClosed(asJson, out) {
  if (asJson) {
    console.log(JSON.stringify({ offline: true, ...out }, null, 2));
  } else {
    console.error("FAIL-CLOSED:", out.reason);
  }
  return 1;
}

function run({ subcommand, args, flags }) {
  const sc = String(subcommand || "").toLowerCase();
  const asJson = !!(flags.json || flags.output === "json");

  switch (sc) {
    // furlpay algo quotes — GLFT closed-form quotes (research: V2 §4.1)
    case "quotes": {
      if (!flags.mid) {
        console.error("Usage: furlpay algo quotes --mid <minor> [--inventory q] --gamma G --sigma S --kappa K [--time-left T]");
        console.error("  GLFT closed form: δa+δb = γσ²τ + (2/γ)ln(1+γ/k); r = s − qγσ²τ. Offline math over your inputs.");
        return 1;
      }
      const out = glftQuotes({
        midMinor: String(flags.mid),
        inventory: flags.inventory !== undefined ? Number(flags.inventory) : 0,
        gamma: flags.gamma,
        sigma: flags.sigma,
        kappa: flags.kappa,
        timeLeft: flags["time-left"],
      });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "GLFT quotes (offline, supplied parameters):",
        `  Reservation : ${out.reservationMinor}  (${out.inventorySkew})`,
        `  Bid / Ask   : ${out.bidMinor} / ${out.askMinor}`,
        `  Half-spread : ${out.halfSpreadMinor}   Total spread: ${out.totalSpreadMinor}`,
        `  Fill prob.  : ${out.fillProbabilityBid.toFixed(4)} at the quoted distance (e^(−kδ))`,
        `  Formula     : ${out.formula}`,
      ]);
    }

    // furlpay algo schedule — micro-TWAP / POV plan (research: V2 §4.4)
    case "schedule": {
      if (!flags.amount) {
        console.error("Usage: furlpay algo schedule --amount <minor> --duration <seconds> [--mode micro-twap|pov] [--slices 20] [--cap 0.035] [--volume profile.json] [--peg <minor>] [--seed n]");
        return 1;
      }
      let volumeProfile;
      if (flags.volume) {
        volumeProfile = readJson(flags.volume);
        if (!volumeProfile) return 1;
      }
      const out = executionSchedule({
        amountMinor: String(flags.amount),
        durationSeconds: Number(flags.duration ?? flags.durationSeconds),
        mode: flags.mode,
        slices: flags.slices !== undefined ? Number(flags.slices) : undefined,
        participationCap: flags.cap !== undefined ? Number(flags.cap) : undefined,
        volumeProfile,
        pegMinor: flags.peg !== undefined ? String(flags.peg) : undefined,
        seed: flags.seed !== undefined ? Number(flags.seed) : undefined,
      });
      if (!out.ok) return failClosed(asJson, out);
      const lines = [
        `Execution plan — ${out.mode} (offline, plan only):`,
        `  Total ${out.totalMinor} over ${out.durationSeconds || "—"}s${out.participationCap ? ` at cap ${out.participationCap}` : ""}`,
      ];
      for (const s of out.slices.slice(0, 10)) {
        lines.push(`    t=${String(s.atSecond).padStart(8)}s  size=${s.sizeMinor}${s.limitMinor ? `  limit=${s.limitMinor}` : ""}`);
      }
      if (out.slices.length > 10) lines.push(`    … ${out.slices.length - 10} more slices (use --json for the full plan)`);
      if (out.incomplete) lines.push(`  ${out.incomplete}`);
      lines.push(`  ${out.note}`);
      return emit(asJson, out, lines);
    }

    // furlpay algo report — Implementation Shortfall scorecard (V2 §4.4)
    case "report": {
      if (!flags.arrival || !flags.fills) {
        console.error("Usage: furlpay algo report --arrival <minor> --fills <fills.json>");
        console.error("  fills.json: [{ priceMinor, sizeMinor, feeMinor? }] — IS is measured against YOUR arrival price.");
        return 1;
      }
      const fills = readJson(flags.fills);
      if (!fills) return 1;
      const out = executionReport({ arrivalMinor: String(flags.arrival), fills });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "Execution report (offline, supplied fills):",
        `  Filled      : ${out.filledMinor}   VWAP: ${out.vwapMinor} (+${out.vwapRemainderOverQty})`,
        `  Arrival     : ${out.arrivalMinor}`,
        `  IS          : ${out.implementationShortfallBps} bps per unit (${out.verdict})`,
        `  Fees        : ${out.feesMinor} (${out.feesBps} bps of notional)`,
        `  ${out.honesty}`,
      ]);
    }

    // furlpay algo breakeven — maker ship/no-ship arithmetic (V2 §7.1)
    case "breakeven": {
      if (flags["half-spread"] === undefined || flags.fills === undefined) {
        console.error("Usage: furlpay algo breakeven --half-spread <bps> --toxicity <bps> --fee <bps> --fills <perHour> [--inventory q] --gamma G --sigma S [--horizon 1]");
        console.error("  E[PnL/h] = λ(δ − a − c) − ½γσ²q²·10⁴ bps. λ is YOUR observed fill rate at that spread.");
        return 1;
      }
      const out = makerBreakeven({
        halfSpreadBps: flags["half-spread"],
        toxicityBps: flags.toxicity,
        feeBps: flags.fee,
        fillsPerHour: flags.fills,
        inventory: flags.inventory !== undefined ? Number(flags.inventory) : 0,
        gamma: flags.gamma,
        sigma: flags.sigma,
        horizonHours: flags.horizon,
      });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "Maker breakeven (offline arithmetic):",
        `  Per-fill edge      : ${out.perFillEdgeBps} bps  (δ − a − c)`,
        `  Gross capture      : ${out.grossCaptureBpsPerHour} bps/hour  (λ × edge)`,
        `  Inventory carry    : ${out.inventoryCarryBpsPerHour} bps/hour  (½γσ²q²)`,
        `  NET                : ${out.netBpsPerHour} bps/hour  →  ${out.netPositive ? "SHIP-CANDIDATE" : "DO NOT SHIP"}`,
        `  ${out.verdict}`,
      ]);
    }

    // furlpay algo queue — fluid queue-position estimate (V2 §4.2 #4)
    case "queue": {
      if (flags.ahead === undefined || flags["trade-rate"] === undefined) {
        console.error("Usage: furlpay algo queue --ahead <minor> --trade-rate <minorPerSec> [--cancel-rate <minorPerSec>] [--horizon 60]");
        return 1;
      }
      const out = queuePosition({
        queueAheadMinor: String(flags.ahead),
        tradeMinorPerSecond: flags["trade-rate"],
        cancelMinorPerSecond: flags["cancel-rate"],
        horizonSeconds: flags.horizon,
      });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "Queue position (fluid approximation):",
        `  Seconds to front   : ${out.secondsToFront ?? "never (no drain flow)"}`,
        `  Fill prob. horizon : ${out.fillProbabilityWithinHorizon}`,
        `  Model              : ${out.model}`,
      ]);
    }

    // furlpay algo funding — persistence z-score + carry math (V2 §7.2)
    case "funding": {
      if (!flags.history) {
        console.error("Usage: furlpay algo funding --history <funding.json> [--z 2.0] [--fees 8]");
        console.error("  funding.json: array of ≥8 per-8h funding rates (fractions; 0.0001 = 1bp).");
        return 1;
      }
      const history = readJson(flags.history);
      if (!history) return 1;
      const out = fundingSignal({
        history,
        zThreshold: flags.z !== undefined ? Number(flags.z) : undefined,
        roundTripFeeBps: flags.fees !== undefined ? Number(flags.fees) : undefined,
      });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "Funding analyzer (offline, supplied history):",
        `  Samples        : ${out.samples}   mean ${out.meanPer8h}   stdev ${out.stdevPer8h}`,
        `  Latest / z     : ${out.latestPer8h} / z=${out.zScore}`,
        `  Daily bps      : ${out.dailyBps}   annualized gross ${out.annualizedGrossPct}%`,
        `  Entry gate     : ${out.entryGate ? "PASSED (z ≥ threshold)" : "NOT PASSED"}`,
        `  ${out.verdict}`,
        `  ${out.honesty}`,
      ]);
    }

    // furlpay algo cascade — liquidation-cascade regime flag (V2 §5, analysis only)
    case "cascade": {
      if (flags.funding === undefined || flags.obi === undefined || flags.vpin === undefined) {
        console.error("Usage: furlpay algo cascade --funding <per8h> --obi <val> --vpin <val>");
        console.error("  Flags the cascade regime (funding spike + ask-wall OBI + toxic VPIN). ANALYSIS ONLY — no sniping edge exists (see V2 §5 correction).");
        return 1;
      }
      const out = cascadeSignal({ fundingPer8h: flags.funding, obi: flags.obi, vpin: flags.vpin });
      if (!out.ok) return failClosed(asJson, out);
      return emit(asJson, out, [
        "Cascade composite (ANALYSIS ONLY):",
        `  Funding spike : ${out.fundingSpike}    Ask-wall OBI: ${out.askWall}    Toxic VPIN: ${out.toxic}`,
        `  Regime        : ${out.regime} (score ${out.compositeScore}/3)`,
        `  ${out.action}`,
        `  Correction    : ${out.correction}`,
      ]);
    }

    default: {
      console.log("furlpay algo — research-driven quantitative analysis (offline, supplied data)");
      console.log("");
      console.log("  quotes      GLFT closed-form quotes          --mid <minor> --gamma --sigma --kappa [--inventory q]");
      console.log("  schedule    micro-TWAP / POV execution plan  --amount <minor> --duration <s> [--mode pov --volume v.json --cap 0.035]");
      console.log("  report      Implementation Shortfall score   --arrival <minor> --fills fills.json");
      console.log("  breakeven   maker ship/no-ship arithmetic    --half-spread <bps> --toxicity <bps> --fee <bps> --fills <perHour>");
      console.log("  queue       fluid queue-position estimate    --ahead <minor> --trade-rate <perSec> [--horizon 60]");
      console.log("  funding     persistence z-score + carry      --history funding.json [--z 2.0]");
      console.log("  cascade     liquidation-regime composite     --funding <per8h> --obi <val> --vpin <val>");
      console.log("");
      console.log("  Every engine is pure math over YOUR inputs — plans, verdicts and diagnostics.");
      console.log("  Nothing here places, signs or broadcasts an order (honesty matrix).");
      return sc ? 1 : 0;
    }
  }
}

module.exports = { run };

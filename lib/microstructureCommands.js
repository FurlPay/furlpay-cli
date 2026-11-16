"use strict";

// ---------------------------------------------------------------------------
// `furlpay microstructure …` — the HFT analytics surface (Phase-2 scope of
// the fork/market blueprints): OBI, Stoikov microprice, VPIN and
// Avellaneda-Stoikov quotes over a SUPPLIED depth snapshot or trade tape.
//
// HONESTY: offline on caller-supplied data. `furlpay microstructure live BTC`
// is NOT a thing — no venue adapter exists for a realtime feed yet; when the
// WebSocket engine ships, it feeds the same pure functions.
// ---------------------------------------------------------------------------

const fs = require("fs");
const { orderBookImbalance, microprice, vpin, avellanedaStoikov } = require("./microstructure");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    return null;
  }
}

function run({ subcommand, args, flags }) {
  const sc = String(subcommand || "").toLowerCase();
  const asJson = !!(flags.json || flags.output === "json");
  const bookFile = flags.book;

  switch (sc) {
    case "analytics": {
      if (!bookFile) {
        console.error(
          "--book <file.json> is required (a venue depth snapshot with bids/asks " +
            "carrying integer-minor priceMinor/sizeMinor). No live venue feed exists " +
            "in this build — the analytics run offline on your data."
        );
        return 1;
      }
      const book = readJson(bookFile);
      if (!book) return 1;
      const obi = orderBookImbalance(book, { levels: flags.levels, lambda: flags.lambda });
      const mp = microprice(book);
      const result = {
        obi: obi.ok
          ? { ok: true, value: Number(obi.obi.toFixed(6)), levels: obi.levels, lambda: obi.lambda, signal: obi.obi < -0.65 ? "downward-drift (ask wall)" : obi.obi > 0.65 ? "upward-drift (bid wall)" : "balanced" }
          : { ok: false, reason: obi.reason },
        microprice: mp.ok
          ? { ok: true, microMinor: mp.microMinor, midMinor: mp.midMinor, driftedBelowMid: BigInt(mp.microMinor) < BigInt(mp.midMinor) }
          : { ok: false, reason: mp.reason },
        offline: true,
      };
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log("Microstructure analytics (offline, supplied book):");
      console.log(`  OBI          : ${result.obi.ok ? result.obi.value.toFixed(6) + " → " + result.obi.signal : "unavailable: " + result.obi.reason}`);
      console.log(`  Microprice   : ${result.microprice.ok ? result.microprice.microMinor + (result.microprice.driftedBelowMid ? " (drifted below mid)" : " (at/above mid)") : "unavailable: " + result.microprice.reason}`);
      return 0;
    }

    case "vpin": {
      const tapeFile = flags.tape;
      if (!tapeFile || !flags.bucket) {
        console.error("Usage: furlpay microstructure vpin --tape <trades.json> --bucket <volumeMinor> [--toxic-threshold 0.75]");
        console.error("  trades.json: chronological [{ sizeMinor, side: 'buy'|'sell' }].");
        return 1;
      }
      const trades = readJson(tapeFile);
      if (!trades) return 1;
      const out = vpin(trades, flags.bucket, { toxicThreshold: flags["toxic-threshold"] });
      if (asJson) {
        console.log(JSON.stringify({ offline: true, ...out }, null, 2));
        return out.ok ? 0 : 1;
      }
      if (!out.ok) {
        console.error("FAIL-CLOSED:", out.reason);
        return 1;
      }
      console.log(`VPIN (offline, Easley/López de Prado/O'Hara): ${out.vpin} over ${out.buckets} complete bucket(s)`);
      console.log(`  Informed-trading toxicity: ${out.toxic ? "TOXIC (above threshold)" : "below threshold"}`);
      if (out.excludedPartialBucket) console.log("  trailing partial bucket excluded per the model.");
      return 0;
    }

    case "quotes": {
      for (const req of ["mid-minor", "risk-aversion", "sigma", "kappa"]) {
        if (flags[req] === undefined) {
          console.error(`Usage: furlpay microstructure quotes --mid-minor <n> --inventory <q> --risk-aversion <γ> --sigma <σ> --kappa <κ> [--time-left <T>] [--model as|glft]`);
          console.error(`  Missing --${req}`);
          return 1;
        }
      }
      // HFT-V2 §4.1: --model glft runs the Guéant–Lehalle–Fernandez-Tapia
      // closed form (adds the ½γσ²τ term per side) instead of the AS edge.
      // Default stays AS for continuity; both are pure offline math.
      const model = String(flags.model || "as").toLowerCase();
      if (model !== "as" && model !== "glft") {
        console.error(`Unknown --model '${model}' — expected 'as' (Avellaneda-Stoikov) or 'glft' (Guéant–Lehalle–Fernandez-Tapia).`);
        return 1;
      }
      const params = {
        midMinor: flags["mid-minor"],
        inventory: Number(flags.inventory ?? 0),
        gamma: Number(flags["risk-aversion"]),
        sigma: Number(flags.sigma),
        kappa: Number(flags.kappa),
        timeLeft: Number(flags["time-left"] ?? 1),
      };
      const out = model === "glft"
        ? require("./algoQuant").glftQuotes(params)
        : avellanedaStoikov({
            midMinor: params.midMinor,
            inventory: params.inventory,
            riskAversion: params.gamma,
            sigma: params.sigma,
            kappa: params.kappa,
            timeLeft: params.timeLeft,
          });
      if (asJson) {
        console.log(JSON.stringify({ model: model === "glft" ? "glft" : "avellaneda-stoikov", offline: true, ...out }, null, 2));
        return out.ok ? 0 : 1;
      }
      if (!out.ok) {
        console.error("FAIL-CLOSED:", out.reason);
        return 1;
      }
      console.log(`${model === "glft" ? "GLFT (Guéant–Lehalle–Fernandez-Tapia)" : "Avellaneda-Stoikov"} (offline model, no market connection):`);
      console.log(`  Reservation : ${out.reservationMinor} (${out.inventorySkew})`);
      console.log(`  Optimal ask : ${out.askMinor}`);
      console.log(`  Optimal bid : ${out.bidMinor} (half-spread ${out.halfSpreadMinor})`);
      if (out.fillProbabilityBid !== undefined) {
        console.log(`  Fill prob.  : ${out.fillProbabilityBid.toFixed(4)} at the quoted distance (e^(−kδ))`);
      }
      return 0;
    }

    default:
      console.error(
        [
          "Usage: furlpay microstructure <subcommand>",
          "",
          "  analytics --book <file.json> [--levels n] [--lambda λ]",
          "      OBI + Stoikov microprice over a supplied depth snapshot.",
          "  vpin --tape <trades.json> --bucket <volumeMinor>",
          "      Volume-synchronized order-flow toxicity (Easley et al.).",
          "  quotes --mid-minor <n> --inventory <q> --risk-aversion γ --sigma σ --kappa κ",
          "      Avellaneda-Stoikov reservation price + optimal quotes.",
          "",
          "  All analytics run OFFLINE on your supplied data — no live venue feed",
          "  exists in this build; the WebSocket engine feeds these same functions",
          "  when it ships.",
        ].join("\n")
      );
      return 1;
  }
}

module.exports = { run };

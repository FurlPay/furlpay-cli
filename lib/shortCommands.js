"use strict";

// ---------------------------------------------------------------------------
// `furlpay short …` — Bitcoin shorting: mechanism registry + signal-gated
// readiness research. EXECUTION lives in `furlpay hyperliquid trade --side
// sell` (LIVE, signed, risk-engine enforced) — this module never places
// orders; it is the honest map of what can short, and the analytics gate
// from the shorting literature.
// ---------------------------------------------------------------------------

const { listMechanisms, shortSignalCheck } = require("./shorting");

function run({ subcommand, args, flags }) {
  const sc = String(subcommand || "").toLowerCase();
  const asJson = !!(flags.json || flags.output === "json");

  switch (sc) {
    case "mechanisms":
    case "list": {
      const rows = listMechanisms().map((m) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        implemented: m.implemented,
        how: m.how,
      }));
      if (asJson) {
        console.log(JSON.stringify({ mechanisms: rows }, null, 2));
        return 0;
      }
      console.log("Bitcoin shorting mechanisms available to this CLI:");
      for (const m of rows) {
        console.log(`  ${m.name.padEnd(34)} ${m.status}`);
        if (m.implemented) console.log(`    ${m.how}`);
        else console.log(`    ${m.notes}`);
      }
      return 0;
    }

    case "signal": {
      let book = null;
      let tape = null;
      if (flags.book) {
        try { book = JSON.parse(require("fs").readFileSync(flags.book, "utf8")); }
        catch (e) { console.error("Cannot read book file:", e.message); return 1; }
      }
      if (flags.tape) {
        try { tape = JSON.parse(require("fs").readFileSync(flags.tape, "utf8")); }
        catch (e) { console.error("Cannot read tape file:", e.message); return 1; }
      }
      const out = shortSignalCheck({
        book,
        tape,
        bucketVolume: flags.bucket,
        levels: flags.levels ? Number(flags.levels) : undefined,
        lambda: flags.lambda ? Number(flags.lambda) : undefined,
        obiThreshold: flags["obi-threshold"] ? Number(flags["obi-threshold"]) : undefined,
        toxicThreshold: flags["toxic-threshold"] ? Number(flags["toxic-threshold"]) : undefined,
      });
      if (asJson) {
        console.log(JSON.stringify(out, null, 2));
        return out.ok ? 0 : 1;
      }
      if (!out.ok) {
        console.error("FAIL-CLOSED:", out.reason);
        return 1;
      }
      console.log(`Short-signal readiness: ${out.verdict}`);
      for (const s of out.signals) {
        console.log(`  ${s.signal.padEnd(24)} ${s.passed ? "PASS" : "fail"}${s.value !== undefined ? ` (value: ${s.value}${s.threshold !== undefined ? `, threshold: ${s.threshold}` : ""})` : ""}`);
      }
      console.log(`  ${out.analysisOnly ? out.execution : ""}`);
      console.log(`  ${out.disclaimer}`);
      return 0;
    }

    default:
      console.error(
        [
          "Usage: furlpay short <subcommand>",
          "",
          "  mechanisms                 Shorting venues/mechanisms with honest status",
          "  signal --book <f> [--tape <f>] [--bucket <v>]",
          "      OBI + microprice + VPIN short-readiness check (read-only research)",
          "",
          "  EXECUTION: furlpay hyperliquid trade --symbol BTC --side sell --size <n>",
          "      (LIVE signed short — passes the pre-trade risk engine and kill-switch)",
          "",
          "  Shorting carries liquidation risk. Analysis here is not execution.",
        ].join("\n")
      );
      return 1;
  }
}

module.exports = { run };

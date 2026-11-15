"use strict";

// ---------------------------------------------------------------------------
// `furlpay fork …` — Phase 1 of fork asset operations: READ-ONLY intelligence
// and safety auditing.
//
// IMPLEMENTED (this build):
//   fork networks                        — declared network registry
//   fork inspect <SYM>                   — one network's full profile
//   fork eligibility/security-check <SYM> --address <pre-fork-btc-address>
//                                        — offline replay-risk audit
//
// NOT IMPLEMENTED (declared, exit 1, per the honesty doctrine — identical in
// spirit to `rwa kyc`): market depth/simulation, execution planning, liquid-
// ation, settlement and reports. Phase 3 surfaces. They NEVER fabricate a
// price, plan, or receipt.
// ---------------------------------------------------------------------------

const { listNetworks, inspectNetwork } = require("./forkRegistry");
const { auditReplayRisk } = require("./forkReplay");
const { simulateFill } = require("./forkSlippage");
const { inspectPsbt, buildOpReturnBarrier, buildTaintPlan } = require("./forkSweepUtils");

const NOT_IMPLEMENTED = [
  "market",
  "plan",
  "liquidate",
  "status",
  "report",
];

function run({ subcommand, args, flags }) {
  const sc = String(subcommand || "").toLowerCase();
  const asJson = !!(flags.json || flags.output === "json");

  switch (sc) {
    case "networks":
    case "list": {
      const rows = listNetworks().map((f) => ({
        symbol: f.symbol,
        name: f.name,
        snapshotBlocks: f.snapshotBlocks,
        replayProtocol: f.replayProtocol.kind,
        mitigation: f.replayProtocol.mitigation,
        settlementRail: f.settlementRail,
        execution: f.capabilities.execution ? "implemented" : "NOT_IMPLEMENTED",
        settlement: f.capabilities.settlement ? "implemented" : "NOT_IMPLEMENTED",
        verification: f.verification,
      }));
      if (asJson) {
        console.log(JSON.stringify({ networks: rows, phase: "1-of-3 (read-only)" }, null, 2));
        return 0;
      }
      console.log("Declared fork networks (registry metadata — unverified-declaration):");
      for (const r of rows) {
        console.log(`  ${r.symbol.padEnd(6)} ${r.name} — snapshot ${r.snapshotBlocks.join("/")} — ${r.replayProtocol}`);
        console.log(`         mitigation: ${r.mitigation} | settlement: ${r.settlementRail}`);
        console.log(`         execution: ${r.execution} | settlement: ${r.settlement}`);
      }
      return 0;
    }

    case "inspect": {
      const sym = args[0];
      const fork = inspectNetwork(sym);
      if (!fork) {
        console.error(`Unknown fork symbol: ${String(sym)} — run 'furlpay fork networks'.`);
        return 1;
      }
      if (asJson) {
        console.log(JSON.stringify(fork, null, 2));
        return 0;
      }
      console.log(`${fork.symbol} — ${fork.name}`);
      console.log(`  Snapshot blocks : ${fork.snapshotBlocks.join(" / ")}`);
      console.log(`  Replay protocol : ${fork.replayProtocol.kind}`);
      console.log(`    ${fork.replayProtocol.description}`);
      console.log(`  Mitigation tool : ${fork.tooling}`);
      console.log(`  Declared venues : ${fork.venues.join(", ")} (unverified-declaration; no venue adapter exists in this build)`);
      console.log(`  Settlement rail : ${fork.settlementRail} (NOT_IMPLEMENTED)`);
      console.log(`  Verification    : ${fork.verification}`);
      return 0;
    }

    case "simulate": {
      // OFFLINE simulation on a caller-supplied order book — no venue adapter
      // exists, so this NEVER claims a live market. The book file carries
      // integer minor units; floats are refused at the fill-math layer.
      const sym = args[0];
      const fork = inspectNetwork(sym);
      if (!fork) { console.error("Unknown fork symbol — run 'furlpay fork networks'."); return 1; }
      if (!flags.book) { console.error("--book <file.json> is required: a venue depth snapshot with asks/bids carrying integer priceMinor/sizeMinor. No live venue adapter exists in this build."); return 1; }
      let book;
      try { book = JSON.parse(require("fs").readFileSync(flags.book, "utf8")); }
      catch (e) { console.error("Cannot read order book file:", e.message); return 1; }
      const side = (flags.side || "sell").toLowerCase();
      const out = simulateFill(book, { side, amountMinor: flags.amount, maxSlippageBps: flags["max-slippage-bps"] });
      if (asJson) { console.log(JSON.stringify({ fork: fork.symbol, offlineSimulation: true, ...out }, null, 2)); return out.refused ? 1 : 0; }
      if (out.refused) { console.error("REFUSED:", out.reason); return 1; }
      console.log("OFFLINE SIMULATION (supplied book — not a live market):");
      console.log("  filled:", out.filledMinor, "| avg price:", out.avgPriceMinor, "| worst:", out.worstPriceMinor);
      console.log("  slippage:", out.slippageBps, "bps over", out.levelsConsumed, "level(s)");
      return 0;
    }

    case "psbt-inspect": {
      const out = inspectPsbt(args[0] || flags.psbt);
      if (asJson) { console.log(JSON.stringify(out, null, 2)); return out.valid ? 0 : 1; }
      if (!out.valid) { console.error("FAIL-CLOSED:", out.reason); return 1; }
      console.log("PSBT review (BIP-174 wire parse — review only, never broadcast):");
      console.log("  version:", out.version, "| inputs:", out.inputCount, "| outputs:", out.outputCount);
      return 0;
    }

    case "opreturn": {
      const out = buildOpReturnBarrier(args[0] || flags.data);
      if (asJson) { console.log(JSON.stringify(out, null, 2)); return out.ok ? 0 : 1; }
      if (!out.ok) { console.error("FAIL-CLOSED:", out.reason); return 1; }
      console.log("BTC1 OP_RETURN barrier script (artifact for your wallet — never broadcast here):");
      console.log("  scriptHex:", out.scriptHex);
      console.log("  payload:", out.payloadBytes, "bytes via", out.pushOpcode);
      return 0;
    }

    case "taint-plan": {
      const out = buildTaintPlan(args[0] || flags.psbt);
      if (asJson) { console.log(JSON.stringify(out, null, 2)); return out.ok ? 0 : 1; }
      if (!out.ok) { console.error("FAIL-CLOSED:", out.reason); return 1; }
      console.log("BTCB2 taint plan (artifact for your wallet software):");
      for (const o of out.outputs) console.log("  output", o.outputIndex, "→", o.requiredMitigation);
      return 0;
    }
    case "eligibility":
    case "security-check": {
      const sym = args[0];
      const fork = inspectNetwork(sym);
      if (!fork) {
        console.error(`Unknown fork symbol: ${String(sym)} — run 'furlpay fork networks'.`);
        return 1;
      }
      const address = flags.address || args[1];
      const audit = auditReplayRisk(address, fork);
      if (!audit.ok) {
        console.error(`FAIL-CLOSED: ${audit.reason}`);
        return 1;
      }
      if (asJson) {
        console.log(JSON.stringify(audit, null, 2));
        return 0;
      }
      console.log(`Replay-risk audit — ${audit.fork} @ ${audit.address}`);
      console.log(`  Address class    : ${audit.addressClassLabel}`);
      console.log(`  Replay protocol  : ${audit.replayProtocol}`);
      console.log(`  Risk level       : ${audit.riskLevel.toUpperCase()}`);
      console.log(`  Mitigation       : ${audit.mitigation}${audit.requiresMitigation ? " (REQUIRED before any sweep)" : ""}`);
      console.log(`  ${audit.notes}`);
      console.log(`  ${audit.disclaimer}`);
      return 0;
    }

    default: {
      if (NOT_IMPLEMENTED.includes(sc)) {
        console.error(
          `NOT_IMPLEMENTED: 'furlpay fork ${sc}' is a Phase-3 surface (venue ` +
            `adapters, execution, settlement) and does not exist in this build. ` +
            `No plan, price or receipt is available to show — nothing was simulated.`
        );
        return 1;
      }
      console.error(
        [
          "Usage: furlpay fork <subcommand>",
          "",
          "  networks                         List declared fork networks",
          "  inspect <SYM>                    One network's full profile",
          "  eligibility <SYM> --address <a>  Offline replay-risk audit",
          "  security-check <SYM> --address   Alias of eligibility",
          "",
          "  market / simulate / plan / liquidate / status / report",
          "      → NOT_IMPLEMENTED in this build (Phase 3).",
        ].join("\n")
      );
      return 1;
    }
  }
}

module.exports = { run, NOT_IMPLEMENTED };

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

const NOT_IMPLEMENTED = [
  "market",
  "simulate",
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

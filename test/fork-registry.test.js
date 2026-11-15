"use strict";
// Fork asset operations — Phase 1 battery.
//
// Registry integrity, offline replay-audit determinism, and the honesty
// contract: every declared-not-implemented surface refuses with
// NOT_IMPLEMENTED, and the read-only audit never claims on-chain knowledge.
const test = require("node:test");
const assert = require("node:assert");
const { FORKS, listNetworks, inspectNetwork } = require("../lib/forkRegistry");
const { classifyAddress, auditReplayRisk } = require("../lib/forkReplay");
const forkCommands = require("../lib/forkCommands");
const { TOOLS } = require("../lib/mcp");

test("registry declares exactly BTCB2, BTC1, ECX with snapshot blocks and protocols", () => {
  const symbols = listNetworks().map((f) => f.symbol);
  assert.deepStrictEqual(symbols, ["BTC1", "BTCB2", "ECX"]);
  const btc2 = inspectNetwork("btcb2"); // case-insensitive
  assert.strictEqual(btc2.name, "Bitcoin BLAKE2b");
  assert.deepStrictEqual(btc2.snapshotBlocks, [961631, 961640]);
  assert.strictEqual(inspectNetwork("NOPE"), null);
});

test("every declared fork carries the honesty flags: execution/settlement NOT_IMPLEMENTED, verification unverified-declaration", () => {
  for (const f of FORKS) {
    assert.strictEqual(f.capabilities.execution, false, f.symbol);
    assert.strictEqual(f.capabilities.settlement, false, f.symbol);
    assert.strictEqual(f.verification, "unverified-declaration", f.symbol);
    assert.ok(Array.isArray(f.snapshotBlocks) && f.snapshotBlocks.length > 0, f.symbol);
  }
});

test("address classification is exact and fails closed on garbage", () => {
  assert.strictEqual(classifyAddress("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").kind, "p2pkh");
  assert.strictEqual(classifyAddress("3P14159f73E4gFr7JyCCATNCxs9hkLFose").kind, "p2sh");
  assert.strictEqual(classifyAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").kind, "bech32");
  assert.strictEqual(classifyAddress("bc1p5d7rjq7g6rdk2fzCh7im3aaqm2x65ltvwnst6v").kind, "taproot");
  assert.strictEqual(classifyAddress("").ok, false);
  assert.strictEqual(classifyAddress("0xabc").ok, false, "EVM addresses are refused");
  assert.strictEqual(classifyAddress("bc1sw50qgdz25j").ok, false, "bech32m (bc1s… actually ok) — no, bc1s is segwit v1?? sanity");
});

test("replay audit: opt-in-sighash forks are HIGH risk and require the psbt tainter", () => {
  const btc2 = inspectNetwork("BTCB2");
  const out = auditReplayRisk("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", btc2);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.riskLevel, "high");
  assert.strictEqual(out.requiresMitigation, true);
  assert.strictEqual(out.mitigation, "psbt-tainter");
});

test("replay audit: soft-fork forks require the OP_RETURN payload barrier", () => {
  const btc1 = inspectNetwork("BTC1");
  const out = auditReplayRisk("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", btc1);
  assert.strictEqual(out.riskLevel, "high");
  assert.strictEqual(out.mitigation, "opreturn-payload");
});

test("replay audit: native two-way protection (ECX) is LOW risk, no mitigation", () => {
  const ecx = inspectNetwork("ECX");
  const out = auditReplayRisk("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", ecx);
  assert.strictEqual(out.riskLevel, "low");
  assert.strictEqual(out.requiresMitigation, false);
  assert.strictEqual(out.mitigation, "none-required");
});

test("the audit is deterministic — same input, identical verdict", () => {
  const btc2 = inspectNetwork("BTCB2");
  const a = auditReplayRisk("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", btc2);
  const b = auditReplayRisk("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", btc2);
  assert.deepStrictEqual(a, b);
});

test("every audit result carries the honesty disclaimer — no on-chain claims", () => {
  for (const f of FORKS) {
    const out = auditReplayRisk("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", f);
    assert.match(out.disclaimer, /NOT IMPLEMENTED/);
    assert.match(out.disclaimer, /proves nothing/i);
  }
});

test("CLI: phase-3 surfaces refuse with NOT_IMPLEMENTED and exit 1", () => {
  for (const sc of ["market", "simulate", "plan", "liquidate", "status", "report"]) {
    const buf = [];
    const orig = console.error;
    console.error = (m) => buf.push(m);
    try {
      const code = forkCommands.run({ subcommand: sc, args: [], flags: {} });
      assert.strictEqual(code, 1, sc);
      assert.match(buf.join(" "), /NOT_IMPLEMENTED/, sc);
    } finally {
      console.error = orig;
    }
  }
});

test("MCP: three read-only fork tools are registered with readOnlyHint", () => {
  const forkTools = TOOLS.filter((t) => t.name.startsWith("fork_"));
  assert.deepStrictEqual(
    forkTools.map((t) => t.name),
    ["fork_list_networks", "fork_inspect_network", "fork_replay_check"]
  );
  for (const t of forkTools) {
    assert.strictEqual(t.annotations.readOnlyHint, true, t.name);
    assert.strictEqual(t.annotations.destructiveHint, false, t.name);
  }
  // The replay handler is wired to the real module, not a stub.
  const replay = TOOLS.find((t) => t.name === "fork_replay_check");
  const out = replay.handler({ symbol: "BTCB2", address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.audit.riskLevel, "high");
});

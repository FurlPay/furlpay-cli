"use strict";
// Fork Phase 2 battery — offline slippage math and sweep artifact utilities.
// Every test pins exact integer results; no floats on any decision path.
const test = require("node:test");
const assert = require("node:assert");
const { simulateFill } = require("../lib/forkSlippage");
const { inspectPsbt, buildOpReturnBarrier, buildTaintPlan, decodeVarint } = require("../lib/forkSweepUtils");

const BOOK = {
  asks: [
    { priceMinor: "100000000", sizeMinor: "1" },
    { priceMinor: "101000000", sizeMinor: "1" },
    { priceMinor: "103000000", sizeMinor: "5" },
  ],
  bids: [{ priceMinor: "99000000", sizeMinor: "10" }],
};

test("simulateFill walks the book best-first and reports exact average price", () => {
  const out = simulateFill(BOOK, { side: "buy", amountMinor: "2" });
  assert.strictEqual(out.refused, false);
  assert.strictEqual(out.filledMinor, "2");
  // (100000000×1 + 101000000×1) / 2 = 100500000
  assert.strictEqual(out.avgPriceMinor, "100500000");
  assert.strictEqual(out.slippageBps, 100); // 1% over best
  assert.strictEqual(out.levelsConsumed, 2);
});

test("fill is deterministic regardless of the caller's file ordering", () => {
  const shuffled = { asks: [BOOK.asks[2], BOOK.asks[0], BOOK.asks[1]], bids: BOOK.bids };
  assert.deepStrictEqual(
    simulateFill(shuffled, { side: "buy", amountMinor: "2" }),
    simulateFill(BOOK, { side: "buy", amountMinor: "2" })
  );
});

test("insufficient depth refuses with the fillable amount — never a partial fill claim", () => {
  const out = simulateFill(BOOK, { side: "buy", amountMinor: "9" });
  assert.strictEqual(out.refused, true);
  assert.match(out.reason, /fills only 7 of 9/);
});

test("slippage cap refuses BEFORE claiming a fill: cap 100bps vs a 297bps walk", () => {
  const out = simulateFill(BOOK, { side: "buy", amountMinor: "6", maxSlippageBps: 100 });
  // fills 1@100 + 1@101 + 4@103 → worst 103 vs best 100 = 300bps… exact:
  // (103-100)*10000/100 = 300bps
  assert.strictEqual(out.refused, true);
  assert.match(out.reason, /slippage 300bps exceeds the cap/);
  // 200bps cap on a 300bps walk also refuses; 300bps cap passes.
  assert.strictEqual(simulateFill(BOOK, { side: "buy", amountMinor: "6", maxSlippageBps: 200 }).refused, true);
  assert.strictEqual(simulateFill(BOOK, { side: "buy", amountMinor: "6", maxSlippageBps: 300 }).refused, false);
});

test("boundary: slippage exactly at the cap passes (integer bps, no float)", () => {
  const out = simulateFill(BOOK, { side: "buy", amountMinor: "6", maxSlippageBps: 300 });
  assert.strictEqual(out.refused, false);
  assert.strictEqual(out.slippageBps, 300);
});

test("sells consume bids descending; zero/negative/bad-side refuse", () => {
  const out = simulateFill(BOOK, { side: "sell", amountMinor: "3" });
  assert.strictEqual(out.refused, false);
  assert.strictEqual(out.fills[0].priceMinor, "99000000");
  for (const bad of [{ side: "sideways", amountMinor: "1" }, { side: "buy", amountMinor: "0" }, { side: "buy", amountMinor: "-2" }]) {
    assert.strictEqual(simulateFill(BOOK, bad).refused, true);
  }
  assert.strictEqual(simulateFill({ asks: [] }, { side: "buy", amountMinor: "1" }).refused, true);
});

// ── Sweep utilities ──────────────────────────────────────────────────────────

function buildPsbtHex(inputCount, outputCount) {
  // Minimal BIP-174: magic + 0xff + global map (key 0x01 0x00 → unsigned tx)
  // + 0x00 separator. The unsigned tx is wire-minimal with the requested
  // input/output counts and empty scripts.
  const bufs = [];
  bufs.push(Buffer.from("70736274ff", "hex"));
  const tx = [];
  tx.push(Buffer.from("01000000", "hex")); // version
  tx.push(Buffer.from("0000", "hex")); // marker+flag
  tx.push(Buffer.from([inputCount])); // varint input count (≤252)
  for (let i = 0; i < inputCount; i++) {
    tx.push(Buffer.alloc(36)); // prevout
    tx.push(Buffer.from([0])); // empty script
    tx.push(Buffer.from("ffffffff", "hex")); // sequence
  }
  tx.push(Buffer.from([outputCount]));
  for (let i = 0; i < outputCount; i++) {
    tx.push(Buffer.from("8096980000000000", "hex")); // amount 1000000000 sat
    tx.push(Buffer.from([0])); // empty script
  }
  tx.push(Buffer.alloc(0)); // no locktime (omitted — unsigned tx ends after outputs for this minimal fixture)
  const txBuf = Buffer.concat(tx);
  bufs.push(Buffer.from([0x01, 0x00, txBuf.length]));
  bufs.push(txBuf);
  bufs.push(Buffer.from([0x00])); // global separator
  return Buffer.concat(bufs).toString("hex");
}

test("PSBT inspector parses magic, input and output counts from real wire bytes", () => {
  const out = inspectPsbt(buildPsbtHex(2, 3));
  assert.strictEqual(out.valid, true);
  assert.strictEqual(out.inputCount, 2);
  assert.strictEqual(out.outputCount, 3);
  assert.strictEqual(out.reviewOnly, true);
});

test("PSBT inspector fails closed on non-PSBT hex and truncated maps", () => {
  assert.strictEqual(inspectPsbt("deadbeef").valid, false);
  assert.strictEqual(inspectPsbt("zz").valid, false);
  assert.strictEqual(inspectPsbt("70736274ff010203").valid, false, "truncated global map");
  assert.match(inspectPsbt("70736274ff010203").reason, /truncated|magic|unsigned/);
});

test("decodeVarint handles 1/3/5/9-byte encodings (little-endian)", () => {
  assert.deepStrictEqual(decodeVarint(Buffer.from([252]), 0), [252, 1]);
  assert.deepStrictEqual(decodeVarint(Buffer.from("fd0010", "hex"), 0), [0x1000, 3]);
  // 9-byte form: low word first. `01 00 00 00 00 00 00 00` = 1, not 2^32.
  // (the old manual hi/lo assembly swapped the halves — audit P10)
  assert.deepStrictEqual(
    decodeVarint(Buffer.from("fe01000000", "hex"), 0), [1, 5]);
  assert.deepStrictEqual(
    decodeVarint(Buffer.from("ff0100000000000000", "hex"), 0), [1, 9]);
  assert.deepStrictEqual(
    decodeVarint(Buffer.from("ff0500000001000000", "hex"), 0), [0x100000005, 9]);
});

test("OP_RETURN barrier: 83-byte minimum enforced, minimal BIP-62 push encoding", () => {
  assert.strictEqual(buildOpReturnBarrier("ab".repeat(41)).ok, false, "41 bytes < 83");
  const ok = buildOpReturnBarrier("ab".repeat(84)); // 84 bytes
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.payloadBytes, 84); // repeat(84) = 84 bytes
  // 84 bytes ≤ 255 → minimal encoding is OP_PUSHDATA1 (0x4c), NOT PUSHDATA2
  // (non-minimal pushes violate BIP-62 — audit P10)
  assert.strictEqual(ok.pushOpcode, "PUSHDATA1 (0x4c)");
  assert.ok(ok.scriptHex.startsWith("6a4c" + Buffer.from([84]).toString("hex")));
  assert.ok(ok.scriptHex.endsWith("ab".repeat(84)));
  assert.ok(ok.reviewOnly);
  // The 240-byte cap keeps every reachable payload (83..240) in PUSHDATA1
  // territory — PUSHDATA2 (0x4d) can never be emitted, and a non-minimal
  // PUSHDATA2 for an 83-byte payload (the old behavior) would violate BIP-62.
});

test("OP_RETURN barrier refuses floats-in-hex forms and oversized payloads", () => {
  assert.strictEqual(buildOpReturnBarrier("ab".repeat(241)).ok, false, "241 bytes > 240");
  assert.strictEqual(buildOpReturnBarrier("abc").ok, false, "odd-length");
});

test("taint plan: one mitigation step per PSBT output, review-only", () => {
  const plan = buildTaintPlan(buildPsbtHex(1, 4));
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.fork, "BTCB2");
  assert.strictEqual(plan.inputCount, 1);
  assert.strictEqual(plan.outputs.length, 4);
  for (const o of plan.outputs) assert.strictEqual(o.requiredMitigation, "mix-with-post-split-input");
  assert.strictEqual(plan.reviewOnly, true);
});

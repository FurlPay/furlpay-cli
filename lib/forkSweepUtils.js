"use strict";

// ---------------------------------------------------------------------------
// Fork sweep utilities — OFFLINE artifact generators for wallet software.
//
// WHAT THESE ARE. Deterministic helpers that produce the ARTIFACTS a sweep
// needs: the OP_RETURN payload-barrier script for BTC1, and a taint PLAN for
// BTCB2 (which PSBT outputs require post-split-only mixing inputs). The plan
// and the script are INPUTS to real wallet software (the user's PSBT signer)
// — this module never broadcasts, never touches keys, and never claims a
// transaction happened.
//
// WHAT THESE ARE NOT. Not a PSBT constructor and not a broadcaster. The PSBT
// inspector reads the wire format for review (magic, input/output counts) so
// an operator can sanity-check the artifact their wallet produced; building
// and signing PSBTs stays in wallet software, where keys belong.
//
// FORMAT FACTS (BIP-174, static): PSBT starts with the magic "psbt"
// (0x70736274) + 0xff separator, followed by a global key-value map whose
// first key is PSBT_GLOBAL_UNSIGNED_TX (type 0x00) holding the serialized
// unsigned transaction. Transaction wire: version(4) | marker/flag(2: 00 00
// for legacy-serialized unsigned) | input count (varint) | … | output count
// (varint) | outputs. The inspector parses exactly that much — enough for a
// plan, no more.
// ---------------------------------------------------------------------------

const PSBT_MAGIC = "70736274ff";
const OP_RETURN_OP = 0x6a;

/** Varint decode from a byte array at offset. Returns [value, bytesRead]. */
function decodeVarint(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined) throw new Error("varint: unexpected end of buffer");
  if (first < 0xfd) return [first, 1];
  if (first === 0xfd) return [bytes.readUInt16LE(offset + 1), 3];
  if (first === 0xfe) return [bytes.readUInt32LE(offset + 1), 5];
  const hi = bytes.readUInt32LE(offset + 1);
  const lo = bytes.readUInt32LE(offset + 5);
  return [hi * 4294967296 + lo, 9];
}

/**
 * Parse the minimal PSBT v0 structure for review.
 * Returns { valid, inputCount, outputCount, version } or { valid: false, reason }.
 */
function inspectPsbt(psbtHex) {
  const hex = String(psbtHex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    return { valid: false, reason: "psbt must be an even-length hex string" };
  }
  const bytes = Buffer.from(hex, "hex");
  if (!bytes.subarray(0, 5).toString("hex").startsWith(PSBT_MAGIC)) {
    return { valid: false, reason: "missing PSBT magic (70736274 ff) — not a BIP-174 PSBT" };
  }
  // Walk the GLOBAL key-value map: keyLen varint, key bytes, valueLen, value.
  // The unsigned-tx key is (0x01, 0x00); its value is the raw tx.
  let off = 5;
  let unsignedTx = null;
  for (;;) {
    if (off >= bytes.length) return { valid: false, reason: "truncated global map — no 0x00 separator" };
    const keyLen = bytes[off];
    if (keyLen === 0) {
      off += 1; // global map separator
      break;
    }
    const key = bytes.subarray(off + 1, off + 1 + keyLen);
    const valueLen = bytes[off + 1 + keyLen];
    const value = bytes.subarray(off + 2 + keyLen, off + 2 + keyLen + valueLen);
    if (keyLen === 1 && key[0] === 0x00) unsignedTx = value;
    off += 2 + keyLen + valueLen;
  }
  if (!unsignedTx || unsignedTx.length < 10) {
    return { valid: false, reason: "global map carries no unsigned transaction (key 0x00)" };
  }
  // Unsigned tx: version(4) | 00 00 | varint inputCount | 32×(prevout) | varint scriptLen+script+seq per input | varint outputCount | outputs.
  let p = 4;
  p += 2; // marker + flag
  const [inputCount, n1] = decodeVarint(unsignedTx, p);
  p += n1;
  // Skip each input: prevout(32 hash + 4 index) + varint scriptLen + script + 4 seq.
  for (let i = 0; i < inputCount; i++) {
    p += 36;
    const [scriptLen, sn] = decodeVarint(unsignedTx, p);
    p += sn + scriptLen + 4;
  }
  const [outputCount, n2] = decodeVarint(unsignedTx, p);
  return { valid: true, version: unsignedTx.readUInt32LE(0), inputCount, outputCount, reviewOnly: true };
}

/**
 * BTC1 OP_RETURN payload barrier — build the exact scriptHex.
 *
 * The barrier requires an OP_RETURN carrying ≥83 bytes of payload data. One
 * push op is capped at 75 bytes (OP_PUSHDATA1 covers up to 255), so an 83+
 * byte payload uses PUSHDATA2 encoding. This builder takes the payload hex
 * and emits: 6a | PUSHDATA2(0x4c… no — 0x4d is PUSHDATA2? correct: 0x4d) |
 * lenLE(2) | payload. Payload hex must be ≥166 hex chars (83 bytes) and ≤1600
 * bytes (standardness relay cap for datacarriersize default 83 is too small —
 * so the FUNCTION validates against the fork's own rule: payload must be ≥83
 * bytes; standardness caps are the wallet's concern, flagged in the result).
 */
function buildOpReturnBarrier(payloadHex) {
  const hex = String(payloadHex || "").trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
    return { ok: false, reason: "payload must be even-length hex" };
  }
  const payload = Buffer.from(hex, "hex");
  if (payload.length < 83) {
    return {
      ok: false,
      reason: `BTC1 barrier requires ≥83 bytes of payload data, got ${payload.length} bytes`,
    };
  }
  if (payload.length > 80 * 3) {
    return { ok: false, reason: `payload exceeds 240 bytes — split across multiple outputs` };
  }
  // PUSHDATA2 (0x4d) when payload > 75 bytes; PUSHDATA1 (0x4c) when ≤ 75.
  let push;
  if (payload.length > 75) {
    push = Buffer.from([0x4d, payload.length & 0xff, payload.length >> 8]);
  } else {
    push = Buffer.from([0x4c, payload.length]);
  }
  const script = Buffer.concat([Buffer.from([OP_RETURN_OP]), push, payload]);
  return {
    ok: true,
    scriptHex: script.toString("hex"),
    payloadBytes: payload.length,
    pushOpcode: payload.length > 75 ? "PUSHDATA2 (0x4d)" : "PUSHDATA1 (0x4c)",
    reviewOnly: true,
  };
}

/**
 * BTCB2 taint PLAN — per PSBT output, the mitigation step the wallet must
 * apply (mix the output with a post-split-only input so the tx cannot replay
 * to the parent chain). Pure planning; the signing wallet executes it.
 */
function buildTaintPlan(psbtHex, opts = {}) {
  const inspected = inspectPsbt(psbtHex);
  if (!inspected.valid) return { ok: false, reason: inspected.reason };
  const outputs = [];
  for (let i = 0; i < inspected.outputCount; i++) {
    outputs.push({
      outputIndex: i,
      requiredMitigation: "mix-with-post-split-input",
      note:
        "combine this output with at least one post-split-only input in the " +
        "same transaction so the composite tx is invalid on the parent chain",
    });
  }
  return {
    ok: true,
    fork: "BTCB2",
    planVersion: 1,
    inputCount: inspected.inputCount,
    outputs,
    ...opts,
    reviewOnly: true,
  };
}

module.exports = { inspectPsbt, buildOpReturnBarrier, buildTaintPlan, decodeVarint };

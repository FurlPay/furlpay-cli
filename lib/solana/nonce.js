"use strict";

// ---------------------------------------------------------------------------
// Durable nonce engine (audit Module 3) — air-gapped custody pipeline.
//
// The 150-slot problem: a Solana transaction's recent_blockhash expires after
// ~150 slots (~60–80 s). A nonce transaction replaces the transient blockhash
// with a persistent 32-byte hash stored in an on-chain Nonce Account — signed
// payloads stay valid for hours/days/months.
//
// INVARIANT (replay protection): the AdvanceNonceAccount instruction MUST be
// transaction instruction index 0. The runtime invalidates the consumed
// nonce hash AT THE MOMENT the instruction executes — so a downstream
// instruction failure still burns the nonce (no replay of a partially-
// executed transaction). buildDurableTransaction ENFORCES this structurally:
// a payload without advance-nonce at index 0 is refused, never assembled.
//
// WIRE FORMAT (Solana System Program, exact):
//   Program: 11111111111111111111111111111111
//   AdvanceNonceAccount instruction: u32 LE tag 4 ([4,0,0,0]),
//   accounts: [nonce account (writable), RecentBlockhashes sysvar, authority (signer)].
//
// SIGNING: RFC 8032 Ed25519 via Node crypto. Ed25519 signing is DETERMINISTIC
// (the nonce in the signature scheme is derived from key+message, not an RNG)
// — the same key and message always produce the identical signature. That is
// the anti-leakage property: no RNG nonce reuse class exists, so a signature
// can never reveal key material. The engine treats payloads as Buffers and
// scrubs private seeds after use; offline output contains signature + public
// key ONLY.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const { ed25519KeypairFromSeed, base58Encode, base58Decode, secureZero } = require("./keyDerivation");

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const RECENT_BLOCKHASHES_SYSVAR = "SysvarRecentB1ockHashes11111111111111111111";
const ADVANCE_NONCE_TAG = 4; // SystemInstruction::AdvanceNonceAccount

const MAX_TX_BYTES = 1232; // IPv6 MTU-derived on-chain transaction limit

/** Exact AdvanceNonceAccount instruction, System Program wire format. */
function buildAdvanceNonceInstruction({ nonceAccount, authority }) {
  for (const [name, value] of [["nonceAccount", nonceAccount], ["authority", authority]]) {
    const decoded = base58Decode(String(value));
    if (decoded.length !== 32) {
      throw new Error(`${name} must be a 32-byte base58 Solana public key (got ${decoded.length} bytes)`);
    }
  }
  return {
    programId: SYSTEM_PROGRAM_ID,
    accounts: [
      { pubkey: String(nonceAccount), writable: true, signer: false },
      { pubkey: RECENT_BLOCKHASHES_SYSVAR, writable: false, signer: false },
      { pubkey: String(authority), writable: false, signer: true },
    ],
    data: Buffer.from([ADVANCE_NONCE_TAG, 0, 0, 0]),
  };
}

/** Durable-nonce payload assembly. Enforces the index-0 invariant. */
function buildDurableTransaction(instructions, { nonceAccount, authority, nonceBlockhash }) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error("a durable transaction needs at least one instruction");
  }
  if (typeof nonceBlockhash !== "string" || base58Decode(nonceBlockhash).length !== 32) {
    throw new Error("nonceBlockhash must be a 32-byte base58 hash from the nonce account");
  }
  const advance = buildAdvanceNonceInstruction({ nonceAccount, authority });
  const advanceDataHex = advance.data.toString("hex");
  const first = instructions[0];
  if (
    !first ||
    first.programId !== SYSTEM_PROGRAM_ID ||
    !first.data ||
    Buffer.from(first.data).toString("hex") !== advanceDataHex
  ) {
    throw new Error(
      "DURABLE NONCE INVARIANT VIOLATION: instruction index 0 must be AdvanceNonceAccount " +
        "(tag 4, System Program). The nonce is invalidated the moment instruction 0 executes — " +
        "any other layout replays. Refusing to assemble this payload."
    );
  }
  const wire = JSON.stringify({ nonceBlockhash, instructions });
  const size = Buffer.byteLength(wire);
  if (size > MAX_TX_BYTES) {
    throw new Error(`assembled transaction exceeds the on-chain ${MAX_TX_BYTES}-byte limit (${size} bytes) — compress accounts via an ALT or split the payload`);
  }
  return { nonceBlockhash, instructions, wireSizeBytes: size };
}

/**
 * Offline (air-gapped) signing. Accepts a 32-byte Ed25519 seed — the ONLY
 * secret in the pipeline — signs the serialized payload, scrubs the seed
 * Buffer, and returns { signature, publicKey } with zero secret material.
 */
function signOffline(payload, seed32) {
  if (!Buffer.isBuffer(payload)) {
    throw new Error("payload must be a Buffer (serialize your transaction before handing it to the air-gapped signer)");
  }
  if (!Buffer.isBuffer(seed32) || seed32.length !== 32) {
    throw new Error("ed25519 signing seed must be exactly 32 bytes");
  }
  const keypair = ed25519KeypairFromSeed(seed32);
  try {
    const signature = crypto.sign(null, payload, keypair.privateKey);
    if (signature.length !== 64) throw new Error("ed25519 signature must be 64 bytes");
    // RFC 8032 determinism — sign twice, byte-identical, then scrub.
    const signature2 = crypto.sign(null, payload, keypair.privateKey);
    if (!signature2.equals(signature)) {
      throw new Error("NON-DETERMINISTIC SIGNATURE DETECTED — the RNG-nonce reuse class exists in this signer; refusing to emit");
    }
    return {
      signature,
      signatureBase58: base58Encode(signature),
      publicKeyBase58: base58Encode(keypair.publicKey),
      payloadSha256: crypto.createHash("sha256").update(payload).digest("hex"),
    };
  } finally {
    secureZero(seed32);
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Verify an offline signature against the payload and a public key.
 *  crypto.verify needs a KeyObject — raw 32-byte keys are wrapped in SPKI. */
function verifySignature(payload, signature, publicKey32) {
  const raw = typeof publicKey32 === "string" ? base58Decode(publicKey32) : Buffer.from(publicKey32);
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const sig = signature instanceof Buffer ? signature : Buffer.from(signature);
  return crypto.verify(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), publicKey, sig);
}

/** Nonce account state parsed from on-chain wire bytes.
 *  Layout: [u32 state][32-byte authority][32-byte nonce hash][u64 fee] */
function parseNonceAccountData(data) {
  if (!Buffer.isBuffer(data) || data.length < 4 + 32 + 32 + 8) {
    throw new Error("nonce account data must carry at least [u32 state][32 authority][32 hash][u64 fee]");
  }
  const state = data.readUInt32LE(0);
  const states = { 0: "uninitialized", 1: "initialized", 2: "loaded" };
  if (states[state] === undefined) {
    throw new Error(`unknown nonce account state ${state}`);
  }
  return {
    state: states[state],
    authority: base58Encode(data.subarray(4, 36)),
    nonceBlockhash: base58Encode(data.subarray(36, 68)),
    lamportsPerSignature: data.readBigUInt64LE(68).toString(),
  };
}

module.exports = {
  SYSTEM_PROGRAM_ID,
  RECENT_BLOCKHASHES_SYSVAR,
  ADVANCE_NONCE_TAG,
  MAX_TX_BYTES,
  buildAdvanceNonceInstruction,
  buildDurableTransaction,
  signOffline,
  verifySignature,
  parseNonceAccountData,
};

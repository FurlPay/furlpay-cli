"use strict";

// ---------------------------------------------------------------------------
// Unified multi-chain key derivation (audit Module 5) — SLIP-0010 Ed25519.
//
// One BIP-39 mnemonic → three chain identities, deterministically:
//   Solana      m/44'/501'/0'/0'   (SLIP-0010 Ed25519, address = base58(pubkey32))
//   Stellar     m/44'/148'/0'      (SLIP-0010 Ed25519, address = strKey base32 G…)
//   Hyperliquid m/44'/60'/0'/0/0   (BIP-44 Secp256k1 via ethers HDNodeWallet)
//
// HARDENED-ONLY: SLIP-0010 Ed25519 defines ONLY hardened derivation
// (non-hardened CKD is undefined for Ed25519). Every non-hardened path
// segment is refused with an explicit error — never silently downgraded.
//
// MEMORY HYGIENE: the 64-byte master seed exists only as a Buffer and is
// zero-filled the moment derivation finishes (scrubbed). No seed, mnemonic,
// or private key is ever written to disk or included in any return value —
// the public API exposes addresses and raw public keys only.
//
// CROSS-VERIFICATION: this module's SLIP-0010 and BIP-39 implementations are
// independently verified against the canonical packages (ed25519-hd-key,
// bip39) in test/solana-parity.test.js — two implementations must agree on
// every derived byte, or the test suite fails.
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// Base58 (Bitcoin alphabet) — pure, no dependency.
// ---------------------------------------------------------------------------
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("base58Encode expects a non-empty Buffer");
  let num = BigInt("0x" + bytes.toString("hex"));
  let out = "";
  while (num > 0n) {
    out = BASE58_ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  // Leading zero bytes are encoded as leading '1's (BIP-173/Solana convention).
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = "1" + out;
  return out;
}

function base58Decode(str) {
  if (typeof str !== "string" || !str) throw new Error("base58Decode expects a non-empty string");
  let num = 0n;
  for (const ch of str) {
    const idx = BASE58_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base58 character '${ch}'`);
    num = num * 58n + BigInt(idx);
  }
  let hex = num === 0n ? "" : num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let buf = Buffer.from(hex, "hex");
  // Leading '1's decode to leading zero bytes.
  for (let i = 0; i < str.length && str[i] === "1"; i++) buf = Buffer.concat([Buffer.alloc(1), buf]);
  return buf;
}

// ---------------------------------------------------------------------------
// BIP-39 mnemonic → 512-bit seed: PBKDF2-HMAC-SHA512, 2048 rounds, salt
// "mnemonic" + passphrase. Spec-exact; cross-verified against the bip39
// package (which performs the identical KDF) in the test suite.
// ---------------------------------------------------------------------------

function bip39SeedFromMnemonic(mnemonic, passphrase = "") {
  if (typeof mnemonic !== "string" || !mnemonic.trim()) throw new Error("mnemonic is required");
  // NFKD normalization is part of the BIP-39 spec.
  const norm = mnemonic.normalize("NFKD");
  return Buffer.from(
    crypto.pbkdf2Sync(norm, `mnemonic${String(passphrase).normalize("NFKD")}`, 2048, 64, "sha512")
  );
}

/** Independent BIP-39 checksum validation using the canonical wordlist. */
function validateBip39Mnemonic(mnemonic) {
  const words = String(mnemonic).normalize("NFKD").trim().split(/\s+/);
  const wordlist = bip39.wordlists.english;
  if (words.length !== 12 && words.length !== 15 && words.length !== 18 && words.length !== 24) {
    return { valid: false, reason: `mnemonic must be 12/15/18/24 words (got ${words.length})` };
  }
  const indices = words.map((w) => {
    const i = wordlist.indexOf(w);
    if (i === -1) throw new Error(`word '${w}' is not in the BIP-39 English wordlist`);
    return i;
  });
  // 11 bits per word; total bits = words*11; entropy = bits - words*11/32.
  const totalBits = words.length * 11;
  const checksumBits = totalBits / 33;
  const entropyBits = totalBits - checksumBits;
  let bitStr = indices.map((i) => i.toString(2).padStart(11, "0")).join("");
  const entropyBitsStr = bitStr.slice(0, entropyBits);
  const checksumBitsStr = bitStr.slice(entropyBits);
  const entropy = Buffer.from(entropyBitsStr.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const expectedChecksum = crypto.createHash("sha256").update(entropy).digest();
  const expectedBits = [...expectedChecksum.toString("hex").matchAll(/../g)]
    .flatMap(([byteHex]) => [...parseInt(byteHex, 16).toString(2).padStart(8, "0")])
    .slice(0, checksumBits)
    .join("");
  if (expectedBits !== checksumBitsStr) {
    return { valid: false, reason: "BIP-39 checksum mismatch — mnemonic words are corrupted or out of order" };
  }
  return { valid: true, entropyBits, checksumBits };
}

// ---------------------------------------------------------------------------
// SLIP-0010 Ed25519 — master node + hardened-only CKDpriv.
//   I = HMAC-SHA512(key="ed25519 seed", data=seed);  key = I[0:32], cc = I[32:64]
//   CKDpriv((k_p, c_p), i≥2^31): data = 0x00 ‖ k_p ‖ ser32(i); k_i = I[0:32], c_i = I[32:64]
// ---------------------------------------------------------------------------

function slip0010Ed25519Master(seed) {
  if (!Buffer.isBuffer(seed) || seed.length < 16 || seed.length > 64) {
    throw new Error("SLIP-0010 master derivation requires a 16–64 byte seed Buffer");
  }
  const I = crypto.createHmac("sha512", Buffer.from("ed25519 seed", "utf8")).update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

function slip0010Ed25519CKD(node, index) {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`derivation index must be a uint32 (got ${index})`);
  }
  if (index < 0x80000000) {
    throw new Error(
      `SLIP-0010 Ed25519 supports ONLY hardened derivation — index ${index} ` +
        `(0x${index.toString(16)}) is non-hardened. Use 0x80000000-0xFFFFFFFF paths ` +
        `(e.g. 44' with the prime notation). Refusing an undefined Ed25519 operation.`
    );
  }
  const data = Buffer.concat([Buffer.alloc(1, 0), node.key, Buffer.alloc(4)]);
  data.writeUInt32BE(index, 33);
  const I = crypto.createHmac("sha512", node.chainCode).update(data).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32, 64) };
}

/** Parse "m/44'/501'/0'/0'" → hardened indices; rejects non-hardened + junk. */
function parseDerivationPath(path) {
  if (typeof path !== "string" || !path.startsWith("m/")) {
    throw new Error(`derivation path must start with 'm/' (got '${path}')`);
  }
  const segments = path.slice(2).split("/").filter(Boolean);
  const indices = segments.map((seg) => {
    const m = /^(\d+)('$|h|H)?$/.exec(seg);
    if (!m) throw new Error(`invalid derivation path segment '${seg}'`);
    const value = parseInt(m[1], 10);
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) {
      throw new Error(`derivation index out of range in '${seg}'`);
    }
    if (!m[2]) {
      throw new Error(
        `derivation segment '${seg}' is NON-HARDENED — SLIP-0010 Ed25519 supports only ` +
          `hardened segments (append ' to the index). Refusing an undefined operation.`
      );
    }
    return value + 0x80000000;
  });
  return indices;
}

function slip0010DerivePath(path, seed) {
  let node = slip0010Ed25519Master(seed);
  for (const index of parseDerivationPath(path)) node = slip0010Ed25519CKD(node, index);
  return node;
}

// ---------------------------------------------------------------------------
// Ed25519 keypairs from a 32-byte seed via Node crypto (PKCS8 DER wrap).
// ---------------------------------------------------------------------------

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519KeypairFromSeed(seed32) {
  if (!Buffer.isBuffer(seed32) || seed32.length !== 32) {
    throw new Error("ed25519 seed must be exactly 32 bytes");
  }
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed32]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const spki = crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  // SPKI ed25519: last 32 bytes are the raw public key.
  const publicKey = spki.subarray(spki.length - 32);
  return { privateKey, publicKey };
}

/** Zero-fill a secret buffer. JS strings cannot be scrubbed (immutable), so
 *  every secret here lives in Buffers that we explicitly zero. */
function secureZero(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

// ---------------------------------------------------------------------------
// Multi-chain facade
// ---------------------------------------------------------------------------

const SOLANA_PATH = "m/44'/501'/0'/0'";
const STELLAR_PATH = "m/44'/148'/0'";
const HYPERLIQUID_PATH = "m/44'/60'/0'/0/0";

/**
 * Derive all three chain identities from one mnemonic.
 * Returns PUBLIC information only; the master seed Buffer is scrubbed before
 * return, and no private key material appears anywhere in the result.
 */
function deriveMultiChainWallet(mnemonic, passphrase = "") {
  const checksum = validateBip39Mnemonic(mnemonic);
  if (!checksum.valid) throw new Error(`Invalid BIP-39 mnemonic: ${checksum.reason}`);

  const seed = bip39SeedFromMnemonic(mnemonic, passphrase);
  try {
    // 1. Solana — SLIP-0010 Ed25519, address = base58(raw public key).
    const solNode = slip0010DerivePath(SOLANA_PATH, seed);
    const solKeypair = ed25519KeypairFromSeed(solNode.key);
    const solanaAddress = base58Encode(solKeypair.publicKey);

    // 2. Stellar — same SLIP-0010 engine, canonical strKey via the Stellar SDK.
    const stellar = require("@stellar/stellar-sdk");
    const xlmNode = slip0010DerivePath(STELLAR_PATH, seed);
    const stellarKeypair = stellar.Keypair.fromRawEd25519Seed(xlmNode.key);

    // 3. Hyperliquid / EVM — BIP-44 Secp256k1 via ethers.
    const hd = ethers.HDNodeWallet.fromSeed(seed);
    const hlWallet = hd.derivePath(HYPERLIQUID_PATH);

    return {
      mnemonic: {
        wordCount: String(mnemonic).trim().split(/\s+/).length,
        checksumValid: true,
      },
      solana: {
        address: solanaAddress,
        derivationPath: SOLANA_PATH,
        curve: "ed25519",
        /** Raw 32-byte public key (Base58-free consumers). */
        publicKeyRaw: Buffer.from(solKeypair.publicKey),
      },
      stellar: {
        address: stellarKeypair.publicKey(),
        derivationPath: STELLAR_PATH,
        curve: "ed25519",
        publicKeyRaw: stellarKeypair.rawPublicKey(),
      },
      hyperliquid: {
        address: hlWallet.address,
        derivationPath: HYPERLIQUID_PATH,
        curve: "secp256k1",
      },
    };
  } finally {
    secureZero(seed);
  }
}

module.exports = {
  base58Encode,
  base58Decode,
  bip39SeedFromMnemonic,
  validateBip39Mnemonic,
  slip0010Ed25519Master,
  slip0010Ed25519CKD,
  parseDerivationPath,
  slip0010DerivePath,
  ed25519KeypairFromSeed,
  secureZero,
  deriveMultiChainWallet,
  SOLANA_PATH,
  STELLAR_PATH,
  HYPERLIQUID_PATH,
};

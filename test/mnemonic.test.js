"use strict";

// Regression tests for mnemonic import.
//
// Bug being pinned: `wallet import` used to IGNORE the user's key entirely
// (importing a generated random key under a hardcoded password) and
// importMnemonic displayed a random public key unrelated to the words the
// user backed up. These tests force the derivation to be the standard
// BIP39 -> SLIP-0010 ed25519 -> Stellar m/44'/148'/0' path and force the
// keystore entry to display THAT key.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Keystore writes go to ~/.furlpay — redirect before the first require.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-cli-mnemonic-test-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;

const { mnemonicToSeed, validateMnemonic, slip0010Ed25519PrivateKey, keypairFromMnemonic } = require("../dist/wallet/mnemonic");
const { KeystoreService } = require("../dist/wallet/keystore");

const CANONICAL_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("mnemonic validation (BIP39 checksum)", () => {
  it("accepts the canonical 12-word test vector", () => {
    assert.deepEqual(validateMnemonic(CANONICAL_12), { valid: true });
  });

  it("rejects a single mistyped word (checksum fails closed)", () => {
    const corrupted = CANONICAL_12.replace("about", "above");
    const result = validateMnemonic(corrupted);
    assert.equal(result.valid, false);
    assert.match(result.reason, /checksum/);
  });

  it("rejects wrong word counts and unknown words", () => {
    assert.equal(validateMnemonic("abandon").valid, false);
    assert.equal(validateMnemonic(`${CANONICAL_12} abandon abandon`).valid, false);
    assert.equal(validateMnemonic("notaword ".repeat(12)).valid, false);
  });
});

describe("SLIP-0010 ed25519 derivation", () => {
  // Test vector 1 from the SLIP-0010 specification (ed25519, seed
  // 000102030405060708090a0b0c0d0e0f) — verified against the published table.
  it("matches the SLIP-0010 spec vector for the master key", () => {
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const prv = slip0010Ed25519PrivateKey(seed, "m");
    assert.equal(
      prv.toString("hex"),
      "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"
    );
  });

  it("matches the SLIP-0010 spec vector for m/0'", () => {
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const prv = slip0010Ed25519PrivateKey(seed, "m/0'");
    assert.equal(
      prv.toString("hex"),
      "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"
    );
  });

  it("matches the SLIP-0010 spec vector for m/0'/1'", () => {
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    const prv = slip0010Ed25519PrivateKey(seed, "m/0'/1'");
    assert.equal(
      prv.toString("hex"),
      "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2"
    );
  });

  it("refuses non-hardened paths (ed25519 supports hardened only)", () => {
    const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
    assert.throws(() => slip0010Ed25519PrivateKey(seed, "m/0/1"), /hardened/);
  });
});

describe("mnemonic -> Stellar keypair", () => {
  it("is deterministic and consistent with the raw derivation", () => {
    const a = keypairFromMnemonic(CANONICAL_12);
    const b = keypairFromMnemonic(CANONICAL_12);
    assert.equal(a.publicKey(), b.publicKey());

    const seed = mnemonicToSeed(CANONICAL_12);
    const raw = slip0010Ed25519PrivateKey(seed, "m/44'/148'/0'");
    assert.equal(a.publicKey(), require("@stellar/stellar-sdk").Keypair.fromRawEd25519Seed(raw).publicKey());
  });

  it("a different account index derives a different key", () => {
    const zero = keypairFromMnemonic(CANONICAL_12, "", 0);
    const one = keypairFromMnemonic(CANONICAL_12, "", 1);
    assert.notEqual(zero.publicKey(), one.publicKey());
  });
});

describe("keystore mnemonic import shows the derived key", () => {
  it("stored publicKey equals the keypair the mnemonic controls", () => {
    const keystore = new KeystoreService(path.join(TEST_HOME, "keystore.enc"));
    const entry = keystore.importMnemonic("primary", CANONICAL_12, "test-password-123");
    const expected = keypairFromMnemonic(CANONICAL_12).publicKey();
    assert.equal(entry.publicKey, expected, "displayed key must be the mnemonic's key, not a random one");

    const roundTrip = keystore.getKey("primary", "test-password-123");
    assert.equal(roundTrip.type, "mnemonic");
    assert.equal(roundTrip.secret, CANONICAL_12, "decrypted payload returns the original words");
  });
});

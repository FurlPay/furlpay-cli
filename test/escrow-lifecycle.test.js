/**
 * Escrow lifecycle tests — covers the P1 #5 gap where the CLI advertised
 * `escrow fund|proof|release|dispute` but only `create` was wired.
 *
 * All tests are offline: the escrow ledger is a local state machine plus a
 * durable JSON store; no network and no on-chain calls are involved, and the
 * CLI refuses tx-hash-less fund/release so no transaction can be fabricated.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ethers } = require("ethers");

const {
  EscrowStateMachine,
  EscrowStore,
  deliveryProofSigningMessage,
  sanitizeTerminal,
} = require("../dist/index");

function makeTerms(overrides = {}) {
  return {
    escrowId: "escrow_test_" + Math.random().toString(16).slice(2, 8),
    buyer: "0x1111111111111111111111111111111111111111",
    seller: "0x2222222222222222222222222222222222222222",
    arbiter: "0x3333333333333333333333333333333333333333",
    amount: "5000.00",
    token: "USDC",
    network: "arbitrum",
    expiryTimestamp: Math.floor(Date.now() / 1000) + 7 * 86400,
    autoReleaseSeconds: 3600,
    deliverySpecHash: "0x" + "2c".repeat(32),
    ...overrides,
  };
}

function tempStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-escrow-test-"));
  return path.join(dir, "escrows.json");
}

// Proofs must now carry the seller's real signature over the canonical
// escrow message (audit P6) — the old "sig-test"/sim: strings are refused.
function makeSellerSigner() {
  return ethers.Wallet.createRandom();
}

async function signProof(machine, sellerWallet, terms) {
  const proofHash = terms.deliverySpecHash;
  const signature = await sellerWallet.signMessage(
    deliveryProofSigningMessage(machine.getEscrowId(), proofHash)
  );
  return { proofHash, signature, submittedAt: 0 };
}

test("escrow: serialize/deserialize round-trip preserves state and audit log", async () => {
  const sellerWallet = makeSellerSigner();
  const terms = makeTerms({ seller: sellerWallet.address });
  const sm = new EscrowStateMachine(terms);
  sm.fund(terms.buyer, "0xfund_tx_1");
  sm.submitProof(terms.seller, await signProof(sm, sellerWallet, terms));

  const snapshot = sm.serialize();
  assert.strictEqual(snapshot.schema, "furlpay-escrow-v1");

  const restored = EscrowStateMachine.deserialize(JSON.parse(JSON.stringify(snapshot)));
  assert.strictEqual(restored.getState(), "PROOF_SUBMITTED");
  assert.strictEqual(restored.getAuditLog().length, sm.getAuditLog().length);
  assert.strictEqual(restored.getEscrowId(), sm.getEscrowId());
  assert.deepStrictEqual(restored.getDeliveryProof(), sm.getDeliveryProof());
});

test("escrow: deserialize rejects unknown schema and invalid state", () => {
  assert.throws(() => EscrowStateMachine.deserialize({ schema: "nope" }), /unrecognized or missing schema/);
  const snapshot = new EscrowStateMachine(makeTerms()).serialize();
  assert.throws(
    () => EscrowStateMachine.deserialize({ ...snapshot, state: "TELEPORTED" }),
    /unknown state/
  );
});

test("escrow store: persists across instances in a durable JSON file", () => {
  const storePath = tempStorePath();
  const store1 = new EscrowStore(storePath);
  const terms = makeTerms();
  const sm = new EscrowStateMachine(terms);
  store1.save(sm);

  // A second store instance (next CLI invocation) must see the same escrow.
  const store2 = new EscrowStore(storePath);
  const loaded = store2.loadMachine(terms.escrowId);
  assert.strictEqual(loaded.getState(), "CREATED");
  assert.strictEqual(loaded.getTerms().amount, "5000.00");
  assert.strictEqual(store2.list().length, 1);
});

test("escrow store: full happy-path lifecycle create→fund→proof→release", async () => {
  const store = new EscrowStore(tempStorePath());
  const sellerWallet = makeSellerSigner();
  const terms = makeTerms({ seller: sellerWallet.address });

  let sm = new EscrowStateMachine(terms);
  store.save(sm);

  const buyer = terms.buyer;
  sm = store.loadMachine(terms.escrowId);
  sm.fund(buyer, "0x" + "f".repeat(64));
  store.save(sm);

  sm = store.loadMachine(terms.escrowId);
  assert.strictEqual(sm.getState(), "FUNDED");
  sm.submitProof(terms.seller, await signProof(sm, sellerWallet, terms));
  store.save(sm);

  sm = store.loadMachine(terms.escrowId);
  sm.release(buyer, "0x" + "e".repeat(64));
  store.save(sm);

  const final = store.loadMachine(terms.escrowId);
  assert.strictEqual(final.getState(), "RELEASED");
  const log = final.getAuditLog();
  assert.deepStrictEqual(
    log.map((r) => r.toState),
    ["FUNDED", "PROOF_SUBMITTED", "RELEASED"]
  );
});

test("escrow store: dispute path records DISPUTED state", () => {
  const store = new EscrowStore(tempStorePath());
  const terms = makeTerms();
  const sm = new EscrowStateMachine(terms);
  sm.fund(terms.buyer, "0x" + "1".repeat(64));
  store.save(sm);

  const reloaded = store.loadMachine(terms.escrowId);
  reloaded.dispute(terms.seller, "delivery never arrived");
  store.save(reloaded);

  assert.strictEqual(store.loadMachine(terms.escrowId).getState(), "DISPUTED");
});

test("escrow state machine: unauthorized actors and bad proofs fail closed", async () => {
  const sellerWallet = makeSellerSigner();
  const terms = makeTerms({ seller: sellerWallet.address });
  const sm = new EscrowStateMachine(terms);

  assert.throws(() => sm.fund(terms.seller, "0xaa"), /Only buyer/);
  sm.fund(terms.buyer, "0x" + "f".repeat(64));
  assert.throws(() => sm.fund(terms.buyer, "0xbb"), /Invalid state transition/);
  assert.throws(
    () => sm.submitProof(terms.seller, { proofHash: "not-a-hash", signature: "sig" }),
    /32-byte hex/
  );
  assert.throws(() => sm.submitProof(terms.buyer, { proofHash: terms.deliverySpecHash, signature: "s" }), /Only seller/);
  // Legacy attestation strings and unsigned proofs are refused outright (P6).
  assert.throws(
    () => sm.submitProof(terms.seller, { proofHash: terms.deliverySpecHash, signature: "sim:local-cli-attestation:123", submittedAt: 0 }),
    /recovery failed|Invalid delivery proof signature/
  );
  // Wrong deliverable hash (even properly seller-signed) is refused.
  const wrongHash = "0x" + "ab".repeat(32);
  const wrongHashSig = await sellerWallet.signMessage(
    deliveryProofSigningMessage(sm.getEscrowId(), wrongHash)
  );
  assert.throws(
    () =>
      sm.submitProof(terms.seller, {
        proofHash: wrongHash,
        signature: wrongHashSig,
        submittedAt: 0,
      }),
    /Proof hash mismatch/
  );
  assert.throws(() => sm.dispute("0x9999999999999999999999999999999999999999", "nope"), /counterparties/);
});

test("escrow store: unknown id and corrupt store fail loudly", () => {
  const store = new EscrowStore(tempStorePath());
  assert.throws(() => store.loadMachine("escrow_missing"), /not found/);

  const storePath = tempStorePath();
  fs.writeFileSync(storePath, "{not json");
  const corrupt = new EscrowStore(storePath);
  assert.throws(() => corrupt.list(), /corrupt/);

  const wrongShape = tempStorePath();
  fs.writeFileSync(wrongShape, JSON.stringify({ hello: "world" }));
  assert.throws(() => new EscrowStore(wrongShape).list(), /unrecognized format/);
});

test("escrow store: refuses a symlinked store file (A-3 hardening pattern)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-escrow-symlink-"));
  const storePath = path.join(dir, "escrows.json");
  const victim = path.join(dir, "victim.txt");
  fs.writeFileSync(victim, "do not touch");
  try {
    fs.symlinkSync(victim, storePath);
  } catch (err) {
    if (err.code === "EPERM") return; // Windows without symlink privilege
    throw err;
  }
  const store = new EscrowStore(storePath);
  const sm = new EscrowStateMachine(makeTerms());
  assert.throws(() => store.save(sm), /symlink/);
  // The symlink target must be untouched.
  assert.strictEqual(fs.readFileSync(victim, "utf8"), "do not touch");
});

test("sanitizeTerminal: strips escape sequences, control chars, and line spoofing", () => {
  assert.strictEqual(sanitizeTerminal("\x1b[31mred\x1b[0m"), "red");
  assert.strictEqual(sanitizeTerminal("\x1b]0;title\x07ok"), "ok");
  assert.strictEqual(sanitizeTerminal("a\rb\nc\td"), "a b c d");
  assert.strictEqual(sanitizeTerminal("safe\u202Emirrored"), "safemirrored");
  assert.strictEqual(sanitizeTerminal(null), "");
  assert.strictEqual(sanitizeTerminal("plain"), "plain");
});

// ── External audit 2026-11-17b C-01 ─────────────────────────────────────
test("audit C-01: an EXPIRED escrow still deserializes — the refund path is never bricked", () => {
  // An escrow created with a short expiry that has since lapsed. Its whole
  // purpose post-expiry is refund: it MUST load from disk.
  const terms = makeTerms({ expiryTimestamp: Math.floor(Date.now() / 1000) - 3600 });
  // Creation with a past expiry stays refused (that is correct behavior).
  assert.throws(() => new EscrowStateMachine(terms), /Expiry timestamp must be in the future/);

  // But a snapshot of an escrow that expired AFTER creation must rehydrate:
  // simulate by snapshotting a live machine, then rewinding its expiry.
  const live = new EscrowStateMachine(makeTerms());
  live.fund(makeTerms().buyer, "0xfund_tx_c01");
  const snapshot = live.serialize();
  const expiredSnapshot = {
    ...snapshot,
    terms: { ...snapshot.terms, expiryTimestamp: Math.floor(Date.now() / 1000) - 60 },
  };
  const restored = EscrowStateMachine.deserialize(expiredSnapshot);
  assert.strictEqual(restored.getState(), "FUNDED");
  // And the refund transition itself is reachable on the restored machine.
  restored.triggerRefund(restored.getTerms ? restored.getTerms().arbiter : expiredSnapshot.terms.arbiter);
  assert.strictEqual(restored.getState(), "REFUND_PENDING");
});

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

const {
  EscrowStateMachine,
  EscrowStore,
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

test("escrow: serialize/deserialize round-trip preserves state and audit log", () => {
  const sm = new EscrowStateMachine(makeTerms());
  sm.fund(makeTerms().buyer, "0xfund_tx_1");
  sm.submitProof(makeTerms().seller, {
    proofHash: "0x" + "ab".repeat(32),
    signature: "sig-test",
    submittedAt: Math.floor(Date.now() / 1000),
  });

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

test("escrow store: full happy-path lifecycle create→fund→proof→release", () => {
  const store = new EscrowStore(tempStorePath());
  const terms = makeTerms();

  let sm = new EscrowStateMachine(terms);
  store.save(sm);

  const buyer = terms.buyer;
  sm = store.loadMachine(terms.escrowId);
  sm.fund(buyer, "0x" + "f".repeat(64));
  store.save(sm);

  sm = store.loadMachine(terms.escrowId);
  assert.strictEqual(sm.getState(), "FUNDED");
  sm.submitProof(terms.seller, {
    proofHash: "0x" + "ab".repeat(32),
    signature: "sim:local-cli-attestation:123",
    submittedAt: Math.floor(Date.now() / 1000),
  });
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

test("escrow state machine: unauthorized actors and bad proofs fail closed", () => {
  const terms = makeTerms();
  const sm = new EscrowStateMachine(terms);

  assert.throws(() => sm.fund(terms.seller, "0xaa"), /Only buyer/);
  sm.fund(terms.buyer, "0x" + "f".repeat(64));
  assert.throws(() => sm.fund(terms.buyer, "0xbb"), /Invalid state transition/);
  assert.throws(
    () => sm.submitProof(terms.seller, { proofHash: "not-a-hash", signature: "sig" }),
    /32-byte hex/
  );
  assert.throws(() => sm.submitProof(terms.buyer, { proofHash: "0x" + "ab".repeat(32), signature: "s" }), /Only seller/);
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

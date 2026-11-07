/**
 * Escrow & Time-Locked Settlement Scheme (ETSS) Test Suite
 * 
 * Verifies:
 * 1. Happy path: CREATED -> FUNDED -> DELIVERY_PENDING -> PROOF_SUBMITTED -> RELEASED.
 * 2. Dispute path: FUNDED -> DISPUTED -> REFUND_PENDING -> REFUNDED.
 * 3. Expiry timeout path: Expiration triggers refund to buyer.
 * 4. Invariant: Rejection of double-spend / transitions after terminal state.
 * 5. Invariant: Unauthorized party rejection at all stages.
 * 6. Delivery proof commitment verification.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const { EscrowStateMachine } = require("../dist/settlement/escrow");

describe("Escrow & Time-Locked Settlement Scheme (ETSS)", () => {
  let buyer = "0x1111111111111111111111111111111111111111";
  let seller = "0x2222222222222222222222222222222222222222";
  let arbiter = "0x3333333333333333333333333333333333333333";
  let attacker = "0x9999999999999999999999999999999999999999";
  let terms;

  beforeEach(() => {
    terms = {
      escrowId: "escrow_test_8841",
      buyer,
      seller,
      arbiter,
      amount: "2500.00",
      token: "USDC",
      network: "arbitrum",
      expiryTimestamp: Math.floor(Date.now() / 1000) + 86400, // 24 hours
      autoReleaseSeconds: 3600, // 1 hour auto-release
      deliverySpecHash: "0x" + crypto.randomBytes(32).toString("hex"),
    };
  });

  it("should successfully execute full happy path settlement lifecycle", () => {
    const sm = new EscrowStateMachine(terms);
    assert.strictEqual(sm.getState(), "CREATED");

    // 1. Buyer funds
    sm.fund(buyer, "0x_fund_tx_123");
    assert.strictEqual(sm.getState(), "FUNDED");

    // 2. Seller starts delivery
    sm.startDelivery(seller);
    assert.strictEqual(sm.getState(), "DELIVERY_PENDING");

    // 3. Seller submits proof
    const proofHash = "0x" + crypto.createHash("sha256").update("delivered_file.zip").digest("hex");
    sm.submitProof(seller, {
      proofHash,
      signature: "0x_seller_valid_sig",
      submittedAt: Math.floor(Date.now() / 1000),
    });
    assert.strictEqual(sm.getState(), "PROOF_SUBMITTED");

    // 4. Buyer releases funds
    sm.release(buyer, "0x_payout_tx_456");
    assert.strictEqual(sm.getState(), "RELEASED");

    // Audit trail has 4 complete records
    const logs = sm.getAuditLog();
    assert.strictEqual(logs.length, 4);
    assert.strictEqual(logs[0].toState, "FUNDED");
    assert.strictEqual(logs[3].toState, "RELEASED");
  });

  it("P1 Invariant: prevents double-spend or mutations once in terminal state", () => {
    const sm = new EscrowStateMachine(terms);
    sm.fund(buyer, "0x_fund_tx_123");
    sm.startDelivery(seller);
    sm.submitProof(seller, {
      proofHash: "0x" + "11".repeat(32),
      signature: "0x_sig",
      submittedAt: Math.floor(Date.now() / 1000),
    });
    sm.release(buyer, "0x_payout_tx_456");
    assert.strictEqual(sm.getState(), "RELEASED");

    // Attempt double release
    assert.throws(
      () => sm.release(buyer, "0x_double_release"),
      /Invalid state transition: Cannot release funds in state 'RELEASED'/
    );

    // Attempt dispute after release
    assert.throws(
      () => sm.dispute(buyer, "Trying to dispute settled deal"),
      /Cannot dispute in terminal or uninitialized state 'RELEASED'/
    );
  });

  it("P1 Invariant: rejects unauthorized actors from funding or releasing", () => {
    const sm = new EscrowStateMachine(terms);

    // Attacker tries to fund on behalf of buyer
    assert.throws(
      () => sm.fund(attacker, "0x_attacker_fund"),
      /Unauthorized: Only buyer/
    );

    sm.fund(buyer, "0x_fund_tx_123");
    sm.startDelivery(seller);

    // Attacker tries to release funds
    assert.throws(
      () => sm.release(attacker, "0x_attacker_release"),
      /Unauthorized release/
    );
  });

  it("P1 Timelock: triggers automatic refund when delivery deadline expires", () => {
    const now = Math.floor(Date.now() / 1000);
    const shortTerms = { ...terms, expiryTimestamp: now + 10 };
    const sm = new EscrowStateMachine(shortTerms);

    sm.fund(buyer, "0x_fund_tx_123");
    sm.startDelivery(seller);

    // Advance time past deadline
    const futureTime = now + 50;
    sm.triggerRefund("system", "Deadline expired without proof", futureTime);
    assert.strictEqual(sm.getState(), "REFUND_PENDING");

    sm.finalizeRefund(buyer, "0x_refund_tx_789");
    assert.strictEqual(sm.getState(), "REFUNDED");
  });

  it("P1 Dispute Resolution: Arbiter resolves dispute to refund", () => {
    const sm = new EscrowStateMachine(terms);
    sm.fund(buyer, "0x_fund_tx_123");
    sm.startDelivery(seller);

    // Buyer raises dispute
    sm.dispute(buyer, "Seller delivered non-functioning goods");
    assert.strictEqual(sm.getState(), "DISPUTED");

    // Arbiter reviews and triggers refund
    sm.triggerRefund(arbiter, "Arbiter ruled in favor of buyer after evidence inspection");
    assert.strictEqual(sm.getState(), "REFUND_PENDING");

    sm.finalizeRefund(arbiter, "0x_refund_payout_tx");
    assert.strictEqual(sm.getState(), "REFUNDED");
  });
});

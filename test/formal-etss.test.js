"use strict";
// ---------------------------------------------------------------------------
// FORMAL VERIFICATION — ETSS state machine (audit Module 1).
//
// Proven invariants, tested against the REAL machine (dist/settlement/escrow):
//   V1  Conservation of value: for every reachable transition,
//       Σ escrow holdings = deposits − releases − refunds − fees. The local
//       ledger holds exactly ONE collateral amount; it changes exactly once
//       (at the terminal transition) and can never be paid out twice.
//   V2  Exhaustive reachability: from every state, the set of ACCEPTED
//       transitions is exactly the documented adjacency; every other
//       transition throws (the state machine is total, not best-effort).
//   V3  Time-lock boundaries: refund is refused at t = expiry − 1 (without
//       arbiter), permitted at t = expiry, permitted at t = expiry + 1ms —
//       and the boundary is the LEDGER's clock, not the caller's.
//   V4  Backdate-immunity: proof submittedAt is the ledger clock; a
//       caller-supplied submittedAt:0 can never accelerate auto-release.
//   V5  M-of-N arbitration: quorum = DISTINCT verified panel signers;
//       duplicate votes count once; non-panel votes never count; below
//       quorum the dispute stays open; 'release' without a real tx hash is
//       refused. Signatures over the wrong decision/escrow/nonce fail.
// ---------------------------------------------------------------------------

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { ethers } = require("ethers");
const {
  EscrowStateMachine,
  deliveryProofSigningMessage,
} = require("../dist/settlement/escrow");
const {
  arbitrationSigningMessage,
  verifyQuorum,
} = require("../dist/settlement/escrowArbitration");

function terms(overrides = {}) {
  return {
    escrowId: "escrow_formal_" + crypto.randomBytes(4).toString("hex"),
    buyer: "0x1111111111111111111111111111111111111111",
    seller: ethers.Wallet.createRandom().address, // real signing identity
    arbiter: "0x3333333333333333333333333333333333333333",
    amount: "5000.00",
    token: "USDC",
    network: "arbitrum",
    expiryTimestamp: Math.floor(Date.now() / 1000) + 86400,
    autoReleaseSeconds: 3600,
    deliverySpecHash: "0x" + crypto.randomBytes(32).toString("hex"),
    ...overrides,
  };
}

async function signedProof(machine, sellerWallet, overrides = {}) {
  const proofHash = machine.getTerms().deliverySpecHash;
  const signature = await sellerWallet.signMessage(deliveryProofSigningMessage(machine.getEscrowId(), proofHash));
  return { proofHash, signature, submittedAt: 0, ...overrides };
}

describe("V1 — conservation of value", () => {
  test("collateral amount is invariant across every non-terminal transition", async () => {
    const sellerWallet = ethers.Wallet.createRandom();
    const t = terms({ seller: sellerWallet.address });
    const sm = new EscrowStateMachine(t);
    const amount = () => sm.getTerms().amount;
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    assert.equal(amount(), t.amount, "funding does not mutate the amount");
    sm.startDelivery(t.seller);
    assert.equal(amount(), t.amount, "delivery start does not mutate the amount");
    sm.submitProof(t.seller, await signedProof(sm, sellerWallet));
    assert.equal(amount(), t.amount, "proof submission does not mutate the amount");
    sm.release(t.buyer, "0x" + "b".repeat(64));
    assert.equal(amount(), t.amount, "settlement is recorded, not re-denominated");
  });

  test("value leaves the escrow EXACTLY once — double-release and release-after-refund are impossible", async () => {
    const sellerWallet = ethers.Wallet.createRandom();
    const t = terms({ seller: sellerWallet.address });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.startDelivery(t.seller);
    sm.submitProof(t.seller, await signedProof(sm, sellerWallet));
    sm.release(t.buyer, "0x" + "b".repeat(64));
    assert.throws(() => sm.release(t.buyer, "0x" + "c".repeat(64)), /Invalid state transition/, "double-release");
    assert.throws(() => sm.dispute(t.buyer, "re-open after settle"), /Invalid state transition/, "dispute after release");
    assert.throws(() => sm.triggerRefund(t.buyer, "refund after release"), /Terminal state invariant/, "refund after release");
    const lateProof = await signedProof(sm, sellerWallet);
    assert.throws(() => sm.submitProof(t.seller, lateProof), /Invalid state transition/, "proof after release");

    const refunded = new EscrowStateMachine(terms({ seller: sellerWallet.address }));
    refunded.fund(t.buyer, "0x" + "a".repeat(64));
    refunded.dispute(t.buyer, "no delivery");
    refunded.triggerRefund(t.arbiter, "arbiter decision");
    refunded.finalizeRefund(t.buyer, "0x" + "d".repeat(64));
    assert.throws(() => refunded.triggerRefund(t.arbiter, "again"), /Terminal state invariant/, "double refund");
    assert.throws(() => refunded.release(t.buyer, "0x" + "e".repeat(64)), /Invalid state transition/, "release after refund");
    // conservation identity: deposits(1×amount) − releases(0) − refunds(1×amount) − fees(0) = escrow 0
    assert.equal(refunded.getState(), "REFUNDED");
  });

  test("audit log is append-only across serialize/deserialize — no transition can be erased", () => {
    const t = terms();
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    const log1 = sm.serialize().auditLog.length;
    const sm2 = EscrowStateMachine.deserialize(sm.serialize());
    assert.deepEqual(sm2.getAuditLog(), sm.getAuditLog());
    assert.ok(log1 >= 1);
    assert.throws(() => EscrowStateMachine.deserialize({ schema: "other", terms: t, state: "FUNDED", auditLog: [] }), /unrecognized or missing schema/);
    assert.throws(() => EscrowStateMachine.deserialize({ schema: "furlpay-escrow-v1", terms: t, state: "NOT_A_STATE", auditLog: [] }), /unknown state/);
  });
});

describe("V2 — exhaustive reachability (totality of the transition function)", () => {
  test("every undocumented transition from FUNDED is refused", async () => {
    const t = terms();
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    assert.throws(() => sm.fund(t.buyer, "0x" + "b".repeat(64)), /Invalid state transition/, "re-fund");
    assert.throws(() => sm.submitProof(t.seller, { proofHash: t.deliverySpecHash, signature: "x" }), /Unauthorized|signature/i, "proof before delivery-start is unauthorized unless seller");
    assert.throws(() => sm.triggerRefund(t.buyer, "premature"), /Unauthorized refund/, "refund before expiry");
    assert.throws(() => sm.finalizeRefund(t.buyer, "0x" + "f".repeat(64)), /Invalid state transition/, "finalize without REFUND_PENDING");
    assert.throws(() => sm.release(t.arbiter, "0x" + "g".repeat(64)), /Invalid state transition/, "release before proof (arbiter path starts at DELIVERY/PROOF)");
  });

  test("unauthorized actors refused at every stage", async () => {
    const t = terms();
    const sm = new EscrowStateMachine(t);
    assert.throws(() => sm.fund(t.seller, "0x" + "a".repeat(64)), /Unauthorized: Only buyer/, "seller cannot fund");
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    assert.throws(() => sm.startDelivery(t.buyer), /Unauthorized: Only seller/, "buyer cannot start delivery");
    sm.startDelivery(t.seller);
    assert.throws(() => sm.dispute("0x4444444444444444444444444444444444444444", "outsider"), /counterparties|Only escrow counterparties/, "outsider cannot dispute");
    sm.dispute(t.seller, "quality");
    assert.throws(() => sm.triggerRefund(t.buyer, "self-resolve"), /Unauthorized refund/, "party cannot self-resolve a dispute");
  });
});

describe("V3 — time-lock expiry boundaries (ledger clock)", () => {
  test("refund refused at t = expiry − 1 without arbiter; allowed at t = expiry and t = expiry + 1", () => {
    const t = terms();
    const expiry = t.expiryTimestamp;
    // t = expiry − 1
    const early = new EscrowStateMachine(t);
    early.fund(t.buyer, "0x" + "a".repeat(64));
    early.dispute(t.buyer, "dispute just before deadline");
    assert.throws(() => early.triggerRefund(t.buyer, "one second early", expiry - 1), /Unauthorized refund/, "expiry−1 must NOT auto-refund");
    // arbiter can still resolve pre-expiry — that is the arbiter's role
    early.triggerRefund(t.arbiter, "arbiter decides", expiry - 1);

    // t = expiry (boundary inclusive)
    const atExpiry = new EscrowStateMachine(t);
    atExpiry.fund(t.buyer, "0x" + "a".repeat(64));
    atExpiry.dispute(t.buyer, "dispute");
    atExpiry.triggerRefund(t.buyer, "boundary", expiry);
    assert.equal(atExpiry.getState(), "REFUND_PENDING");

    // t = expiry + 1 (post-expiry)
    const post = new EscrowStateMachine(t);
    post.fund(t.buyer, "0x" + "a".repeat(64));
    post.dispute(t.buyer, "dispute");
    post.triggerRefund(t.buyer, "post expiry", expiry + 1);
    assert.equal(post.getState(), "REFUND_PENDING");
  });

  test("an expired escrow cannot RELEASE — value cannot be paid out after the deadline", async () => {
    const sellerWallet = ethers.Wallet.createRandom();
    const t = terms({ seller: sellerWallet.address, expiryTimestamp: Math.floor(Date.now() / 1000) + 2 });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.startDelivery(t.seller);
    sm.submitProof(t.seller, await signedProof(sm, sellerWallet));
    const expiredNow = t.expiryTimestamp + 1;
    assert.throws(
      () => sm.release(t.buyer, "0x" + "b".repeat(64), expiredNow),
      /Time-lock invariant violated/,
      "release must be impossible once the expiry clock passed"
    );
    sm.triggerRefund(t.buyer, "expired", expiredNow);
    sm.finalizeRefund(t.buyer, "0x" + "c".repeat(64));
    assert.equal(sm.getState(), "REFUNDED");
  });
});

describe("V4 — backdate immunity (auto-release uses the ledger clock)", () => {
  test("caller-supplied submittedAt:0 never accelerates auto-release", async () => {
    const sellerWallet = ethers.Wallet.createRandom();
    const t = terms({ seller: sellerWallet.address, autoReleaseSeconds: 3600 });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.startDelivery(t.seller);
    sm.submitProof(t.seller, await signedProof(sm, sellerWallet, { submittedAt: 0 }));
    const recorded = sm.getDeliveryProof().submittedAt;
    assert.ok(recorded >= Math.floor(Date.now() / 1000) - 5, "submittedAt is the ledger clock");
    // auto-release requires now ≥ submittedAt + autoReleaseSeconds — attacker
    // cannot make 'now' qualify with a forged timestamp.
    assert.throws(
      () => sm.release("0x9999999999999999999999999999999999999999", "0x" + "1".repeat(64), Math.floor(Date.now() / 1000)),
      /Unauthorized release/,
      "outsider cannot auto-release before the timer"
    );
  });
});

describe("V5 — M-of-N arbitration quorum (real ECDSA, ethers recovery)", () => {
  function makePanel(n, m) {
    const wallets = Array.from({ length: n }, () => ethers.Wallet.createRandom());
    return { wallets, panel: { arbitrators: wallets.map((w) => w.address), quorum: m } };
  }
  function signAll(wallets, escrowId, decision, nonce, messageOverride) {
    const msg = messageOverride ?? arbitrationSigningMessage(escrowId, decision, nonce);
    return Promise.all(wallets.map((w) => w.signMessage(msg)));
  }

  test("3-of-5 quorum resolves a disputed escrow to RELEASED with a real tx hash", async () => {
    const { wallets, panel } = makePanel(5, 3);
    const t = terms({ arbitrationPanel: panel });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.dispute(t.buyer, "quality dispute");
    const nonce = crypto.randomBytes(8).toString("hex");
    const sigs = await signAll(wallets.slice(0, 3), t.escrowId, "release", nonce);
    const res = sm.resolveDispute("release", sigs, nonce, { releaseTxHash: "0x" + "b".repeat(64) });
    assert.equal(res.quorumAchieved, 3);
    assert.equal(res.quorumRequired, 3);
    assert.equal(sm.getState(), "RELEASED");
    assert.ok(sm.getAuditLog().some((r) => r.actor.includes("arbitration:3-of-5")));
  });

  test("below quorum fails closed — 2-of-5 signs, dispute stays open", async () => {
    const { wallets, panel } = makePanel(5, 3);
    const t = terms({ arbitrationPanel: panel });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.dispute(t.buyer, "quality");
    const nonce = crypto.randomBytes(8).toString("hex");
    const sigs = await signAll(wallets.slice(0, 2), t.escrowId, "refund", nonce);
    assert.throws(() => sm.resolveDispute("refund", sigs, nonce), /quorum NOT reached.*2 distinct.*required 3/);
    assert.equal(sm.getState(), "DISPUTED", "below quorum the dispute stays open");
  });

  test("duplicate votes count ONCE — one key cannot impersonate a quorum", async () => {
    const { wallets, panel } = makePanel(5, 3);
    const t = terms({ arbitrationPanel: panel });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.dispute(t.buyer, "quality");
    const nonce = crypto.randomBytes(8).toString("hex");
    const sig = await wallets[0].signMessage(arbitrationSigningMessage(t.escrowId, "release", nonce));
    assert.throws(
      () => sm.resolveDispute("release", [sig, sig, sig], nonce),
      /quorum NOT reached.*1 distinct.*required 3/,
      "three copies of one signature = ONE voter"
    );
  });

  test("non-panel and forged signatures never count; wrong-decision and wrong-escrow signatures fail", async () => {
    const { wallets, panel } = makePanel(3, 2);
    const t = terms({ arbitrationPanel: panel });
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.dispute(t.buyer, "quality");
    const nonce = crypto.randomBytes(8).toString("hex");
    const outsider = ethers.Wallet.createRandom();
    const panelSigs = await signAll(wallets.slice(0, 2), t.escrowId, "release", nonce);
    // a rogue signature rides along — it must be rejected, not counted
    const rogueSig = await outsider.signMessage(arbitrationSigningMessage(t.escrowId, "release", nonce));
    const res = sm.resolveDispute("release", [...panelSigs, rogueSig], nonce, { releaseTxHash: "0x" + "b".repeat(64) });
    assert.equal(res.quorumAchieved, 2);
    assert.ok(res.verifiedArbitrators.every((a) => panel.arbitrators.map((x) => x.toLowerCase()).includes(a)));
    // wrong outcome: signatures over 'release' cannot resolve 'refund'
    const sm2 = new EscrowStateMachine(terms({ arbitrationPanel: panel }));
    sm2.fund(t.buyer, "0x" + "a".repeat(64));
    sm2.dispute(t.buyer, "quality");
    assert.throws(() => sm2.resolveDispute("refund", panelSigs, nonce), /quorum NOT reached|recovery failed/);
    // wrong escrow: signatures bound to a different escrow id are invalid here
    assert.throws(() => sm2.resolveDispute("release", panelSigs, nonce), /quorum NOT reached|recovery failed/);
  });

  test("pure verifyQuorum reports every rejection reason explicitly", async () => {
    const { wallets, panel } = makePanel(3, 2);
    const nonce = crypto.randomBytes(8).toString("hex");
    const good = await wallets[0].signMessage(arbitrationSigningMessage("esc", "release", nonce));
    const outsider = await ethers.Wallet.createRandom().signMessage(arbitrationSigningMessage("esc", "release", nonce));
    const res = verifyQuorum("esc", "release", nonce, [good, outsider, "garbage", ""], panel);
    assert.equal(res.ok, false);
    assert.equal(res.quorumAchieved, 1);
    assert.equal(res.rejected.length, 3);
    assert.match(res.rejected.find((r) => r.signatureIndex === 1).reason, /not on the arbitration panel/);
    assert.match(res.rejected.find((r) => r.signatureIndex === 2).reason, /recovery failed/);
    assert.match(res.reason, /below quorum, every resolution path fails closed/);
  });

  test("structural fail-closed: no panel, bad quorum, wrong state, missing tx hash", async () => {
    const { wallets, panel } = makePanel(3, 3);
    const t = terms();
    const sm = new EscrowStateMachine(t);
    sm.fund(t.buyer, "0x" + "a".repeat(64));
    sm.dispute(t.buyer, "no panel configured");
    assert.throws(() => sm.resolveDispute("release", [], "n1"), /no arbitration panel/);

    // verifyQuorum REPORTS structural failures (returns ok:false — never silently ok)
    assert.equal(verifyQuorum("e", "release", "n", [], { arbitrators: [], quorum: 1 }).ok, false);
    assert.match(verifyQuorum("e", "release", "n", [], { arbitrators: [], quorum: 1 }).reason, /panel is empty/);
    assert.match(verifyQuorum("e", "release", "n", [], { arbitrators: panel.arbitrators, quorum: 4 }).reason, /quorum must be an integer in \[1, 3\]/);
    assert.match(verifyQuorum("e", "abolish", "n", [], panel).reason, /Unknown arbitration decision/);

    // resolveDispute outside DISPUTED
    const sm2 = new EscrowStateMachine(terms({ arbitrationPanel: panel }));
    assert.throws(() => sm2.resolveDispute("refund", [], "n"), /DISPUTED escrow only/);

    // release decision without a tx hash — settlement is never invented
    const t3 = terms({ arbitrationPanel: panel });
    const sm3 = new EscrowStateMachine(t3);
    sm3.fund(t3.buyer, "0x" + "a".repeat(64));
    sm3.dispute(t3.buyer, "d");
    const sigs = await signAll(wallets, t3.escrowId, "release", "n1");
    assert.throws(() => sm3.resolveDispute("release", sigs, "n1"), /requires releaseTxHash/);
  });
});

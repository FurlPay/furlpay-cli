/**
 * Escrow & Time-Locked Settlement Scheme (ETSS)
 * 
 * Production state machine for trust-minimized, multi-party atomic settlement:
 * - Deterministic lifecycle:
 *     CREATED → FUNDED → DELIVERY_PENDING → PROOF_SUBMITTED → RELEASED
 *                  ↓              ↓
 *              DISPUTED       REFUND_PENDING → REFUNDED
 * - Cryptographically authenticated delivery proofs (hash commitment & signature).
 * - Timelock expiry enforcement (automatic refund if delivery fails before deadline).
 * - Arbiter dispute resolution & multisig release.
 * - Invariant: Double-spend prevention and immutable transition audit logs.
 */

import * as crypto from "crypto";
import { ethers } from "ethers";
import { ArbitrationPanel, verifyQuorum, ArbitrationDecision } from "./escrowArbitration";

/**
 * Canonical message a seller signs to authenticate a delivery proof:
 * the escrow id binds the signature to THIS escrow (it cannot be replayed
 * against another), the proof hash binds it to the pre-agreed deliverable.
 */
export function deliveryProofSigningMessage(escrowId: string, proofHash: string): string {
  return `furlpay-escrow-proof:${escrowId}:${proofHash.toLowerCase()}`;
}

export type EscrowState =
  | "CREATED"
  | "FUNDED"
  | "DELIVERY_PENDING"
  | "PROOF_SUBMITTED"
  | "RELEASED"
  | "DISPUTED"
  | "REFUND_PENDING"
  | "REFUNDED";

export interface EscrowTerms {
  escrowId: string;
  buyer: string;
  seller: string;
  arbiter?: string;
  /**
   * M-of-N arbitration panel (2026-11-17 audit Module 1). When present, a
   * DISPUTED escrow can only be resolved by `resolveDispute` with a quorum
   * of distinct arbiter signatures — a single arbiter opinion settles nothing.
   */
  arbitrationPanel?: ArbitrationPanel;
  amount: string; // Atomic integer or decimal string
  token: string;
  network: string;
  expiryTimestamp: number; // Unix seconds
  autoReleaseSeconds: number; // Seconds after proof submission before auto-release
  deliverySpecHash: string; // SHA-256 commitment of the required delivery specification
}

export interface DeliveryProof {
  proofHash: string; // SHA-256 of delivered digital artifact/receipt
  signature: string; // Seller cryptographic signature over proofHash + escrowId
  deliverableUri?: string;
  submittedAt: number;
}

export interface EscrowTransitionRecord {
  transitionId: string;
  escrowId: string;
  fromState: EscrowState;
  toState: EscrowState;
  actor: string;
  timestamp: number;
  reason?: string;
  txHash?: string;
}

export class EscrowStateMachine {
  private terms: EscrowTerms;
  private state: EscrowState = "CREATED";
  private deliveryProof?: DeliveryProof;
  private fundingTxHash?: string;
  private settlementTxHash?: string;
  private auditLog: EscrowTransitionRecord[] = [];

  /**
   * @param rehydrate true only when reconstructing a PERSISTED snapshot
   *  (deserialize). Creation must refuse past expiries; rehydration must
   *  not — an escrow that has since expired is exactly the one whose
   *  refund flow must keep working (external audit 2026-11-17b C-01: the
   *  constructor threw on load, bricking every expired escrow's collateral
   *  forever).
   */
  constructor(terms: EscrowTerms, rehydrate = false) {
    if (!terms.escrowId) throw new Error("escrowId is required.");
    if (!terms.buyer || !terms.seller) throw new Error("Buyer and seller addresses are required.");
    if (parseFloat(terms.amount) <= 0) throw new Error("Escrow amount must be positive.");
    if (!rehydrate && terms.expiryTimestamp <= Math.floor(Date.now() / 1000)) {
      throw new Error("Expiry timestamp must be in the future.");
    }

    this.terms = terms;
  }

  getEscrowId(): string {
    return this.terms.escrowId;
  }

  getState(): EscrowState {
    return this.state;
  }

  /** Terms accessor (read-only view for callers and rehydration paths). */
  getTerms(): EscrowTerms {
    return { ...this.terms };
  }

  getDeliveryProof(): DeliveryProof | undefined {
    return this.deliveryProof;
  }

  getAuditLog(): EscrowTransitionRecord[] {
    return [...this.auditLog];
  }

  private recordTransition(toState: EscrowState, actor: string, reason?: string, txHash?: string): void {
    const record: EscrowTransitionRecord = {
      transitionId: `tr_${crypto.randomBytes(8).toString("hex")}`,
      escrowId: this.terms.escrowId,
      fromState: this.state,
      toState,
      actor,
      timestamp: Math.floor(Date.now() / 1000),
      reason,
      txHash,
    };
    this.auditLog.push(record);
    this.state = toState;
  }

  /**
   * 1. Fund escrow: Buyer deposits collateral into custody.
   */
  fund(actor: string, fundingTxHash: string): void {
    if (this.state !== "CREATED") {
      throw new Error(`Invalid state transition: Cannot fund escrow in state '${this.state}'.`);
    }
    if (actor.toLowerCase() !== this.terms.buyer.toLowerCase()) {
      throw new Error(`Unauthorized: Only buyer (${this.terms.buyer}) can fund this escrow.`);
    }
    if (!fundingTxHash) {
      throw new Error("fundingTxHash is required to confirm deposit.");
    }

    this.fundingTxHash = fundingTxHash;
    this.recordTransition("FUNDED", actor, "Collateral deposited and locked in escrow contract", fundingTxHash);
  }

  /**
   * 2. Initiate delivery: Seller signals execution started.
   */
  startDelivery(actor: string): void {
    if (this.state !== "FUNDED") {
      throw new Error(`Invalid state transition: Cannot start delivery in state '${this.state}'.`);
    }
    if (actor.toLowerCase() !== this.terms.seller.toLowerCase()) {
      throw new Error(`Unauthorized: Only seller (${this.terms.seller}) can initiate delivery.`);
    }

    this.recordTransition("DELIVERY_PENDING", actor, "Seller initiated service delivery");
  }

  /**
   * 3. Submit cryptographic delivery proof.
   *
   * Fail-closed contract (2026-11-16 audit P6):
   * - The proof hash MUST equal the pre-agreed `deliverySpecHash` the escrow
   *   was created with — a seller cannot substitute a different deliverable.
   * - The signature MUST cryptographically recover to the seller address over
   *   the canonical `${escrowId}:${proofHash}` message. Any string that is
   *   not a valid signature from the seller is rejected outright (the old
   *   code accepted arbitrary strings — `sim:local-cli-attestation` et al).
   * - `submittedAt` is ALWAYS the local ledger clock, never a caller-supplied
   *   timestamp: a backdated `submittedAt: 0` used to make the auto-release
   *   condition immediately true, draining buyer collateral without consent.
   */
  submitProof(actor: string, proof: DeliveryProof): void {
    if (this.state !== "DELIVERY_PENDING" && this.state !== "FUNDED") {
      throw new Error(`Invalid state transition: Cannot submit proof in state '${this.state}'.`);
    }
    if (actor.toLowerCase() !== this.terms.seller.toLowerCase()) {
      throw new Error("Unauthorized: Only seller can submit delivery proof.");
    }
    if (!proof.proofHash || !/^0x[0-9a-fA-F]{64}$/.test(proof.proofHash)) {
      throw new Error("Invalid delivery proofHash: must be a 32-byte hex SHA-256 hash.");
    }
    if (proof.proofHash.toLowerCase() !== this.terms.deliverySpecHash.toLowerCase()) {
      throw new Error(
        `Proof hash mismatch: submitted ${proof.proofHash} does not equal the pre-agreed ` +
          `delivery spec commitment ${this.terms.deliverySpecHash}. The escrow only accepts ` +
          `the deliverable it was created for.`
      );
    }
    if (!proof.signature || typeof proof.signature !== "string") {
      throw new Error(
        "Delivery proof must include the seller's cryptographic signature over " +
          `${deliveryProofSigningMessage(this.terms.escrowId, proof.proofHash)}.`
      );
    }
    if (!ethers.isAddress(this.terms.seller)) {
      throw new Error(
        `Cannot verify delivery proof: seller '${this.terms.seller}' is not an EVM address. ` +
          `This ledger verifies seller signatures via ECDSA recovery — non-EVM sellers are ` +
          `refused rather than recorded on an unverifiable attestation.`
      );
    }
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(
        deliveryProofSigningMessage(this.terms.escrowId, proof.proofHash),
        proof.signature
      );
    } catch (e: any) {
      throw new Error(
        `Invalid delivery proof signature (recovery failed: ${e.message}). The proof must be ` +
          `an EVM signature by the seller over the canonical escrow proof message — arbitrary ` +
          `attestation strings are not accepted.`
      );
    }
    if (recovered.toLowerCase() !== this.terms.seller.toLowerCase()) {
      throw new Error(
        `Delivery proof signature mismatch: recovered signer ${recovered} is not the seller ` +
          `of record ${this.terms.seller}.`
      );
    }

    // Ledger clock only — the caller's submittedAt is recorded nowhere.
    const recordedAt = Math.floor(Date.now() / 1000);
    this.deliveryProof = { ...proof, submittedAt: recordedAt };
    this.recordTransition("PROOF_SUBMITTED", actor, "Seller submitted delivery proof commitment");
  }

  /**
   * 4. Release escrow funds to seller (Buyer approval or auto-release timer).
   */
  release(actor: string, releaseTxHash: string, currentTimestampSeconds?: number): void {
    if (this.state !== "PROOF_SUBMITTED" && this.state !== "DELIVERY_PENDING") {
      throw new Error(`Invalid state transition: Cannot release funds in state '${this.state}'.`);
    }

    const now = currentTimestampSeconds || Math.floor(Date.now() / 1000);

    // Time-lock invariant (2026-11-17 audit V3): once the escrow clock passes
    // the deadline, the refund path OWNS the collateral — a release after
    // expiry would pay the seller over a refundable escrow. The boundary is
    // inclusive: at t = expiry the funds are already refundable.
    if (now >= this.terms.expiryTimestamp) {
      throw new Error(
        `Time-lock invariant violated: the escrow expired at ${this.terms.expiryTimestamp} ` +
          `(now ${now}) — collateral is refundable, not releasable. Use the refund path.`
      );
    }

    const isBuyer = actor.toLowerCase() === this.terms.buyer.toLowerCase();
    const isArbiter = this.terms.arbiter && actor.toLowerCase() === this.terms.arbiter.toLowerCase();

    // Check auto-release condition if actor is system/seller
    const isAutoRelease =
      this.deliveryProof &&
      now >= this.deliveryProof.submittedAt + this.terms.autoReleaseSeconds;

    if (!isBuyer && !isArbiter && !isAutoRelease) {
      throw new Error("Unauthorized release: Must be authorized by buyer, arbiter, or valid auto-release delay.");
    }

    this.settlementTxHash = releaseTxHash;
    this.recordTransition("RELEASED", actor, "Escrow collateral released to seller", releaseTxHash);
  }

  /**
   * 5. Raise dispute: Either buyer or seller can dispute while active.
   */
  dispute(actor: string, reason: string): void {
    if (this.state !== "FUNDED" && this.state !== "DELIVERY_PENDING" && this.state !== "PROOF_SUBMITTED") {
      throw new Error(`Invalid state transition: Cannot dispute in terminal or uninitialized state '${this.state}'.`);
    }

    const isParty =
      actor.toLowerCase() === this.terms.buyer.toLowerCase() ||
      actor.toLowerCase() === this.terms.seller.toLowerCase();

    if (!isParty) {
      throw new Error("Unauthorized: Only escrow counterparties can raise a dispute.");
    }

    this.recordTransition("DISPUTED", actor, `Dispute opened: ${reason}`);
  }

  /**
   * 6. Arbiter or Timeout Refund Trigger.
   */
  triggerRefund(actor: string, reason: string, currentTimestampSeconds?: number): void {
    const now = currentTimestampSeconds || Math.floor(Date.now() / 1000);
    const isArbiter = this.terms.arbiter && actor.toLowerCase() === this.terms.arbiter.toLowerCase();
    const isExpired = now >= this.terms.expiryTimestamp && this.state !== "RELEASED" && this.state !== "REFUNDED";

    if (this.state === "RELEASED" || this.state === "REFUNDED") {
      throw new Error(`Terminal state invariant: Escrow already resolved in '${this.state}'.`);
    }

    if (!isArbiter && !isExpired) {
      throw new Error("Unauthorized refund: Requires arbiter decision or deadline expiry.");
    }

    this.recordTransition("REFUND_PENDING", actor, `Refund triggered: ${reason}`);
  }

  /**
   * 7. Finalize refund payout to buyer.
   */
  finalizeRefund(actor: string, refundTxHash: string): void {
    if (this.state !== "REFUND_PENDING") {
      throw new Error(`Invalid state transition: Cannot finalize refund in state '${this.state}'.`);
    }

    this.settlementTxHash = refundTxHash;
    this.recordTransition("REFUNDED", actor, "Escrow collateral refunded back to buyer", refundTxHash);
  }

  /**
   * 8. Arbiter-panel resolution of a DISPUTED escrow (audit Module 1).
   *
   * A DISPUTED escrow is a dead-end without this: only an M-of-N quorum of
   * DISTINCT panel-member signatures over the canonical resolution message
   * can move it — to RELEASED ('release') or REFUND_PENDING ('refund').
   * Below quorum, with non-panel signers, or outside DISPUTED, it fails
   * closed and the dispute stays open. The resolution nonce binds every
   * signature to one vote round: votes cannot be replayed across outcomes.
   */
  resolveDispute(
    decision: ArbitrationDecision,
    signatures: string[],
    resolutionNonce: string,
    opts: { releaseTxHash?: string; reason?: string } = {}
  ): { quorumAchieved: number; quorumRequired: number; verifiedArbitrators: string[] } {
    if (this.state !== "DISPUTED") {
      throw new Error(`Invalid state transition: arbitration resolves a DISPUTED escrow only (state is '${this.state}').`);
    }
    const panel = this.terms.arbitrationPanel;
    if (!panel) {
      throw new Error(
        "This escrow has no arbitration panel in its terms — disputes cannot be resolved " +
          "by quorum. Create escrows with `arbitrationPanel` to enable M-of-N resolution."
      );
    }
    const quorum = verifyQuorum(this.terms.escrowId, decision, resolutionNonce, signatures, panel);
    if (!quorum.ok) {
      throw new Error(quorum.reason);
    }

    if (decision === "release") {
      if (!opts.releaseTxHash) {
        throw new Error("A 'release' arbitration decision requires releaseTxHash — the settlement transaction is never invented.");
      }
      this.settlementTxHash = opts.releaseTxHash;
      this.recordTransition(
        "RELEASED",
        `arbitration:${quorum.verifiedArbitrators.length}-of-${panel.arbitrators.length}`,
        opts.reason ?? "Arbiter panel quorum voted to release collateral to seller",
        opts.releaseTxHash
      );
    } else {
      this.recordTransition(
        "REFUND_PENDING",
        `arbitration:${quorum.verifiedArbitrators.length}-of-${panel.arbitrators.length}`,
        opts.reason ?? "Arbiter panel quorum voted to refund collateral to buyer"
      );
    }
    return {
      quorumAchieved: quorum.quorumAchieved,
      quorumRequired: quorum.quorumRequired,
      verifiedArbitrators: quorum.verifiedArbitrators,
    };
  }

  /**
   * Persist the full machine state (terms + lifecycle position + audit log)
   * so the escrow survives across CLI invocations.
   */
  serialize(): EscrowSnapshot {
    return {
      schema: "furlpay-escrow-v1",
      terms: { ...this.terms },
      state: this.state,
      deliveryProof: this.deliveryProof ? { ...this.deliveryProof } : undefined,
      fundingTxHash: this.fundingTxHash,
      settlementTxHash: this.settlementTxHash,
      auditLog: this.auditLog.map((r) => ({ ...r })),
    };
  }

  /**
   * Rebuild a machine from a snapshot. The audit log is restored verbatim so
   * transitions remain immutable across process boundaries; the constructor
   * invariants are re-validated on the persisted terms.
   */
  static deserialize(snapshot: EscrowSnapshot): EscrowStateMachine {
    if (!snapshot || snapshot.schema !== "furlpay-escrow-v1") {
      throw new Error("Invalid escrow snapshot: unrecognized or missing schema.");
    }
    if (!snapshot.terms || typeof snapshot.terms !== "object") {
      throw new Error("Invalid escrow snapshot: terms are required.");
    }
    const validStates: EscrowState[] = [
      "CREATED", "FUNDED", "DELIVERY_PENDING", "PROOF_SUBMITTED",
      "RELEASED", "DISPUTED", "REFUND_PENDING", "REFUNDED",
    ];
    if (!validStates.includes(snapshot.state)) {
      throw new Error(`Invalid escrow snapshot: unknown state '${snapshot.state}'.`);
    }

    const machine = new EscrowStateMachine({ ...snapshot.terms }, true);
    (machine as any).state = snapshot.state;
    machine.auditLog = Array.isArray(snapshot.auditLog)
      ? snapshot.auditLog.map((r) => ({ ...r }))
      : [];
    if (snapshot.deliveryProof) machine.deliveryProof = { ...snapshot.deliveryProof };
    if (snapshot.fundingTxHash) machine.fundingTxHash = snapshot.fundingTxHash;
    if (snapshot.settlementTxHash) machine.settlementTxHash = snapshot.settlementTxHash;
    return machine;
  }
}

export interface EscrowSnapshot {
  schema: "furlpay-escrow-v1";
  terms: EscrowTerms;
  state: EscrowState;
  deliveryProof?: DeliveryProof;
  fundingTxHash?: string;
  settlementTxHash?: string;
  auditLog: EscrowTransitionRecord[];
}

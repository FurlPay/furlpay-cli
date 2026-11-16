/**
 * ETSS Arbitration — M-of-N arbiter quorum resolution (2026-11-17 audit Module 1).
 *
 * Formal contract:
 *  - A dispute is resolved ONLY when a quorum of ≥ M DISTINCT arbitrators
 *    (from the N-member panel locked in the escrow terms) has signed the
 *    canonical resolution message.
 *  - Signatures are verified by ECDSA recovery (ethers.verifyMessage) —
 *    identity claims are worthless; recovered addresses are the identity.
 *  - Duplicate signatures from the same arbiter count ONCE — one key voting
 *    twice can never impersonate a quorum.
 *  - Non-panel signers are rejected outright (a rogue signature neither
 *    counts nor poisons the others).
 *  - Everything fails closed: below quorum, malformed signatures, unknown
 *    decision verbs, or a non-DISPUTED machine state all refuse loudly.
 */

import { ethers } from "ethers";

export interface ArbitrationPanel {
  /** The full N-member panel of EVM addresses. */
  arbitrators: string[];
  /** Required distinct signatures M. Must satisfy 1 ≤ M ≤ N. */
  quorum: number;
}

export type ArbitrationDecision = "release" | "refund";

/**
 * Canonical message each arbiter signs. The escrow id binds the signature to
 * THIS escrow, the decision verb binds it to one outcome, and the resolution
 * nonce binds it to one specific vote round — a signature cannot be replayed
 * for the other outcome, a different escrow, or a later re-vote.
 */
export function arbitrationSigningMessage(
  escrowId: string,
  decision: ArbitrationDecision,
  resolutionNonce: string
): string {
  return `furlpay-escrow-resolution:${escrowId}:${decision}:${resolutionNonce}`;
}

export interface QuorumResult {
  ok: boolean;
  reason?: string;
  /** Distinct, panel-verified arbiter addresses that signed. */
  verifiedArbitrators: string[];
  /** Signature-level diagnostics (recovery failures, non-panel signers). */
  rejected: Array<{ signatureIndex: number; reason: string }>;
  quorumRequired: number;
  quorumAchieved: number;
}

/**
 * Verify an M-of-N quorum over a decision. PURE — no machine state touched.
 * Every failure mode is explicit in the result; nothing is silently dropped.
 */
export function verifyQuorum(
  escrowId: string,
  decision: ArbitrationDecision,
  resolutionNonce: string,
  signatures: string[],
  panel: ArbitrationPanel
): QuorumResult {
  const rejected: QuorumResult["rejected"] = [];
  if (!panel || !Array.isArray(panel.arbitrators) || panel.arbitrators.length === 0) {
    return { ok: false, reason: "Arbitration panel is empty — disputes cannot be resolved without an arbitration panel.", verifiedArbitrators: [], rejected, quorumRequired: 0, quorumAchieved: 0 };
  }
  if (!Number.isInteger(panel.quorum) || panel.quorum < 1 || panel.quorum > panel.arbitrators.length) {
    return { ok: false, reason: `Arbitration quorum must be an integer in [1, ${panel.arbitrators.length}] (got ${panel.quorum}).`, verifiedArbitrators: [], rejected, quorumRequired: panel.quorum, quorumAchieved: 0 };
  }
  if (decision !== "release" && decision !== "refund") {
    return { ok: false, reason: `Unknown arbitration decision '${decision}' — only 'release' and 'refund' exist.`, verifiedArbitrators: [], rejected, quorumRequired: panel.quorum, quorumAchieved: 0 };
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return { ok: false, reason: "No arbiter signatures supplied — quorum cannot be reached.", verifiedArbitrators: [], rejected, quorumRequired: panel.quorum, quorumAchieved: 0 };
  }

  const panelLower = new Set(panel.arbitrators.map((a) => String(a).toLowerCase()));
  if (panelLower.size !== panel.arbitrators.length) {
    return { ok: false, reason: "Arbitration panel contains duplicate members — refusing to evaluate (panel integrity violation).", verifiedArbitrators: [], rejected, quorumRequired: panel.quorum, quorumAchieved: 0 };
  }
  if (!resolutionNonce || typeof resolutionNonce !== "string") {
    return { ok: false, reason: "resolutionNonce is required — it binds every signature to one specific vote round.", verifiedArbitrators: [], rejected, quorumRequired: panel.quorum, quorumAchieved: 0 };
  }

  const message = arbitrationSigningMessage(escrowId, decision, resolutionNonce);
  const verified = new Map<string, true>();
  for (let i = 0; i < signatures.length; i++) {
    const sig = signatures[i];
    if (typeof sig !== "string" || !sig) {
      rejected.push({ signatureIndex: i, reason: "empty or non-string signature" });
      continue;
    }
    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, sig);
    } catch (e: any) {
      rejected.push({ signatureIndex: i, reason: `recovery failed (${e.message})` });
      continue;
    }
    if (!panelLower.has(recovered.toLowerCase())) {
      rejected.push({ signatureIndex: i, reason: `signer ${recovered} is not on the arbitration panel` });
      continue;
    }
    // Distinct-count semantics: the same arbiter signing twice adds nothing.
    verified.set(recovered.toLowerCase(), true);
  }

  const achieved = verified.size;
  const result: QuorumResult = {
    ok: achieved >= panel.quorum,
    verifiedArbitrators: [...verified.keys()],
    rejected,
    quorumRequired: panel.quorum,
    quorumAchieved: achieved,
  };
  if (!result.ok) {
    result.reason =
      `Arbitration quorum NOT reached: ${achieved} distinct verified signature(s) of ` +
      `required ${panel.quorum}. Rejected signatures: ${rejected.length}. ` +
      `The dispute stays open — below quorum, every resolution path fails closed.`;
  }
  return result;
}

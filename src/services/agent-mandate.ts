/**
 * Autonomous Agent Mandate & Policy Enforcement Engine
 * 
 * Provides cryptographic authorization for AI agents interacting with FurlPay financial tools:
 * - Signed Agent Identity & Session Keys.
 * - Cryptographically verified Spending Mandates signed by human account owner.
 * - Strict Separation: AI Agents CANNOT manufacture or self-sign their own mandates.
 * - Per-transaction authorization, daily velocity cap, and allowed action whitelist.
 * - Expiration and instant revocation check.
 * - Escalation to human approval whenever transaction exceeds limits or lacks mandate.
 * - Anti-Prompt Injection defense: rejects bypass, override, and simulated mandate payloads.
 */

import * as crypto from "crypto";
import { ethers } from "ethers";

export interface SpendingMandate {
  mandateId: string;
  agentPublicKey: string; // Agent's session public key
  issuerAddress: string;  // Human account owner
  maxSingleTxUsd: number;
  dailyVelocityCapUsd: number;
  allowedActions: string[];
  allowedTokens: string[];
  recipientWhitelist?: string[];
  validFrom: number; // Unix seconds
  validUntil: number; // Unix seconds
  issuerSignature: string; // Human owner signature over mandate hash
}

export interface AuthorizationDecision {
  approved: boolean;
  requiresHumanApproval: boolean;
  reason?: string;
  authorizationToken?: string;
  spentTodayUsd?: number;
}

export class AgentMandateEngine {
  private dailySpendByAgent: Map<string, { day: number; spentUsd: number }> = new Map();
  private revokedMandates: Set<string> = new Set();
  private auditTrail: Array<{
    timestamp: number;
    agentPublicKey: string;
    action: string;
    amountUsd: number;
    decision: AuthorizationDecision;
  }> = [];

  /**
   * Helper to compute deterministic hash of a mandate.
   */
  hashMandate(mandate: Omit<SpendingMandate, "issuerSignature">): string {
    const payload = JSON.stringify({
      mandateId: mandate.mandateId,
      agentPublicKey: mandate.agentPublicKey.toLowerCase(),
      issuerAddress: mandate.issuerAddress.toLowerCase(),
      maxSingleTxUsd: mandate.maxSingleTxUsd,
      dailyVelocityCapUsd: mandate.dailyVelocityCapUsd,
      allowedActions: [...mandate.allowedActions].sort(),
      allowedTokens: [...mandate.allowedTokens].sort(),
      recipientWhitelist: mandate.recipientWhitelist ? [...mandate.recipientWhitelist].sort() : undefined,
      validFrom: mandate.validFrom,
      validUntil: mandate.validUntil,
    });
    return ethers.keccak256(new Uint8Array(Buffer.from(payload)));
  }

  /**
   * Revoke a mandate immediately.
   */
  revokeMandate(mandateId: string): void {
    this.revokedMandates.add(mandateId);
  }

  isRevoked(mandateId: string): boolean {
    return this.revokedMandates.has(mandateId);
  }

  /**
   * Cryptographically verify a spending mandate.
   */
  verifyMandate(mandate: SpendingMandate, currentTimeSeconds?: number): { valid: boolean; error?: string } {
    if (!mandate || typeof mandate !== "object") {
      return { valid: false, error: "invalid_mandate_format" };
    }

    // 1. Check revocation registry
    if (this.revokedMandates.has(mandate.mandateId)) {
      return { valid: false, error: "mandate_has_been_revoked" };
    }

    // 2. Anti-Self-Authorization Invariant: Agent CANNOT issue its own mandate
    if (mandate.issuerAddress.toLowerCase() === mandate.agentPublicKey.toLowerCase()) {
      return {
        valid: false,
        error: "agent_self_authorization_strictly_forbidden: Mandate must be issued by a separate human account owner.",
      };
    }

    // 3. Prompt injection detection in mandate strings
    const serialized = JSON.stringify(mandate).toLowerCase();
    const injectionPatterns = [
      "ignore previous instructions",
      "bypass",
      "admin_override",
      "unlimited",
      "prompt_injection",
      "sudo",
    ];
    for (const pattern of injectionPatterns) {
      if (serialized.includes(pattern)) {
        return { valid: false, error: `prompt_injection_pattern_detected: '${pattern}' is strictly prohibited.` };
      }
    }

    // 4. Validity window verification
    const now = currentTimeSeconds !== undefined ? currentTimeSeconds : Math.floor(Date.now() / 1000);
    if (now < mandate.validFrom) {
      return { valid: false, error: "mandate_not_yet_valid" };
    }
    if (now > mandate.validUntil) {
      return { valid: false, error: "mandate_expired" };
    }

    // 5. Signature recovery verification
    try {
      const hash = this.hashMandate(mandate);
      const recoveredIssuer = ethers.verifyMessage(ethers.getBytes(hash), mandate.issuerSignature);
      if (recoveredIssuer.toLowerCase() !== mandate.issuerAddress.toLowerCase()) {
        return { valid: false, error: "issuer_signature_mismatch" };
      }
    } catch (e: any) {
      return { valid: false, error: `cryptographic_verification_failed: ${e.message}` };
    }

    return { valid: true };
  }

  /**
   * Authorize an incoming agent transaction attempt against an active mandate.
   */
  authorizeTransaction(params: {
    mandate?: SpendingMandate;
    agentPublicKey: string;
    action: string;
    amountUsd: number;
    token?: string;
    recipient?: string;
    currentTimeSeconds?: number;
  }): AuthorizationDecision {
    const { mandate, agentPublicKey, action, amountUsd, token, recipient } = params;
    const now = params.currentTimeSeconds !== undefined ? params.currentTimeSeconds : Math.floor(Date.now() / 1000);
    const currentDay = Math.floor(now / 86400);

    // If no mandate is supplied, escalate to human approval
    if (!mandate) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: "No cryptographic mandate supplied. Financial mutation requires explicit human authorization.",
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // Agent public key in request must match mandate
    if (agentPublicKey.toLowerCase() !== mandate.agentPublicKey.toLowerCase()) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: "Agent identity mismatch: supplied agent public key does not match active mandate.",
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // Verify mandate validity and signature
    const mandateCheck = this.verifyMandate(mandate, now);
    if (!mandateCheck.valid) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Invalid mandate: ${mandateCheck.error}`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // 1. Allowed actions check
    if (!mandate.allowedActions.includes(action)) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Action '${action}' is not in allowed actions whitelist: [${mandate.allowedActions.join(", ")}]`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // 2. Allowed tokens check
    if (token && !mandate.allowedTokens.map((t) => t.toUpperCase()).includes(token.toUpperCase())) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Token '${token}' is not in allowed tokens whitelist: [${mandate.allowedTokens.join(", ")}]`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // 3. Recipient whitelist check
    if (recipient && mandate.recipientWhitelist && mandate.recipientWhitelist.length > 0) {
      const isAllowedRecipient = mandate.recipientWhitelist.some(
        (r) => r.toLowerCase() === recipient.toLowerCase()
      );
      if (!isAllowedRecipient) {
        const decision: AuthorizationDecision = {
          approved: false,
          requiresHumanApproval: true,
          reason: `Recipient '${recipient}' is not in mandate recipient whitelist.`,
        };
        this.recordAudit(agentPublicKey, action, amountUsd, decision);
        return decision;
      }
    }

    // 4. Single transaction limit check
    if (amountUsd > mandate.maxSingleTxUsd) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Amount \$${amountUsd.toFixed(2)} exceeds single-transaction cap \$${mandate.maxSingleTxUsd.toFixed(2)}.`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // 5. Daily cumulative velocity cap check
    const agentSpendKey = `${mandate.mandateId}:${agentPublicKey.toLowerCase()}`;
    let spendRecord = this.dailySpendByAgent.get(agentSpendKey);
    if (!spendRecord || spendRecord.day !== currentDay) {
      spendRecord = { day: currentDay, spentUsd: 0 };
    }

    if (spendRecord.spentUsd + amountUsd > mandate.dailyVelocityCapUsd) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Payment would breach daily velocity cap of \$${mandate.dailyVelocityCapUsd.toFixed(2)} (Already spent today: \$${spendRecord.spentUsd.toFixed(2)}).`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    // Update cumulative spend
    spendRecord.spentUsd += amountUsd;
    this.dailySpendByAgent.set(agentSpendKey, spendRecord);

    const tokenBytes = crypto.randomBytes(16).toString("hex");
    const authToken = `auth_mandate_${tokenBytes}`;

    const decision: AuthorizationDecision = {
      approved: true,
      requiresHumanApproval: false,
      authorizationToken: authToken,
      spentTodayUsd: spendRecord.spentUsd,
    };

    this.recordAudit(agentPublicKey, action, amountUsd, decision);
    return decision;
  }

  private recordAudit(
    agentPublicKey: string,
    action: string,
    amountUsd: number,
    decision: AuthorizationDecision
  ): void {
    this.auditTrail.push({
      timestamp: Date.now(),
      agentPublicKey,
      action,
      amountUsd,
      decision,
    });
  }

  getAuditTrail(): any[] {
    return [...this.auditTrail];
  }
}

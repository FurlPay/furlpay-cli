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
import * as path from "path";
import { ethers } from "ethers";
import { ledgerDir, withLedgerLock, readLedger, writeLedger } from "./persistentLedger";

interface SpendLedger {
  agents: Record<string, { day: number; spentUsd: number }>;
}

interface RevocationLedger {
  revoked: Record<string, number>; // mandateId -> revokedAt (epoch ms)
}

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
  /**
   * P8 (2026-11-16 audit): daily-spend and revocation state previously lived
   * in an in-memory Map/Set that reset on every process exit — an agent could
   * evade its daily velocity cap simply by running each transaction in a new
   * CLI invocation, and "revoked" mandates resurrected on restart. Both are
   * now durable file ledgers mutated under an exclusive lock.
   */
  private spendLedgerPath: string;
  private revocationLedgerPath: string;
  private auditTrail: Array<{
    timestamp: number;
    agentPublicKey: string;
    action: string;
    amountUsd: number;
    decision: AuthorizationDecision;
  }> = [];

  /** @param customLedgerDir inject a directory for tests; defaults to ~/.furlpay/ledgers. */
  constructor(customLedgerDir?: string) {
    const dir = ledgerDir(customLedgerDir);
    this.spendLedgerPath = path.join(dir, "agent-mandate-spend.json");
    this.revocationLedgerPath = path.join(dir, "agent-mandate-revocations.json");
  }

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
   * Revoke a mandate immediately — durably. A revocation that vanished on
   * process exit was never a revocation (audit P8).
   */
  revokeMandate(mandateId: string): void {
    withLedgerLock(this.revocationLedgerPath, () => {
      const ledger = readLedger<RevocationLedger>(this.revocationLedgerPath) ?? { revoked: {} };
      ledger.revoked[mandateId] = Date.now();
      writeLedger(this.revocationLedgerPath, ledger);
    });
  }

  isRevoked(mandateId: string): boolean {
    const ledger = readLedger<RevocationLedger>(this.revocationLedgerPath);
    return ledger?.revoked?.[mandateId] !== undefined;
  }

  /**
   * Cryptographically verify a spending mandate.
   */
  verifyMandate(mandate: SpendingMandate, currentTimeSeconds?: number): { valid: boolean; error?: string } {
    if (!mandate || typeof mandate !== "object") {
      return { valid: false, error: "invalid_mandate_format" };
    }

    // 1. Check revocation registry (durable ledger)
    if (this.isRevoked(mandate.mandateId)) {
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

    // 5. Daily cumulative velocity cap check — read-validate-record runs
    // atomically under the durable ledger lock, so two concurrent CLI/MCP
    // processes cannot both pass the cap against the same pre-spend balance
    // (audit P8: the in-memory Map reset on every process exit).
    const agentSpendKey = `${mandate.mandateId}:${agentPublicKey.toLowerCase()}`;
    let deniedSpentToday = 0;
    const recorded = withLedgerLock(this.spendLedgerPath, (): { day: number; spentUsd: number } | null => {
      const ledger = readLedger<SpendLedger>(this.spendLedgerPath) ?? { agents: {} };
      let spendRecord = ledger.agents[agentSpendKey];
      if (!spendRecord || spendRecord.day !== currentDay) {
        spendRecord = { day: currentDay, spentUsd: 0 };
      }
      if (spendRecord.spentUsd + amountUsd > mandate.dailyVelocityCapUsd) {
        // Denied: persist nothing (prune stale-day entries only).
        for (const key of Object.keys(ledger.agents)) {
          if (ledger.agents[key].day !== currentDay) delete ledger.agents[key];
        }
        writeLedger(this.spendLedgerPath, ledger);
        deniedSpentToday = spendRecord.spentUsd;
        return null;
      }
      spendRecord.spentUsd += amountUsd;
      ledger.agents[agentSpendKey] = spendRecord;
      // Prune stale-day entries: a non-current day can never become current again.
      for (const key of Object.keys(ledger.agents)) {
        if (key !== agentSpendKey && ledger.agents[key].day !== currentDay) delete ledger.agents[key];
      }
      writeLedger(this.spendLedgerPath, ledger);
      return spendRecord;
    });

    if (recorded === null) {
      const decision: AuthorizationDecision = {
        approved: false,
        requiresHumanApproval: true,
        reason: `Payment would breach daily velocity cap of \$${mandate.dailyVelocityCapUsd.toFixed(2)} (Already spent today: \$${deniedSpentToday.toFixed(2)}).`,
      };
      this.recordAudit(agentPublicKey, action, amountUsd, decision);
      return decision;
    }

    const tokenBytes = crypto.randomBytes(16).toString("hex");
    const authToken = `auth_mandate_${tokenBytes}`;

    const decision: AuthorizationDecision = {
      approved: true,
      requiresHumanApproval: false,
      authorizationToken: authToken,
      spentTodayUsd: recorded.spentUsd,
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

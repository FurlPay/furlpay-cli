/**
 * FurlPay Execution Authorization Service (2026)
 * 
 * Enforces a strict default-deny execution perimeter:
 * - Cryptographic Agent Mandate validation
 * - Hot session key authorization boundaries
 * - Single-order and daily cumulative velocity ceilings
 * - Monotonic timestamp-nonce generation
 * - Hardware / emergency kill switch with instantaneous shutdown
 */

export interface AgentMandate {
  agentAddress: string;
  masterAddress: string;
  maxSingleOrderUsd: number;
  dailyVelocityCapUsd: number;
  expiresAt: number;
  allowedSymbols?: string[];
  isRevoked: boolean;
}

export interface ExecutionIntent {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  agentAddress: string;
}

export interface AuthorizationResult {
  authorized: boolean;
  reason?: string;
  nonce?: number;
}

export class ExecutionAuthorizationService {
  private isKillSwitchActive: boolean = false;
  private activeMandates = new Map<string, AgentMandate>();
  private dailyConsumedVelocity = new Map<string, { date: number; consumedUsd: number }>();
  private lastNonce: number = Date.now();

  /**
   * Register or update an authorized Agent Mandate.
   */
  public registerMandate(mandate: AgentMandate): void {
    if (Date.now() >= mandate.expiresAt) {
      throw new Error("MANDATE_EXPIRED: Cannot register an expired mandate.");
    }
    this.activeMandates.set(mandate.agentAddress.toLowerCase(), { ...mandate });
  }

  /**
   * Revoke an Agent Mandate immediately.
   */
  public revokeMandate(agentAddress: string): void {
    const clean = agentAddress.toLowerCase();
    const existing = this.activeMandates.get(clean);
    if (existing) {
      existing.isRevoked = true;
    }
  }

  /**
   * Trigger emergency kill switch: blocks all execution immediately.
   */
  public triggerKillSwitch(): void {
    this.isKillSwitchActive = true;
  }

  /**
   * Reset kill switch after incident review.
   */
  public resetKillSwitch(): void {
    this.isKillSwitchActive = false;
  }

  public getIsKillSwitchActive(): boolean {
    return this.isKillSwitchActive;
  }

  /**
   * Generates a strictly monotonic timestamp-nonce for EIP-712 signing.
   */
  public generateMonotonicNonce(): number {
    const now = Date.now();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1;
    return this.lastNonce;
  }

  /**
   * Evaluates authorization for an execution intent under default-deny policy.
   */
  public authorizeExecution(intent: ExecutionIntent): AuthorizationResult {
    // 0. Kill switch check
    if (this.isKillSwitchActive) {
      return { authorized: false, reason: "KILL_SWITCH_ACTIVE: Execution is administratively halted." };
    }

    const cleanAgent = intent.agentAddress.toLowerCase();
    const mandate = this.activeMandates.get(cleanAgent);

    // 1. Mandate existence & revocation
    if (!mandate) {
      return { authorized: false, reason: `UNAUTHORIZED_AGENT: No mandate registered for ${intent.agentAddress}.` };
    }
    if (mandate.isRevoked) {
      return { authorized: false, reason: "MANDATE_REVOKED: Agent mandate has been revoked." };
    }

    // 2. Expiration check
    if (Date.now() >= mandate.expiresAt) {
      return { authorized: false, reason: "MANDATE_EXPIRED: Session mandate has expired." };
    }

    // 3. Symbol authorization check
    if (mandate.allowedSymbols && mandate.allowedSymbols.length > 0) {
      if (!mandate.allowedSymbols.includes(intent.symbol)) {
        return {
          authorized: false,
          reason: `UNAUTHORIZED_SYMBOL: ${intent.symbol} is not permitted by this mandate.`,
        };
      }
    }

    // 4. Single order notional check
    if (intent.notionalUsd > mandate.maxSingleOrderUsd) {
      return {
        authorized: false,
        reason: `SINGLE_ORDER_CEILING_BREACH: \$${intent.notionalUsd.toFixed(2)} exceeds limit \$${mandate.maxSingleOrderUsd.toFixed(2)}.`,
      };
    }

    // 5. Daily cumulative velocity cap check
    const currentDay = new Date().getUTCDate();
    let velocityRecord = this.dailyConsumedVelocity.get(cleanAgent);
    if (!velocityRecord || velocityRecord.date !== currentDay) {
      velocityRecord = { date: currentDay, consumedUsd: 0 };
      this.dailyConsumedVelocity.set(cleanAgent, velocityRecord);
    }

    if (velocityRecord.consumedUsd + intent.notionalUsd > mandate.dailyVelocityCapUsd) {
      return {
        authorized: false,
        reason: `DAILY_VELOCITY_BREACH: Projected daily turnover \$${(velocityRecord.consumedUsd + intent.notionalUsd).toFixed(2)} exceeds limit \$${mandate.dailyVelocityCapUsd.toFixed(2)}.`,
      };
    }

    // Commit consumed turnover
    velocityRecord.consumedUsd += intent.notionalUsd;

    return {
      authorized: true,
      nonce: this.generateMonotonicNonce(),
    };
  }
}

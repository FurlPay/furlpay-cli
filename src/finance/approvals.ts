/**
 * Financial Approval Engine — human-in-the-loop authorization.
 *
 * Inspired by Grok Bot's virtual-card / spend approval flows, rebuilt on
 * FurlPay's rules:
 * - An approval is bound to the EXACT transaction parameters. The canonical
 *   parameter hash (sha256) is stored at creation; if the amount, asset,
 *   network or destination changes afterwards, resolution is refused — the
 *   request must be re-created against the new parameters.
 * - Expiring: every request carries expiresAt (default 10 minutes). An
 *   expired request cannot be approved.
 * - Single-use: an approval is consumed exactly once by the orchestrator
 *   (APPROVED → EXECUTED). Replaying a consumed approval is refused.
 * - Human-resolved: `approve` is a deliberate CLI action. There is no
 *   programmatic approve API on the MCP surface (deny and read-only are) —
 *   AI-generated instructions can never grant financial authorization.
 * - Every resolution writes an audit record into the stored request.
 */

import * as crypto from "crypto";
import { readJsonStore, writeJsonStoreAtomic, financeDir } from "./store";
import { join } from "path";

export type ApprovalState =
  | "REQUEST_CREATED" | "RISK_VALIDATION" | "AWAITING_APPROVAL"
  | "APPROVED" | "EXECUTED" | "DENIED" | "EXPIRED" | "CANCELLED";

export interface ApprovalParams {
  /** Minor units. */
  minor: bigint;
  unit: string;
  network?: string;
  destination: string;
  source?: string;
  type: string;
  /** Fee estimate in the same unit's minor units (0 when unknown-but-estimated-later). */
  feeMinor?: bigint;
}

export interface ApprovalRequest {
  id: string;
  params: { minor: string; unit: string; network?: string; destination: string; source?: string; type: string; feeMinor?: string };
  /** sha256 over the canonical parameter serialization — the binding. */
  paramsHash: string;
  state: ApprovalState;
  riskAssessment: { level: "low" | "medium" | "high"; notes: string };
  requiredAuthLevel: "user" | "user+passkey";
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** Set by the orchestrator when the approval is consumed. */
  executedRef?: string;
  audit: { at: string; event: string; detail?: string }[];
}

interface ApprovalsStore {
  schema: "furlpay-finance-approvals-v1";
  requests: ApprovalRequest[];
}

export function paramsHashOf(p: ApprovalParams): string {
  // Key insertion order is the canonicalization — object literals serialize
  // in insertion order, so this is stable regardless of how the caller built
  // their params object.
  const canonical = JSON.stringify({
    destination: p.destination.trim(),
    feeMinor: p.feeMinor?.toString(),
    minor: p.minor.toString(),
    network: p.network ? p.network.toLowerCase() : undefined,
    source: p.source?.trim(),
    type: p.type,
    unit: p.unit.toUpperCase(),
  });
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

export class ApprovalEngine {
  private requests: ApprovalRequest[] = [];
  private readonly filePath: string;
  private readonly nowMs: () => number;

  constructor(filePath?: string, nowMs: () => number = Date.now) {
    this.filePath = filePath || join(financeDir(), "approvals.json");
    this.nowMs = nowMs;
    const stored = readJsonStore<ApprovalsStore>(this.filePath);
    if (stored) {
      if (stored.schema !== "furlpay-finance-approvals-v1") {
        throw new Error(`Approvals store ${this.filePath} has an unrecognized format.`);
      }
      this.requests = stored.requests;
    }
  }

  private persist(): void {
    writeJsonStoreAtomic(this.filePath, { schema: "furlpay-finance-approvals-v1", requests: this.requests });
  }

  /**
   * Create (or return the OPEN request for identical params — creating a
   * duplicate open request for the same parameters would let one approval
   * authorize two parallel executions if callers confused them; instead the
   * existing open request is returned so resolution is unambiguous).
   */
  create(params: ApprovalParams, risk: { level: "low" | "medium" | "high"; notes: string }, ttlMs = 10 * 60_000): ApprovalRequest {
    const open = this.requests.find(
      (r) => r.paramsHash === paramsHashOf(params) && (r.state === "AWAITING_APPROVAL" || r.state === "RISK_VALIDATION" || r.state === "REQUEST_CREATED")
    );
    if (open) return open;
    const now = new Date(this.nowMs()).toISOString();
    const req: ApprovalRequest = {
      id: `apr_${this.nowMs()}_${crypto.randomBytes(4).toString("hex")}`,
      params: {
        minor: params.minor.toString(),
        unit: params.unit.toUpperCase(),
        network: params.network?.toLowerCase(),
        destination: params.destination.trim(),
        source: params.source?.trim(),
        type: params.type,
        feeMinor: params.feeMinor?.toString(),
      },
      paramsHash: paramsHashOf(params),
      state: "RISK_VALIDATION",
      riskAssessment: risk,
      requiredAuthLevel: "user",
      createdAt: now,
      expiresAt: new Date(this.nowMs() + ttlMs).toISOString(),
      audit: [{ at: now, event: "REQUEST_CREATED", detail: `risk=${risk.level}` }],
    };
    req.state = "AWAITING_APPROVAL";
    req.audit.push({ at: now, event: "AWAITING_APPROVAL", detail: `expires ${req.expiresAt}` });
    this.requests.push(req);
    this.persist();
    return req;
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  list(filter?: { state?: ApprovalState | "open" }): ApprovalRequest[] {
    let out = [...this.requests];
    if (filter?.state === "open") {
      out = out.filter((r) => r.state === "AWAITING_APPROVAL" || r.state === "RISK_VALIDATION" || r.state === "REQUEST_CREATED");
    } else if (filter?.state) {
      out = out.filter((r) => r.state === filter.state);
    }
    return out.reverse();
  }

  /**
   * Approve a request. Binding is enforced: the caller re-presents the
   * CURRENT parameters and they must hash-match what was requested. Expired
   * or already-resolved requests are refused — a resolution is never guessed.
   */
  approve(id: string, currentParams: ApprovalParams, resolvedBy = "cli-user"): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.state !== "AWAITING_APPROVAL") {
      throw new Error(`Request ${id} is ${req.state}, not AWAITING_APPROVAL — approvals are single-use and cannot be re-resolved.`);
    }
    if (this.nowMs() >= Date.parse(req.expiresAt)) {
      req.state = "EXPIRED";
      req.resolvedAt = new Date(this.nowMs()).toISOString();
      req.audit.push({ at: req.resolvedAt, event: "EXPIRED" });
      this.persist();
      throw new Error(`Request ${id} expired at ${req.expiresAt} — create a new approval against the current parameters.`);
    }
    const presented = paramsHashOf(currentParams);
    if (presented !== req.paramsHash) {
      req.audit.push({
        at: new Date(this.nowMs()).toISOString(),
        event: "PARAMS_MISMATCH_REFUSED",
        detail: "parameters changed since the request was created",
      });
      this.persist();
      throw new Error(
        `Parameter binding mismatch for ${id}: the transaction parameters changed after the request was created ` +
          `(expected ${req.paramsHash.slice(0, 10)}…, present ${presented.slice(0, 10)}…). The stale approval is void — create a new request.`
      );
    }
    const at = new Date(this.nowMs()).toISOString();
    req.state = "APPROVED";
    req.resolvedAt = at;
    req.resolvedBy = resolvedBy;
    req.audit.push({ at, event: "APPROVED", detail: `by ${resolvedBy}` });
    this.persist();
    return req;
  }

  deny(id: string, reason: string, resolvedBy = "cli-user"): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.state !== "AWAITING_APPROVAL" && req.state !== "RISK_VALIDATION" && req.state !== "REQUEST_CREATED") {
      throw new Error(`Request ${id} is ${req.state} and cannot be denied.`);
    }
    const at = new Date(this.nowMs()).toISOString();
    req.state = "DENIED";
    req.resolvedAt = at;
    req.resolvedBy = resolvedBy;
    req.audit.push({ at, event: "DENIED", detail: reason.slice(0, 200) });
    this.persist();
    return req;
  }

  cancel(id: string, reason: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.state !== "AWAITING_APPROVAL" && req.state !== "REQUEST_CREATED" && req.state !== "RISK_VALIDATION") {
      throw new Error(`Request ${id} is ${req.state} and cannot be cancelled.`);
    }
    const at = new Date(this.nowMs()).toISOString();
    req.state = "CANCELLED";
    req.resolvedAt = at;
    req.audit.push({ at, event: "CANCELLED", detail: reason.slice(0, 200) });
    this.persist();
    return req;
  }

  /**
   * Orchestrator-only: consume an APPROVED request for execution. The
   * presented parameters must still hash-match (double binding — parameters
   * are re-verified at execution time, not just at approval time). Single-use
   * by construction: the state moves to EXECUTED and can never be approved
   * again.
   */
  consumeForExecution(id: string, currentParams: ApprovalParams, executedRef: string): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.state !== "APPROVED") {
      throw new Error(`Request ${id} is ${req.state} — only APPROVED requests can execute.`);
    }
    if (this.nowMs() >= Date.parse(req.expiresAt)) {
      req.state = "EXPIRED";
      this.persist();
      throw new Error(`Request ${id} expired before execution — approval and execution must happen within the TTL.`);
    }
    const presented = paramsHashOf(currentParams);
    if (presented !== req.paramsHash) {
      throw new Error(`Execution binding mismatch for ${id} — parameters moved between approval and execution. Refusing.`);
    }
    const at = new Date(this.nowMs()).toISOString();
    req.state = "EXECUTED";
    req.executedRef = executedRef;
    req.audit.push({ at, event: "EXECUTED", detail: `ref ${executedRef}` });
    this.persist();
    return req;
  }

  private mustGet(id: string): ApprovalRequest {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`Unknown approval request ${id}.`);
    return req;
  }
}

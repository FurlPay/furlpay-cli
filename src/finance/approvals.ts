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
import { withExclusiveLock } from "./fileLock";

export type ApprovalState =
  | "REQUEST_CREATED" | "RISK_VALIDATION" | "AWAITING_APPROVAL"
  | "APPROVED" | "RESERVED" | "EXECUTED" | "DENIED" | "EXPIRED" | "CANCELLED";

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
  /** Owner token of the active reservation — a failed execution may only
   *  release its OWN reservation, never a concurrent one (readiness P23). */
  reservationOwner?: string;
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
    // Absent fee IS zero fee (readiness P23): a caller that omits feeMinor
    // states the same economics as one that passes 0n — both hash identically,
    // while any non-zero fee hashes differently and is refused.
    feeMinor: (p.feeMinor ?? 0n).toString(),
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
    // Constructor read goes through the SAME cross-process lock as every
    // mutation: on Windows a reader that catches the file mid-rename would
    // otherwise EPERM the writer (readiness P23 multi-process safety).
    withExclusiveLock(this.filePath, () => this.reload());
  }

  /** Re-read the store from disk — used under the lock before any mutation. */
  private reload(): void {
    const stored = readJsonStore<ApprovalsStore>(this.filePath);
    if (stored) {
      if (stored.schema !== "furlpay-finance-approvals-v1") {
        throw new Error(`Approvals store ${this.filePath} has an unrecognized format.`);
      }
      this.requests = stored.requests;
    } else {
      this.requests = [];
    }
  }

  private persist(): void {
    writeJsonStoreAtomic(this.filePath, { schema: "furlpay-finance-approvals-v1", requests: this.requests });
  }

  /**
   * Mutate under the cross-process lock: reload from disk FIRST so a stale
   * in-memory view can never authorize against approvals another process
   * already resolved, then run the mutation, then persist — all while
   * holding the exclusive lock (readiness P23). Persisting in `finally`
   * keeps refusal audit entries (EXPIRED, PARAMS_MISMATCH_REFUSED) durable
   * even when the mutation throws.
   */
  private mutate<T>(fn: () => T): T {
    return withExclusiveLock(this.filePath, () => {
      this.reload();
      try {
        return fn();
      } finally {
        this.persist();
      }
    });
  }

  /**
   * Create (or return the OPEN request for identical params — creating a
   * duplicate open request for the same parameters would let one approval
   * authorize two parallel executions if callers confused them; instead the
   * existing open request is returned so resolution is unambiguous).
   */
  create(params: ApprovalParams, risk: { level: "low" | "medium" | "high"; notes: string }, ttlMs = 10 * 60_000): ApprovalRequest {
    return this.mutate(() => {
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
      return req;
    });
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
    return this.mutate(() => {
      const req = this.mustGet(id);
      if (req.state !== "AWAITING_APPROVAL") {
        throw new Error(`Request ${id} is ${req.state}, not AWAITING_APPROVAL — approvals are single-use and cannot be re-resolved.`);
      }
      if (this.nowMs() >= Date.parse(req.expiresAt)) {
        req.state = "EXPIRED";
        req.resolvedAt = new Date(this.nowMs()).toISOString();
        req.audit.push({ at: req.resolvedAt, event: "EXPIRED" });
        throw new Error(`Request ${id} expired at ${req.expiresAt} — create a new approval against the current parameters.`);
      }
      const presented = paramsHashOf(currentParams);
      if (presented !== req.paramsHash) {
        req.audit.push({
          at: new Date(this.nowMs()).toISOString(),
          event: "PARAMS_MISMATCH_REFUSED",
          detail: "parameters changed since the request was created",
        });
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
      return req;
    });
  }

  deny(id: string, reason: string, resolvedBy = "cli-user"): ApprovalRequest {
    return this.mutate(() => {
      const req = this.mustGet(id);
      if (req.state !== "AWAITING_APPROVAL" && req.state !== "RISK_VALIDATION" && req.state !== "REQUEST_CREATED") {
        throw new Error(`Request ${id} is ${req.state} and cannot be denied.`);
      }
      const at = new Date(this.nowMs()).toISOString();
      req.state = "DENIED";
      req.resolvedAt = at;
      req.resolvedBy = resolvedBy;
      req.audit.push({ at, event: "DENIED", detail: reason.slice(0, 200) });
      return req;
    });
  }

  cancel(id: string, reason: string): ApprovalRequest {
    return this.mutate(() => {
      const req = this.mustGet(id);
      if (req.state !== "AWAITING_APPROVAL" && req.state !== "REQUEST_CREATED" && req.state !== "RISK_VALIDATION") {
        throw new Error(`Request ${id} is ${req.state} and cannot be cancelled.`);
      }
      const at = new Date(this.nowMs()).toISOString();
      req.state = "CANCELLED";
      req.resolvedAt = at;
      req.audit.push({ at, event: "CANCELLED", detail: reason.slice(0, 200) });
      return req;
    });
  }

  /**
   * Pure binding check — NO writes, NO state changes. The orchestrator calls
   * this before reserving so a parameter mismatch can never leave a partial
   * execution trail (readiness P23: the old ordering committed the ledger
   * before the binding threw, leaving an orphaned payment).
   */
  assertBinding(id: string, currentParams: ApprovalParams): ApprovalRequest {
    const req = this.mustGet(id);
    if (req.state !== "APPROVED" && req.state !== "RESERVED") {
      throw new Error(`APPROVAL_NOT_EXECUTABLE: request ${id} is ${req.state} — only APPROVED requests can execute.`);
    }
    if (this.nowMs() >= Date.parse(req.expiresAt)) {
      throw new Error(`APPROVAL_EXPIRED: request ${id} expired at ${req.expiresAt}.`);
    }
    const presented = paramsHashOf(currentParams);
    if (presented !== req.paramsHash) {
      throw new Error(`EXECUTION_BINDING_MISMATCH for ${id} — parameters moved between approval and execution (expected ${req.paramsHash.slice(0, 10)}…, present ${presented.slice(0, 10)}…). Refusing.`);
    }
    return req;
  }

  /**
   * Compare-and-swap reservation: APPROVED → RESERVED. Exactly one caller
   * can hold the reservation (a second reserve on RESERVED throws), so one
   * approval funds exactly one payment even under parallel calls.
   *
   * Returns a one-time OWNER TOKEN: only the caller that won the reservation
   * can finalize or release it. A loser whose reserve threw holds no token
   * and therefore cannot release the winner's reservation (readiness P23).
   */
  reserveForExecution(id: string, currentParams: ApprovalParams): { request: ApprovalRequest; ownerToken: string } {
    return this.mutate(() => {
      const req = this.assertBinding(id, currentParams);
      if (req.state === "RESERVED") {
        throw new Error(`APPROVAL_ALREADY_RESERVED: request ${id} is reserved by another execution in progress.`);
      }
      const at = new Date(this.nowMs()).toISOString();
      const ownerToken = crypto.randomUUID();
      req.state = "RESERVED";
      req.reservationOwner = ownerToken;
      req.audit.push({ at, event: "RESERVED_FOR_EXECUTION", detail: `owner ${ownerToken.slice(0, 8)}…` });
      return { request: req, ownerToken };
    });
  }

  /** RESERVED → EXECUTED with the real ledger reference. Owner-gated. */
  finalizeExecution(id: string, ownerToken: string, executedRef: string): ApprovalRequest {
    return this.mutate(() => {
      const req = this.mustGet(id);
      if (req.state !== "RESERVED") {
        throw new Error(`APPROVAL_NOT_RESERVED: request ${id} is ${req.state} — finalize requires an active reservation.`);
      }
      this.assertReservationOwner(req, ownerToken);
      const at = new Date(this.nowMs()).toISOString();
      req.state = "EXECUTED";
      req.executedRef = executedRef;
      delete req.reservationOwner;
      req.audit.push({ at, event: "EXECUTED", detail: `ref ${executedRef}` });
      return req;
    });
  }

  /**
   * RESERVED → APPROVED: the reservation OWNER releases after a provable
   * non-send (posting failed). A caller without the owner token is refused —
   * a concurrent loser cannot release the winner's reservation and re-arm
   * the approval for a second execution (readiness P23).
   */
  releaseReservation(id: string, ownerToken: string, reason: string): ApprovalRequest {
    return this.mutate(() => {
      const req = this.mustGet(id);
      if (req.state !== "RESERVED") {
        throw new Error(`APPROVAL_NOT_RESERVED: request ${id} is ${req.state}.`);
      }
      this.assertReservationOwner(req, ownerToken);
      const at = new Date(this.nowMs()).toISOString();
      req.state = "APPROVED";
      delete req.reservationOwner;
      req.audit.push({ at, event: "RESERVATION_RELEASED", detail: reason.slice(0, 200) });
      return req;
    });
  }

  private assertReservationOwner(req: ApprovalRequest, ownerToken: string): void {
    if (!req.reservationOwner || req.reservationOwner !== ownerToken) {
      throw new Error(
        `RESERVATION_OWNER_MISMATCH: caller does not hold the reservation for ${req.id} — ` +
          `only the execution that won the reservation may finalize or release it.`
      );
    }
  }

  private mustGet(id: string): ApprovalRequest {
    const req = this.requests.find((r) => r.id === id);
    if (!req) throw new Error(`Unknown approval request ${id}.`);
    return req;
  }
}

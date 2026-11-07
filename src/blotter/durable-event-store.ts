/**
 * FurlPay Durable Event Store & Audit Log (2026)
 * 
 * Provides an append-only cryptographic event ledger preserving:
 * - Trade intents and risk evaluations
 * - Authorizations and cryptographic signatures
 * - Submissions, fills, and cancellations
 * - Periodic exchange reconciliation audits
 */

import crypto from "crypto";

export type FurlPayEventType =
  | "INTENT_CREATED"
  | "RISK_EVALUATION"
  | "AUTHORIZATION_GRANTED"
  | "ORDER_SUBMITTED"
  | "ORDER_RESTING"
  | "FILL_RECORDED"
  | "ORDER_CANCELLED"
  | "RECONCILIATION_AUDIT"
  | "KILL_SWITCH_TRIGGERED";

export interface AuditEvent {
  sequence: number;
  eventId: string;
  timestamp: number;
  type: FurlPayEventType;
  payload: any;
  previousHash: string;
  hash: string;
}

export class DurableEventStore {
  private events: AuditEvent[] = [];
  private sequence: number = 0;
  private lastHash: string = "0x0000000000000000000000000000000000000000000000000000000000000000";

  public appendEvent(type: FurlPayEventType, payload: any): AuditEvent {
    this.sequence++;
    const now = Date.now();
    const eventId = `ev_${now}_${this.sequence}`;

    const rawStr = JSON.stringify({
      sequence: this.sequence,
      eventId,
      timestamp: now,
      type,
      payload,
      previousHash: this.lastHash,
    });

    const hash = "0x" + crypto.createHash("sha256").update(rawStr).digest("hex");

    const event: AuditEvent = {
      sequence: this.sequence,
      eventId,
      timestamp: now,
      type,
      payload,
      previousHash: this.lastHash,
      hash,
    };

    this.events.push(event);
    this.lastHash = hash;
    return event;
  }

  public getEvents(typeFilter?: FurlPayEventType): AuditEvent[] {
    if (!typeFilter) return [...this.events];
    return this.events.filter((e) => e.type === typeFilter);
  }

  public getEventCount(): number {
    return this.events.length;
  }

  public verifyIntegrity(): boolean {
    let prev = "0x0000000000000000000000000000000000000000000000000000000000000000";
    for (const e of this.events) {
      if (e.previousHash !== prev) return false;
      const rawStr = JSON.stringify({
        sequence: e.sequence,
        eventId: e.eventId,
        timestamp: e.timestamp,
        type: e.type,
        payload: e.payload,
        previousHash: e.previousHash,
      });
      const expected = "0x" + crypto.createHash("sha256").update(rawStr).digest("hex");
      if (e.hash !== expected) return false;
      prev = e.hash;
    }
    return true;
  }
}

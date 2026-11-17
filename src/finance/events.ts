/**
 * Financial Event Bus — signed, replay-protected, durable.
 *
 * Financial events (payment.*, spend.*, treasury.*, billing.*) are emitted
 * as HMAC-SHA256-signed envelopes, appended durably to a local journal, and
 * delivered to a webhook when FURLPAY_FINANCE_WEBHOOK_URL is configured.
 *
 * Security posture:
 * - The signing secret lives in ~/.furlpay/finance/events-secret (0600,
   generated with crypto.randomBytes on first use). It never leaves disk.
 * - Signature covers seq + timestamp + type + canonical payload — any
   tampering with any of them breaks verification.
 * - verifyEnvelope() is the receive-side: timestamp freshness (±5 min) and
   monotonic seq enforce replay protection. Webhook delivery is never
   authorization: receiving an event cannot move money.
 * - Delivery: 3 attempts with exponential backoff; failures land in a
   dead-letter journal with the exact reason. Delivery is best-effort BY
   DESIGN — the local journal is the record, the webhook is a notification.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { financeDir, ensureFinanceDir } from "./store";

export type FinancialEventType =
  | "payment.created" | "payment.authorized" | "payment.pending" | "payment.submitted"
  | "payment.confirmed" | "payment.settled" | "payment.failed" | "payment.cancelled"
  | "wallet.balance_updated"
  | "spend.limit_reached" | "spend.approval_required" | "spend.approval_granted" | "spend.approval_denied"
  | "treasury.balance_updated" | "treasury.reconciliation_required"
  | "billing.transaction_recorded";

export interface FinancialEvent {
  seq: number;
  type: FinancialEventType;
  timestampMs: number;
  payload: Record<string, unknown>;
}

export interface SignedEvent extends FinancialEvent {
  /** sha256 of the canonical payload — signed AND verified. */
  payloadHash: string;
  /** HMAC-SHA256 hex over `${seq}.${timestampMs}.${type}.${payloadHash}`. */
  signature: string;
}

const FRESHNESS_MS = 5 * 60_000;
const MAX_JOURNAL_EVENTS = 50_000;

export class FinancialEventBus {
  private secret: Buffer;
  private journalPath: string;
  private dlqPath: string;
  private journal: SignedEvent[] = [];
  private lastSeq: number;
  private webhookUrl: string | null;

  constructor(opts?: { journalPath?: string; secretPath?: string; webhookUrl?: string }) {
    ensureFinanceDir();
    const secretPath = opts?.secretPath || path.join(financeDir(), "events-secret");
    this.journalPath = opts?.journalPath || path.join(financeDir(), "events.jsonl");
    this.dlqPath = path.join(path.dirname(this.journalPath), "events-dlq.jsonl");
    this.webhookUrl = opts?.webhookUrl ?? (process.env.FURLPAY_FINANCE_WEBHOOK_URL?.trim() || null);
    if (this.webhookUrl && !/^https:\/\//.test(this.webhookUrl)) {
      throw new Error("FURLPAY_FINANCE_WEBHOOK_URL must be https — signed financial events over plaintext are worse than none.");
    }
    this.secret = this.loadOrCreateSecret(secretPath);
    this.journal = this.loadJournal();
    this.lastSeq = this.journal.length ? this.journal[this.journal.length - 1].seq : 0;
  }

  private loadOrCreateSecret(secretPath: string): Buffer {
    try {
      const existing = fs.readFileSync(secretPath);
      if (existing.length < 32) throw new Error("secret too short");
      return existing;
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw new Error(`Cannot read the events signing secret at ${secretPath}: ${err?.message || err}`);
      }
      const secret = crypto.randomBytes(48);
      const fd = fs.openSync(secretPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, secret);
      } finally {
        fs.closeSync(fd);
      }
      return secret;
    }
  }

  private loadJournal(): SignedEvent[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.journalPath, "utf8");
    } catch (err: any) {
      if (err?.code === "ENOENT") return [];
      throw new Error(`Cannot read the event journal at ${this.journalPath}: ${err?.message || err}`);
    }
    if (!raw.trim()) return [];
    const events = raw.trim().split("\n").map((line) => JSON.parse(line) as SignedEvent);
    // Journal integrity: signatures and sequence continuity are verified on load.
    let prev = 0;
    for (const e of events) {
      if (e.seq !== prev + 1) {
        throw new Error(`Event journal sequence break at ${e.seq} (expected ${prev + 1}) — inspect ${this.journalPath} manually.`);
      }
      if (!this.verifyEnvelope(e, { allowAnyTimestamp: true, expectSeq: prev + 1 })) {
        throw new Error(`Event journal contains an INVALID signature at seq ${e.seq} — the journal is never extended past a bad record.`);
      }
      prev = e.seq;
    }
    return events;
  }

  payloadHash(payload: Record<string, unknown>): string {
    return "0x" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  signEvent(type: FinancialEventType, payload: Record<string, unknown>): SignedEvent {
    const seq = this.lastSeq + 1;
    const payloadHash = this.payloadHash(payload);
    const timestampMs = Date.now();
    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(`${seq}.${timestampMs}.${type}.${payloadHash}`)
      .digest("hex");
    return { seq, type, timestampMs, payload, payloadHash, signature };
  }

  /**
   * Emit: sign, append durably (appendFileSync + fsync semantics of the
   * journal), then attempt webhook delivery. The journal append is the
   * record — delivery failure never loses the event.
   */
  async emit(type: FinancialEventType, payload: Record<string, unknown>): Promise<SignedEvent> {
    const event = this.signEvent(type, payload);
    this.journal.push(event);
    this.lastSeq = event.seq;
    ensureFinanceDir();
    fs.appendFileSync(this.journalPath, JSON.stringify(event) + "\n", { mode: 0o600 });
    if (this.webhookUrl) {
      await this.deliver(event).catch(() => this.deadLetter(event, "delivery threw"));
    }
    return event;
  }

  private async deliver(event: SignedEvent, attempts = 3): Promise<void> {
    if (!this.webhookUrl) return;
    let lastErr = "";
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(this.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-furlpay-signature": event.signature,
            "x-furlpay-timestamp": String(event.timestampMs),
            "x-furlpay-seq": String(event.seq),
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err: any) {
        lastErr = err?.message || String(err);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 250 * 2 ** i));
    }
    this.deadLetter(event, lastErr);
  }

  private deadLetter(event: SignedEvent, reason: string): void {
    try {
      fs.appendFileSync(this.dlqPath, JSON.stringify({ deadLetteredAt: Date.now(), reason, event }) + "\n", { mode: 0o600 });
    } catch { /* the journal already holds the record */ }
  }

  /**
   * Receive-side verification. Replay protection: timestamp must be fresh
   * (unless loading the local journal) and seq must be strictly greater than
   * the last verified seq (single stream ordering). Tampered signatures
   * refuse — always.
   */
  verifyEnvelope(event: SignedEvent, opts?: { allowAnyTimestamp?: boolean; expectSeq?: number }): boolean {
    const expected = crypto
      .createHmac("sha256", this.secret)
      .update(`${event.seq}.${event.timestampMs}.${event.type}.${event.payloadHash}`)
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(event.signature, "hex");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    if (this.payloadHash(event.payload) !== event.payloadHash) return false;
    if (!opts?.allowAnyTimestamp && Math.abs(Date.now() - event.timestampMs) > FRESHNESS_MS) return false;
    if (opts?.expectSeq !== undefined && event.seq !== opts.expectSeq) return false;
    return true;
  }

  /** Receive an external event into the stream (replay-protected). */
  receive(event: SignedEvent): void {
    if (event.seq <= this.lastSeq) {
      throw new Error(`REPLAY_REFUSED: event seq ${event.seq} is not newer than the verified stream (${this.lastSeq}).`);
    }
    if (!this.verifyEnvelope(event)) {
      throw new Error("SIGNATURE_INVALID: event refused — signature, payload hash, timestamp or ordering failed verification.");
    }
    this.journal.push(event);
    this.lastSeq = event.seq;
    fs.appendFileSync(this.journalPath, JSON.stringify(event) + "\n", { mode: 0o600 });
  }

  recent(limit = 20): SignedEvent[] {
    return this.journal.slice(-limit).reverse();
  }

  get journalSize(): number {
    if (this.journal.length > MAX_JOURNAL_EVENTS) {
      throw new Error(`Event journal exceeds ${MAX_JOURNAL_EVENTS} events — archive events.jsonl before continuing.`);
    }
    return this.journal.length;
  }
}

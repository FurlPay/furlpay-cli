/**
 * FurlPay Durable Event Store & Audit Log (2026)
 *
 * Provides an append-only cryptographic event ledger preserving:
 * - Trade intents and risk evaluations
 * - Authorizations and cryptographic signatures
 * - Submissions, fills, and cancellations
 * - Periodic exchange reconciliation audits
 *
 * DURABILITY CONTRACT (2026-11-17 gap-closure): when constructed with a
 * file path (production callers use defaultBlotterPath() →
 * ~/.furlpay/blotter/events.json), every append is synchronously flushed
 * through an atomic temp-file+rename before the event is returned, mirroring
 * the escrow store's write discipline. The previous build kept events in a
 * process-local array — the hash chain verified correctly and then
 * evaporated on exit, which made the name "durable" a fabrication. The bare
 * constructor stays in-memory (tests, ephemeral sessions); check
 * isPersistent() to know which mode you have.
 */

import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

const GENESIS_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SCHEMA = "furlpay-blotter-v2";

interface BlotterFile {
  schema: string;
  createdAt: number;
  events: AuditEvent[];
}

export interface DurableEventStoreOptions {
  /** File path for persistent mode; omit (or null) for in-memory mode. */
  filePath?: string | null;
  /** Max persisted file size before append refuses (default 16 MB). */
  maxFileBytes?: number;
  /** Injectable fs write for tests. */
  writeFileSyncImpl?: (p: string, data: string) => void;
}

export class DurableEventStore {
  private events: AuditEvent[] = [];
  private sequence: number = 0;
  private lastHash: string = GENESIS_HASH;
  private readonly filePath: string | null;
  private readonly maxFileBytes: number;
  private readonly writeImpl: (p: string, data: string) => void;

  constructor(options?: DurableEventStoreOptions) {
    // Bare construction keeps the legacy in-memory behavior (pinned by the
    // production-core test suite). Production callers opt into durability by
    // passing a filePath — defaultBlotterPath() is provided for that.
    this.filePath = options?.filePath ?? null;
    this.maxFileBytes = options?.maxFileBytes ?? 16 * 1024 * 1024;
    this.writeImpl = options?.writeFileSyncImpl ?? ((p, data) => fs.writeFileSync(p, data, { mode: 0o600 }));

    if (this.filePath) {
      this.loadFromDisk();
    }
  }

  /** True when events survive process exit (file-backed). */
  public isPersistent(): boolean {
    return this.filePath !== null;
  }

  public getFilePath(): string | null {
    return this.filePath;
  }

  private loadFromDisk(): void {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return; // fresh ledger
      throw new Error(`Blotter read failed (${this.filePath}): ${e?.message || e}`);
    }

    let parsed: BlotterFile;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(
        `Blotter file corrupt (${this.filePath}): ${e?.message || e}. ` +
          `Refusing to silently truncate an audit ledger — inspect or move the file manually.`
      );
    }
    if (parsed?.schema !== SCHEMA) {
      throw new Error(`Blotter file schema mismatch (${this.filePath}): expected ${SCHEMA}, got ${String(parsed?.schema)}`);
    }
    if (!this.verifyChain(parsed.events)) {
      throw new Error(
        `Blotter hash chain INVALID on load (${this.filePath}). ` +
          `An audit ledger that fails verification must not be extended — inspect or move the file manually.`
      );
    }
    this.events = parsed.events;
    this.sequence = parsed.events.length ? parsed.events[parsed.events.length - 1].sequence : 0;
    this.lastHash = parsed.events.length ? parsed.events[parsed.events.length - 1].hash : GENESIS_HASH;
  }

  private static computeHash(e: Omit<AuditEvent, "hash">): string {
    const rawStr = JSON.stringify({
      sequence: e.sequence,
      eventId: e.eventId,
      timestamp: e.timestamp,
      type: e.type,
      payload: e.payload,
      previousHash: e.previousHash,
    });
    return "0x" + crypto.createHash("sha256").update(rawStr).digest("hex");
  }

  private verifyChain(events: AuditEvent[]): boolean {
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const e of events) {
      if (e.previousHash !== prev || e.sequence !== expectedSeq) return false;
      if (e.hash !== DurableEventStore.computeHash(e)) return false;
      prev = e.hash;
      expectedSeq++;
    }
    return true;
  }

  public appendEvent(type: FurlPayEventType, payload: any): AuditEvent {
    this.sequence++;
    const now = Date.now();
    const eventId = `ev_${now}_${this.sequence}`;

    const pending: Omit<AuditEvent, "hash"> = {
      sequence: this.sequence,
      eventId,
      timestamp: now,
      type,
      payload,
      previousHash: this.lastHash,
    };

    const hash = DurableEventStore.computeHash(pending);
    const event: AuditEvent = { ...pending, hash };

    this.events.push(event);
    this.lastHash = hash;

    if (this.filePath) {
      this.flushToDisk();
    }
    return event;
  }

  /**
   * Atomic persistence: serialize the full ledger, write to a unique temp
   * file in the same directory, then rename over the target. A crash
   * mid-write leaves either the old or the new complete file — never a torn
   * ledger. (Same discipline as src/settlement/escrowStore.ts.)
   */
  private flushToDisk(): void {
    if (!this.filePath) return;
    const file: BlotterFile = { schema: SCHEMA, createdAt: this.events[0]?.timestamp ?? Date.now(), events: this.events };
    const data = JSON.stringify(file);
    if (Buffer.byteLength(data) > this.maxFileBytes) {
      throw new Error(
        `BLOTTER_CAPACITY: persisted ledger exceeds ${this.maxFileBytes} bytes at ${this.filePath}. ` +
          `Archive or rotate the file before appending further audit events.`
      );
    }
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.blotter-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
    this.writeImpl(tmp, data);
    fs.renameSync(tmp, this.filePath);
  }

  public getEvents(typeFilter?: FurlPayEventType): AuditEvent[] {
    if (!typeFilter) return [...this.events];
    return this.events.filter((e) => e.type === typeFilter);
  }

  public getEventCount(): number {
    return this.events.length;
  }

  public verifyIntegrity(): boolean {
    return this.verifyChain(this.events);
  }
}

/** Default ledger location: ~/.furlpay/blotter/events.json */
export function defaultBlotterPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".furlpay", "blotter", "events.json");
}

/**
 * Durable escrow store — persists EscrowStateMachine snapshots to disk so a
 * lifecycle spans multiple CLI invocations (create → fund → proof → release).
 *
 * Security posture (mirrors the A-3 config hardening from the 2026-11-12 audit):
 * - Atomic write: unique temp file (flag "wx", mode 0600) then rename.
 * - Symlink refusal on the target path before read and write.
 * - 0600 permissions on POSIX; private per-user directory under ~/.furlpay.
 * - Escrows hold addresses/hashes only — no private key material — so the
 *   file is plain JSON, never encrypted, and must never contain secrets.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EscrowSnapshot, EscrowStateMachine } from "./escrow";

export class EscrowStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath =
      filePath || path.join(os.homedir(), ".furlpay", "escrows.json");
  }

  get path(): string {
    return this.filePath;
  }

  private assertRegularFile(): void {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.filePath);
    } catch (err: any) {
      if (err && err.code === "ENOENT") return;
      throw new Error(`Cannot stat escrow store at ${this.filePath}: ${err?.message || err}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `Refusing to use ${this.filePath}: it is a symlink. Remove it and retry.`
      );
    }
    if (!st.isFile()) {
      throw new Error(`Refusing to use ${this.filePath}: not a regular file.`);
    }
    if (st.size > 8 * 1024 * 1024) {
      throw new Error(`Escrow store at ${this.filePath} is implausibly large (>8MB); refusing to parse.`);
    }
  }

  list(): EscrowSnapshot[] {
    this.assertRegularFile();
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (err: any) {
      if (err && err.code === "ENOENT") return [];
      throw new Error(`Cannot read escrow store at ${this.filePath}: ${err?.message || err}`);
    }
    if (!raw.trim()) return [];
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Escrow store at ${this.filePath} is corrupt (invalid JSON). Restore or delete it before continuing.`
      );
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.escrows)) {
      throw new Error(`Escrow store at ${this.filePath} has an unrecognized format.`);
    }
    const limit = 10_000;
    if (parsed.escrows.length > limit) {
      throw new Error(`Escrow store at ${this.filePath} exceeds ${limit} entries; refusing to load.`);
    }
    return parsed.escrows as EscrowSnapshot[];
  }

  get(escrowId: string): EscrowSnapshot | undefined {
    const id = String(escrowId || "").trim();
    if (!id) throw new Error("Escrow ID is required.");
    return this.list().find((s) => s.terms.escrowId === id);
  }

  /** Deserialize an id into a live state machine (throws if unknown). */
  loadMachine(escrowId: string): EscrowStateMachine {
    const snapshot = this.get(escrowId);
    if (!snapshot) {
      throw new Error(`Escrow '${escrowId}' not found. Use 'furlpay escrow status' to list known escrows.`);
    }
    return EscrowStateMachine.deserialize(snapshot);
  }

  /** Upsert a machine snapshot keyed by its escrowId. */
  save(machine: EscrowStateMachine): void {
    const snapshot = machine.serialize();
    const escrows = this.list().filter(
      (s) => s.terms.escrowId !== snapshot.terms.escrowId
    );
    escrows.push(snapshot);
    this.writeAll(escrows);
  }

  private writeAll(escrows: EscrowSnapshot[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertRegularFile();

    const contents = JSON.stringify({ schema: "furlpay-escrow-store-v1", escrows }, null, 2);
    const temporary = path.join(
      directory,
      `.escrows-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`
    );
    try {
      fs.writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* already renamed */
      }
    }
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        /* best-effort */
      }
    }
  }
}

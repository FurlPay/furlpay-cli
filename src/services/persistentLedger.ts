/**
 * Durable, file-locked JSON ledgers for security-relevant state.
 *
 * P8 (2026-11-16 audit): x402 replay nonces and agent daily-spend counters
 * were ephemeral in-memory collections — every CLI/MCP process exit wiped
 * them, so the same EIP-3009 authorization could be replayed across
 * invocations and a spend-capped agent could evade its daily velocity limit
 * by simply being restarted. Both now persist in JSON ledgers under
 * ~/.furlpay/ledgers (0700 dir, 0600 files), mutated only under an exclusive
 * O_EXCL lock file with stale-lock recovery — the identical pattern used by
 * AgentKeyService.validateAndRecordSpend.
 *
 * HONEST THREAT MODEL: a local file ledger defends against process-boundary
 * replays and multi-process velocity evasion on ONE machine. It is not a
 * distributed store; a server-side facilitator still needs ACID/Redis-backed
 * idempotency (see docs/RELEASING.md scope notes).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getConfigDir } from "../config";

const STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 50;

/** Resolve (and create) the ledger directory: explicit dir > ~/.furlpay/ledgers. */
export function ledgerDir(customDir?: string): string {
  const dir = customDir || path.join(getConfigDir(), "ledgers");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * Run `fn` while holding an exclusive lock on filePath's lock file.
 * O_EXCL create; a lock older than STALE_LOCK_MS is treated as abandoned
 * (holder crashed) and broken. Throws after 10s rather than proceeding
 * unlocked — a lost lock must fail the operation, never race it.
 */
export function withLedgerLock<T>(filePath: string, fn: () => T): T {
  const lockPath = filePath + ".lock";
  const deadline = Date.now() + 10_000;
  let lockFd: number | null = null;

  while (lockFd === null && Date.now() < deadline) {
    try {
      lockFd = fs.openSync(lockPath, "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
      } catch {
        /* lock vanished — retry */
      }
      const wait = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
      void wait;
    }
  }
  if (lockFd === null) {
    throw new Error(`Could not acquire ledger lock for ${path.basename(filePath)} (busy >10s)`);
  }

  try {
    return fn();
  } finally {
    fs.closeSync(lockFd);
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Read a ledger file. Missing file → undefined; corrupt file THROWS — security state is never silently reset. */
export function readLedger<T>(filePath: string): T | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return undefined;
    throw new Error(`Ledger ${path.basename(filePath)} is corrupt: ${e.message}. ` + `Refusing to continue with reset security state — inspect or remove the file manually.`);
  }
}

/** Atomic (tmp+rename) ledger write, 0600. Caller must hold the ledger lock. */
export function writeLedger(filePath: string, data: unknown): void {
  const tmp = filePath + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

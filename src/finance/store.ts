/**
 * Durable JSON store primitives for the financial operations layer.
 *
 * Mirrors the EscrowStore security posture (2026-11-12 audit A-3) for every
 * finance record type — atomic write, symlink refusal, size caps, 0600 on
 * POSIX, private per-user directory under ~/.furlpay/finance. Finance stores
 * hold amounts, references and audit records — NEVER private key material —
 * so they are plain JSON and must never gain secrets.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Default finance data directory: ~/.furlpay/finance */
export function financeDir(): string {
  return path.join(os.homedir(), ".furlpay", "finance");
}

const MAX_STORE_BYTES = 32 * 1024 * 1024; // 32 MB — implausible for an honest local ledger

function assertRegularFile(filePath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err: any) {
    if (err && err.code === "ENOENT") return;
    throw new Error(`Cannot stat finance store at ${filePath}: ${err?.message || err}`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to use ${filePath}: it is a symlink. Remove it and retry.`);
  }
  if (!st.isFile()) {
    throw new Error(`Refusing to use ${filePath}: not a regular file.`);
  }
  if (st.size > MAX_STORE_BYTES) {
    throw new Error(`Finance store at ${filePath} is implausibly large (>32MB); refusing to parse.`);
  }
}

/** Ensures the finance directory exists with restrictive permissions (POSIX). */
export function ensureFinanceDir(): void {
  const dir = financeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Read a JSON store. Missing file → null (fresh store). Corrupt JSON → throws
 * with explicit guidance — an audit ledger is never silently reset.
 */
export function readJsonStore<T>(filePath: string): T | null {
  assertRegularFile(filePath);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err: any) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`Cannot read finance store at ${filePath}: ${err?.message || err}`);
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw new Error(
      `Finance store at ${filePath} is corrupt (invalid JSON): ${err?.message || err}. ` +
        `An audit ledger is never silently reset — restore or move the file manually.`
    );
  }
}

/**
 * Atomic write: unique temp file ("wx", mode 0600) then rename over the
 * target. Readers either see the complete previous file or the complete new
 * one — never a torn write.
 *
 * On Windows, rename over a file that another process momentarily has open
 * (a concurrent reader, a scanner) fails with EPERM/EACCES/EBUSY even though
 * nothing is wrong. The rename is retried briefly — the collision window is
 * microseconds — before giving up (readiness P23 multi-process safety).
 */
const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);
const RENAME_RETRIES = 12;
const RENAME_BACKOFF_MS = 25;

function renameWithRetry(from: string, to: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err: any) {
      lastErr = err;
      if (!err || !RENAME_RETRYABLE.has(err.code)) throw err;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS * (attempt + 1));
      } catch {
        /* environments without Atomics.wait degrade to immediate retry */
      }
    }
  }
  throw lastErr;
}

export function writeJsonStoreAtomic(filePath: string, data: unknown): void {
  ensureFinanceDir();
  assertRegularFile(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), { encoding: "utf8" });
    fs.closeSync(fd);
    fd = null;
    renameWithRetry(tmp, filePath);
  } catch (err: any) {
    throw new Error(`Finance store write failed (${filePath}): ${err?.message || err}`);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* renamed successfully */ }
  }
}

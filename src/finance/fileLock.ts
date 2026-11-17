/**
 * Cross-process exclusive file lock (readiness P23).
 *
 * The approval CAS (APPROVED → RESERVED) must hold across processes, not
 * just across async calls in one event loop. This is a minimal O_EXCL
 * create-lock with staleness recovery — a process that dies while holding
 * the lock leaves a stale file that the next contender breaks after the TTL.
 *
 * This is the pragmatic guard for the authorization path, NOT the general
 * transactional state store (readiness P15 owns that). Fail-closed: if the
 * lock cannot be acquired in time, the caller refuses.
 */

import * as fs from "fs";

const DEFAULT_TIMEOUT_MS = 3_000;
const STALE_TTL_MS = 5_000;
const RETRY_DELAY_MS = 20;

/** Synchronous sleep — Node allows Atomics.wait on the main thread. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without Atomics.wait: degrade to a bounded spin.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy-wait */ }
  }
}

export class LockTimeoutError extends Error {
  constructor(lockPath: string, timeoutMs: number) {
    super(`LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms — refusing rather than racing another process.`);
    this.name = "LockTimeoutError";
  }
}

interface HeldLock {
  lockPath: string;
  fd: number;
  release(): void;
}

/**
 * Blocking (synchronous) exclusive lock around `filePath`. Returns the
 * release handle. Sleeps between retries; breaks a stale lock older than
 * STALE_TTL_MS.
 */
export function acquireExclusiveLock(filePath: string, timeoutMs = DEFAULT_TIMEOUT_MS): HeldLock {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  let brokeStale = false;

  for (;;) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, String(process.pid));
      } catch {
        /* the lock content is advisory — the O_EXCL create IS the lock */
      }
      return {
        lockPath,
        fd,
        release(): void {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
          try {
            fs.unlinkSync(lockPath);
          } catch {
            /* a stale-breaker may have removed it */
          }
        },
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, a concurrent release's unlink leaves the name briefly
      // delete-pending: an open against it fails with EPERM/EBUSY even
      // though the lock is effectively free. Those are retryable — same
      // wait-and-retry as EEXIST, never an error to the caller.
      if (err.code !== "EEXIST" && err.code !== "EPERM" && err.code !== "EBUSY" && err.code !== "EACCES") throw err;
      // Lock exists (or is vanishing): break it when clearly stale (holder
      // died), else wait.
      try {
        const st = fs.statSync(lockPath);
        const age = Date.now() - st.mtimeMs;
        if (age > STALE_TTL_MS && !brokeStale) {
          fs.unlinkSync(lockPath);
          brokeStale = true; // only break once per acquisition attempt
          continue;
        }
      } catch {
        continue; // vanished — retry the create
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(lockPath, timeoutMs);
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

/** Run `fn` while holding the exclusive lock for `filePath`. */
export function withExclusiveLock<T>(filePath: string, fn: () => T, timeoutMs = DEFAULT_TIMEOUT_MS): T {
  const lock = acquireExclusiveLock(filePath, timeoutMs);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

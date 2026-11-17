/**
 * Untrusted-data sanitizer (readiness P7).
 *
 * Venue strings, asset names, memos and x402 headers are DATA, not
 * instructions. Anything an external party wrote flows through here before
 * it is echoed, stored, logged or embedded in a downstream call. Prompt
 * injection in a memo must never reach a tool-call argument unvalidated.
 *
 * Control characters (including newlines used to fake log lines and ANSI
 * escapes used to fake terminal output) are stripped, and everything is
 * length-capped — a 2 MB "asset name" is an attack, not a name.
 */

/** Strips control characters, collapses whitespace runs, length-caps. */
export function sanitizeUntrusted(input: unknown, maxLen = 200): string {
  if (input === undefined || input === null) return "";
  const raw = typeof input === "string" ? input : String(input);
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const collapsed = stripped.replace(/\s{2,}/g, " ").trim();
  if (collapsed.length > maxLen) return collapsed.slice(0, maxLen);
  return collapsed;
}

/** Numeric-ish untrusted values: parse defensively, clamp, never throw. */
export function sanitizeNumeric(input: unknown, maxAbs: number): number | null {
  const s = sanitizeUntrusted(input, 40).replace(/[,_\s]/g, "");
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), maxAbs);
}

/**
 * Canonical JSON hash of previewed arguments — the two-phase binding.
 * Field order is canonicalized so the confirm hash matches the preview hash
 * regardless of how the caller built their object.
 */
export function canonicalArgsHash(args: Record<string, unknown>): string {
  const crypto = require("crypto") as typeof import("crypto");
  const canonical = JSON.stringify(args, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce((acc, key) => {
        acc[key] = (v as Record<string, unknown>)[key];
        return acc;
      }, {} as Record<string, unknown>);
    }
    return v;
  });
  return "0x" + crypto.createHash("sha256").update(canonical).digest("hex");
}

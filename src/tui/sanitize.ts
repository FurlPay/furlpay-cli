/**
 * Terminal-output sanitizer for the TypeScript CLI surface (src/).
 *
 * Mirrors the canonical `sanitize()` in lib/terminal.js (A-5 remediation):
 * strips OSC/DCS/CSI escape sequences, control characters, line/paragraph
 * separators, and bidi/bidi-mirroring code points before any string that did
 * not originate from this CLI is written to the terminal. Free-form fields
 * (dispute reasons, memos, API-provided names) must pass through this before
 * being printed with trusted formatting.
 */

export function sanitizeTerminal(value: unknown): string {
  return String(value ?? "")
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|\x90)[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\u00a0/g, " ");
}

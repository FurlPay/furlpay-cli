/**
 * Human approval gate (readiness P23).
 *
 * Approval of a money-moving request is a HUMAN decision. This module makes
 * that enforceable instead of aspirational:
 *
 *   • Interactive TTY  → a typed challenge re-engages the human on the exact
 *     economics (the minor amount and the tail of the destination) — an
 *     accidental Enter cannot approve.
 *   • Non-interactive  → refused unless a SEPARATE approver credential is
 *     presented (--approver matching FURLPAY_FINANCE_APPROVER_TOKEN). The
 *     requester that created the payment does not hold that token, so a
 *     script cannot approve its own request.
 *
 * The CLI maps { ok: false } to exit code 46. MCP surfaces must never call
 * this with a bypass — there is no "force" parameter by design.
 */

export const HUMAN_APPROVAL_EXIT_CODE = 46;

export interface HumanGateRequest {
  /** Minor units EXACTLY as displayed on the request (string form). */
  minor: string;
  /** Destination address of the payment under approval. */
  destination: string;
}

export interface HumanGateIo {
  /** True only for a real interactive terminal (process.stdout.isTTY). */
  isTty: boolean;
  /** --approver value presented by the caller, if any. */
  approverToken?: string;
  /** Expected credential (e.g. FURLPAY_FINANCE_APPROVER_TOKEN), if set. */
  expectedToken?: string;
  /** Injected prompt channel for the typed challenge (tests stub this). */
  prompt?: (question: string) => Promise<string>;
}

export type HumanGateResult = { ok: true } | { ok: false; reason: string };

/** Constant-time credential comparison: hash both sides, compare digests. */
function tokenMatches(presented: string, expected: string): boolean {
  const crypto = require("crypto") as typeof import("crypto");
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export async function assertHumanApproval(req: HumanGateRequest, io: HumanGateIo): Promise<HumanGateResult> {
  if (!io.isTty) {
    if (!io.approverToken || !io.expectedToken || !tokenMatches(io.approverToken, io.expectedToken)) {
      return {
        ok: false,
        reason: "Refusing to approve from a non-interactive session without a valid approver credential. " +
          "Run in a TTY and type the confirmation, or pass --approver with FURLPAY_FINANCE_APPROVER_TOKEN set.",
      };
    }
    return { ok: true };
  }
  const destTail = req.destination.slice(-6);
  if (!io.prompt) {
    return { ok: false, reason: "no prompt channel available for the typed confirmation challenge" };
  }
  const answer = await io.prompt(`Type ${req.minor} and the last 6 destination characters (${destTail}) to approve: `);
  if (!answer.includes(req.minor) || !answer.toLowerCase().includes(destTail.toLowerCase())) {
    return { ok: false, reason: "Confirmation did not match the request economics — not approved." };
  }
  return { ok: true };
}

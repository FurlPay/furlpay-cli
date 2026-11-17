/**
 * Human approval gate tests (readiness P23).
 *
 * Approval of a money-moving request must be a HUMAN decision:
 *   • non-interactive without an approver credential → refused
 *   • non-interactive with a WRONG credential → refused
 *   • non-interactive with the matching credential → allowed (separation of duties)
 *   • interactive TTY with a wrong typed challenge → refused
 *   • interactive TTY typing amount + destination tail → allowed
 * The CLI maps refusals to exit code 46; MCP never wires this path at all.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { assertHumanApproval, HUMAN_APPROVAL_EXIT_CODE } = require("../dist/finance/humanGate");

const REQ = { minor: "75000000", destination: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

describe("Human approval gate (P23)", () => {
  it("exit code 46 is the documented refusal code", () => {
    assert.strictEqual(HUMAN_APPROVAL_EXIT_CODE, 46);
  });

  it("non-interactive without any credential → refused", async () => {
    const r = await assertHumanApproval(REQ, { isTty: false });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /non-interactive/);
  });

  it("non-interactive with a wrong token → refused", async () => {
    const r = await assertHumanApproval(REQ, {
      isTty: false,
      approverToken: "wrong-token",
      expectedToken: "correct-token",
    });
    assert.strictEqual(r.ok, false);
  });

  it("non-interactive with the matching token → allowed (separate approver credential)", async () => {
    const r = await assertHumanApproval(REQ, {
      isTty: false,
      approverToken: "correct-token",
      expectedToken: "correct-token",
    });
    assert.deepStrictEqual(r, { ok: true });
  });

  it("a token presented with NO expected token configured → refused (credential unset is not a bypass)", async () => {
    const r = await assertHumanApproval(REQ, { isTty: false, approverToken: "anything" });
    assert.strictEqual(r.ok, false);
  });

  it("interactive TTY with a wrong typed challenge → refused", async () => {
    const r = await assertHumanApproval(REQ, {
      isTty: true,
      prompt: async () => "yes", // the lazy human
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /did not match/);
  });

  it("interactive TTY typing the amount and destination tail → allowed", async () => {
    const r = await assertHumanApproval(REQ, {
      isTty: true,
      prompt: async () => "75000000 bbbbbb",
    });
    assert.deepStrictEqual(r, { ok: true });
  });

  it("interactive TTY typing the amount but a wrong destination tail → refused", async () => {
    const r = await assertHumanApproval(REQ, {
      isTty: true,
      prompt: async () => "75000000 aaaaaa",
    });
    assert.strictEqual(r.ok, false);
  });

  it("interactive TTY with no prompt channel → refused, never silently passes", async () => {
    const r = await assertHumanApproval(REQ, { isTty: true });
    assert.strictEqual(r.ok, false);
  });
});

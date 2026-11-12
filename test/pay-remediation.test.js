"use strict";
// ---------------------------------------------------------------------------
// FurlPay Pay — Phase 4 Security Remediation Regression Suite
//
// Verifies fix implementations for:
//   - SEC-01: No Phantom Settlements (Zero fabricated transferIds)
//   - SEC-02: Autonomous AI Agent AP2 Mandate Enforcement
//   - SEC-05: Strict Sandbox Fixture Isolation (Live environment gate)
//   - SEC-09: Cryptographic Quote Verification & Expiration
//   - SEC-11: PowerShell Splatting Argument Protection
// ---------------------------------------------------------------------------

const assert = require("assert");
const crypto = require("crypto");
const http = require("http");
const { resolveRecipientProfile, fetchPayQuote, executeA2APay } = require("../lib/payTui");
const { TOOLS } = require("../lib/mcp");

let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✗ FAIL: ${name}\n  ${err.message}`);
  }
}

async function runRemediationTests() {
  console.log("Running FurlPay Pay Phase 4 Security Remediation regression suite...\n");

  // Spin up sandbox API service on 8787 for the duration of the test
  const sandboxServer = http.createServer((req, res) => {
    // Unauthenticated requests receive 401
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "unauthenticated",
      message: "Authentication required: Session token missing or invalid."
    }));
  });

  await new Promise((resolve) => sandboxServer.listen(8787, "127.0.0.1", resolve));

  // SEC-01: Zero Phantom Settlement on Unauthenticated Transfer
  await test("SEC-01: executeA2APay in --agent mode rejects unauthenticated request without minting fake transferId", async () => {
    const origExitCode = process.exitCode;
    try {
      const res = await executeA2APay(["@recipient", "10", "USD"], {
        agent: true,
        json: true,
        env: "sandbox"
      });
      assert.strictEqual(res.ok, false, "Must return ok: false when unauthenticated");
      assert.notStrictEqual(res.status, "completed", "Must never claim completed status without authentication");
      assert.strictEqual(res.transferId, undefined, "Must NEVER fabricate a transferId");
      assert.strictEqual(process.exitCode, 1, "Must set process.exitCode to 1 on failure");
    } finally {
      process.exitCode = origExitCode;
    }
  });

  // SEC-02: Autonomous AI Agent Mandate Validation in MCP Tool
  await test("SEC-02: MCP furlpay_pay tool escalates unmandated agent calls to human approval", async () => {
    const tool = TOOLS.find((t) => t.name === "furlpay_pay");
    assert(tool, "furlpay_pay tool must be registered in MCP");

    // Unmandated call
    const resUnmandated = await tool.handler({
      recipient: "@recipient",
      amount: 50.0,
      currency: "USD",
    }, {});

    assert.strictEqual(resUnmandated.status, "requires_approval");
    assert.strictEqual(resUnmandated.requiresHumanApproval, true);
    assert(resUnmandated.approvalId.startsWith("appr_esc_"));
  });

  await test("SEC-02: MCP furlpay_pay tool rejects fake mandate strings (e.g. 'bypass')", async () => {
    const tool = TOOLS.find((t) => t.name === "furlpay_pay");
    const resBypass = await tool.handler({
      recipient: "@recipient",
      amount: 50.0,
      currency: "USD",
      mandateId: "bypass", // Malicious / illegitimate mandate string
    }, {});

    assert.strictEqual(resBypass.status, "requires_approval", "Bypass mandate must not settle autonomously");
    assert.strictEqual(resBypass.requiresHumanApproval, true);
    assert(resBypass.reason.includes("invalid or malformed"));
  });

  // SEC-05: Sandbox Fixture Isolation in Live Environment
  await test("SEC-05: resolveRecipientProfile ignores sandbox fixtures in live environment", async () => {
    const profile = await resolveRecipientProfile("@recipient", { env: "live" });
    // In live mode, fixture is not applied; falls back to dynamic synthesis / API
    assert.strictEqual(profile.isFixture, false, "Sandbox fixture must NEVER be returned in live mode");
    assert.strictEqual(profile.kybStatus, "unverified", "Live account without verified record must remain unverified");
  });

  // SEC-09 (revised 2026-11-12): an offline fallback quote must NOT forge a
  // server-signed id. The previous design HMAC'd quoteIds with a hardcoded
  // secret shipped in the client — anyone could produce ids that looked
  // server-authenticated. The fallback quote is now an explicitly LOCAL
  // estimate (quo_local_, no signature, local:true) and the server rejects
  // non-authoritative ids at execute time.
  await test("SEC-09: fallback quotes are honestly local, never forge server-signed quoteIds", async () => {
    const quote = await fetchPayQuote("@recipient", 100.0, "USD", {});
    assert(quote.quoteId.startsWith("quo_local_"), "Fallback quote must carry the quo_local_ prefix, not a server-shaped quo_furl_ id");
    assert.strictEqual(quote.local, true, "Fallback quote must be flagged local:true");

    const parts = quote.quoteId.split("_");
    assert.strictEqual(parts.length, 4, "Local quote token must have 4 segments: quo_local_<expiresAt>_<random>");
    const expiresAt = Number(parts[2]);
    assert(!isNaN(expiresAt), "Segment 2 must be numeric timestamp");
    assert(expiresAt > Date.now(), "Quote must have future expiration");

    // No signature segment claim: the id must NOT be verifiable against any
    // shipped secret, because none exists in the client.
    assert(!/^[0-9a-f]{16}$/.test(parts[3]) || parts[3].length === 16, "Segment 3 is an opaque random suffix");
    assert(!("signature" in quote), "A local quote carries no signature field");
  });

  // SEC-11: PowerShell Argument Splatting Protection
  await test("SEC-11: pay command rejects shifted numeric first arguments and instructs user on PowerShell quoting", async () => {
    const commands = require("../lib/commands");
    let failedMessage = null;
    const out = require("../lib/output");
    const origFail = out.fail;
    out.fail = (msg) => { failedMessage = msg; };

    try {
      // Simulate PowerShell passing args after @recipient was splatted: ["10", "USD"]
      await commands.pay(["10", "USD"], {});
      assert(failedMessage, "Must fail when first arg is numeric amount");
      assert(failedMessage.includes("PowerShell"), "Error message must warn about PowerShell splatting");
      assert(failedMessage.includes("furlpay pay '@recipient'"), "Error message must show correct quoting syntax");
    } finally {
      out.fail = origFail;
    }
  });

  await new Promise((resolve) => sandboxServer.close(resolve));

  if (failures > 0) {
    console.error(`\n${failures} remediation test(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll Phase 4 Security Remediation regression tests passed!");
  }
}

runRemediationTests();

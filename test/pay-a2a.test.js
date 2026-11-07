"use strict";
// ---------------------------------------------------------------------------
// Unit tests for FurlPay A2A Pay CLI & TUI features
//
// Company-Agnostic Test Suite:
//   - Verifies dynamic handle resolution with neutral fixtures (@recipient, @business_demo)
//   - Verifies that unknown handles are marked 'unverified' (KYB badge never falsified)
//   - Verifies box geometry and layout invariants
// ---------------------------------------------------------------------------

const assert = require("assert");
const {
  resolveRecipientProfile,
  fetchPayQuote,
  sanitizeTerminalText,
  waitForKeypress,
  SANDBOX_FIXTURES,
  drawBox,
  drawTitledBox
} = require("../lib/payTui");

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

async function runTests() {
  console.log("Running FurlPay Pay A2A company-agnostic test suite...\n");

  await test("Directory resolution for neutral @recipient fixture", async () => {
    const recipient = await resolveRecipientProfile("@recipient", {});
    assert.strictEqual(recipient.name, "Business Account");
    assert.strictEqual(recipient.handle, "@recipient");
    assert.strictEqual(recipient.kybStatus, "verified");
    assert.strictEqual(recipient.sanctionsStatus, "clear");
    assert.strictEqual(recipient.isFixture, true);
  });

  await test("Directory resolution for neutral @business_demo fixture", async () => {
    const demo = await resolveRecipientProfile("@business_demo", {});
    assert.strictEqual(demo.name, "Business Operating Account");
    assert.strictEqual(demo.handle, "@business_demo");
    assert.strictEqual(demo.kybStatus, "verified");
    assert.strictEqual(demo.isFixture, true);
  });

  await test("Unknown handle is strictly marked 'unverified' (no falsified KYB badge)", async () => {
    const unknown = await resolveRecipientProfile("@new_counterparty", {});
    assert.strictEqual(unknown.name, "New_counterparty");
    assert.strictEqual(unknown.handle, "@new_counterparty");
    assert.strictEqual(unknown.kybStatus, "unverified", "unregistered handles must be unverified");
  });

  await test("fetchPayQuote produces valid quote with zero transaction fees", async () => {
    const quote = await fetchPayQuote("@recipient", 10.0, "USD", {});
    assert(quote.quoteId.startsWith("quo_furl_"), "quoteId must have correct prefix");
    assert.strictEqual(quote.amount.decimal, 10.0);
    assert.strictEqual(quote.amount.fee, 0.0, "Internal A2A transfers must be free ($0.00)");
    assert.strictEqual(quote.settlement.rail, "FurlPay Ledger");
  });

  await test("sanitizeTerminalText strips ANSI escapes, OSC commands, BiDi overrides, and invisible chars", () => {
    // 1. ANSI color codes
    const ansiInput = "\x1b[31;1mMalicious\x1b[0m Recipient";
    assert.strictEqual(sanitizeTerminalText(ansiInput), "Malicious Recipient");

    // 2. OSC 52 clipboard injection
    const oscInput = "Company\x1b]52;c;evilpayload\x07 Corp";
    assert.strictEqual(sanitizeTerminalText(oscInput), "Company Corp");

    // 3. BiDi Trojan characters (Right-to-Left Override \u202E)
    const bidiInput = "Legit \u202Edradnats\u202C Entity";
    assert.strictEqual(sanitizeTerminalText(bidiInput), "Legit dradnats Entity");

    // 4. Control characters (BELL, NUL, ESC)
    const ctrlInput = "Acme\x00\x07\x1bCorp";
    assert.strictEqual(sanitizeTerminalText(ctrlInput), "AcmeCorp");
  });

  await test("waitForKeypress rejects non-TTY confirmation without explicit --yes / --agent", async () => {
    // In automated testing where stdin is not an interactive TTY, running without flags must refuse
    const origTTY = process.stdin.isTTY;
    const origError = console.error;
    let loggedWarning = "";
    console.error = (msg) => { loggedWarning += msg; };

    process.stdin.isTTY = false;
    try {
      const confirmed = await waitForKeypress({});
      assert.strictEqual(confirmed, false, "Must refuse confirmation when stdin is not a TTY without --yes/--agent");
      assert(loggedWarning.includes("Interactive payment confirmation requires a TTY terminal"), "Expected non-TTY warning was properly logged");

      const confirmedWithYes = await waitForKeypress({ yes: true });
      assert.strictEqual(confirmedWithYes, true, "Must accept confirmation when --yes flag is passed");
    } finally {
      process.stdin.isTTY = origTTY;
      console.error = origError;
    }
  });

  await test("drawBox produces exact width and rounded borders", () => {
    const lines = ["Hello FurlPay"];
    const width = 40;
    const box = drawBox(lines, width, (s) => s);
    const boxLines = box.split("\n");
    assert.strictEqual(boxLines.length, 3, "box should have top, content, and bottom");
    assert(boxLines[0].startsWith("╭") && boxLines[0].endsWith("╮"), "top border rounded");
    assert(boxLines[2].startsWith("╰") && boxLines[2].endsWith("╯"), "bottom border rounded");
  });

  await test("drawTitledBox incorporates title into top border", () => {
    const lines = ["Amount: 10.00 USD"];
    const width = 50;
    const box = drawTitledBox("Live mode transfer", lines, width, (s) => s);
    const boxLines = box.split("\n");
    assert(boxLines[0].includes("Live mode transfer"), "title must be rendered in header");
    assert(boxLines[0].startsWith("╭"), "header starts with top-left rounded corner");
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll FurlPay Pay A2A tests passed!");
  }
}

runTests();

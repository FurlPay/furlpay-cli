/**
 * Financial Operations Layer Test Suite (2026-11-17)
 *
 * Backtests the audit-critical properties of the finance modules:
 * - Money: integer-minor parsing/formatting/conversion, no floats.
 * - Ledger: double-entry balance enforcement, idempotency, legal state
 *   machine (submission ≠ settlement), hash-chain tamper detection, durable
 *   reload across instances, settled/pending balance split.
 * - Spend: fail-closed limit windows, pending consumption counts.
 * - Approvals: parameter binding, expiry, single-use, replay refusal.
 * - Payments: full lifecycle with evidence, approval-gated creation,
 *   idempotent create, fabricated-hash refusal.
 * - Events: HMAC sign/verify, payload tamper refusal, replay protection,
 *   journal persistence.
 * - Treasury/Billing: derived views, fee/volume separation, CSV determinism.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("node:child_process");

const { FinancialLedger } = require("../dist/finance/ledger");
const { SpendManager } = require("../dist/finance/spend");
const { ApprovalEngine, paramsHashOf } = require("../dist/finance/approvals");
const { PaymentOrchestrator } = require("../dist/finance/payments");
const { FinanceManager } = require("../dist/finance/manager");
const { FinancialEventBus } = require("../dist/finance/events");
const money = require("../dist/finance/money");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-finance-test-"));
}

const USDC = (ui) => money.token("USDC", "base", ui);
const DEST = "0x" + "b".repeat(40); // valid EVM destination for orchestrator tests

describe("Money abstraction", () => {
  it("parses and formats minor units exactly (no floats)", () => {
    assert.strictEqual(money.parseMinor("25.000001", 6), 25_000_001n);
    assert.strictEqual(money.formatMinor(25_000_001n, 6), "25.000001");
    assert.strictEqual(money.parseMinor("0.000001", 6), 1n);
    assert.strictEqual(money.formatMinor(1n, 6), "0.000001");
  });

  it("rejects excess decimals, negatives, garbage", () => {
    assert.throws(() => money.parseMinor("1.1234567", 6), /more decimals/);
    assert.throws(() => money.parseMinor("-5", 6), /not a valid/);
    assert.throws(() => money.parseMinor("1e3", 6), /not a valid/);
    assert.throws(() => money.parseMinor("NaN", 6), /not a valid/);
  });

  it("ISO 4217 validation and JPY zero-decimals", () => {
    assert.strictEqual(money.currencyDecimals("JPY"), 0);
    assert.throws(() => money.fiat("XXY", "1"), /not an ISO 4217/);
    assert.strictEqual(money.fiat("usd", "10.50").minor, 1050n);
  });

  it("conversion is explicit, exact, and provenance-carrying", () => {
    const usdc = USDC("1000");
    const rate = { from: "USDC", to: "USD", rate: "0.9998", timestampMs: Date.now(), source: "test" };
    const out = money.convert(usdc, rate, 2);
    // 1000 * 0.9998 = 999.80 exactly — truncation-free
    assert.strictEqual(out.minor, 99_980n);
    assert.strictEqual(out.applied.source, "test");
    assert.throws(() => money.convert(usdc, { ...rate, rate: "0.0000" }, 2), /zero/);
  });
});

describe("Double-entry ledger", () => {
  let dir, ledger;

  beforeEach(() => {
    dir = tmpDir();
    ledger = new FinancialLedger(path.join(dir, "ledger.json"));
    ledger.ensureAccount({ id: "wallet:USDC:base", kind: "asset", unit: "USDC", network: "base", name: "op" });
    ledger.ensureAccount({ id: "expense:pay", kind: "expense", unit: "USDC", network: "base", name: "out" });
  });

  it("posts a balanced transaction and refuses an unbalanced one", () => {
    const ok = ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 5_000_000n },
      { accountId: "expense:pay", direction: "debit", minor: 5_000_000n },
    ] });
    assert.strictEqual(ok.state, "CREATED");
    assert.throws(() => ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 5_000_000n },
      { accountId: "expense:pay", direction: "debit", minor: 4_000_000n },
    ] }), /does not balance/);
  });

  it("refuses entries against unknown accounts and unit mixing", () => {
    assert.throws(() => ledger.commit({ type: "payment_out", entries: [
      { accountId: "ghost", direction: "credit", minor: 1n },
      { accountId: "expense:pay", direction: "debit", minor: 1n },
    ] }), /Unknown account/);
    ledger.ensureAccount({ id: "wallet:USD", kind: "asset", unit: "USD", name: "fiat" });
    assert.throws(() => ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 1n },
      { accountId: "wallet:USD", direction: "debit", minor: 1n },
    ] }), /mix units/);
  });

  it("idempotency: same key returns the same transaction, never re-posts", () => {
    const a = ledger.commit({ type: "payment_out", idempotencyKey: "k1", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 1_000_000n },
      { accountId: "expense:pay", direction: "debit", minor: 1_000_000n },
    ] });
    const b = ledger.commit({ type: "payment_out", idempotencyKey: "k1", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 1_000_000n },
      { accountId: "expense:pay", direction: "debit", minor: 1_000_000n },
    ] });
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(ledger.listTransactions().length, 1);
  });

  it("state machine: submission is not settlement — illegal jumps refused", () => {
    const tx = ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 1n },
      { accountId: "expense:pay", direction: "debit", minor: 1n },
    ] });
    // CREATED → SETTLED directly is illegal
    assert.throws(() => ledger.transition(tx.id, "SETTLED"), /Illegal ledger transition/);
    ledger.transition(tx.id, "SUBMITTED");
    assert.throws(() => ledger.transition(tx.id, "CANCELLED"), /Illegal/); // in-flight cannot cancel
    ledger.transition(tx.id, "CONFIRMED");
    // Evidence gate: CONFIRMED → SETTLED refuses without chain-verified evidence
    assert.throws(() => ledger.transition(tx.id, "SETTLED"), /SETTLE_REQUIRES_CHAIN_VERIFIED/);
    ledger.attachTxHash(tx.id, "0x" + "a".repeat(64), { level: "chain_verified" });
    ledger.transition(tx.id, "SETTLED");
    assert.strictEqual(ledger.getTransaction(tx.id).state, "SETTLED");
  });

  it("settled vs pending balance split", () => {
    const t1 = ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "debit", minor: 10_000_000n },
      { accountId: "expense:pay", direction: "credit", minor: 10_000_000n },
    ] });
    const t2 = ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "debit", minor: 4_000_000n },
      { accountId: "expense:pay", direction: "credit", minor: 4_000_000n },
    ] });
    ledger.transition(t1.id, "SUBMITTED");
    ledger.transition(t1.id, "CONFIRMED");
    ledger.attachTxHash(t1.id, "0x" + "b".repeat(64), { level: "chain_verified" });
    ledger.transition(t1.id, "SETTLED");
    const b = ledger.accountBalance("wallet:USDC:base");
    assert.strictEqual(b.settledMinor, 10_000_000n);
    assert.strictEqual(b.pendingMinor, 4_000_000n);
    assert.strictEqual(b.totalMinor, 14_000_000n);
  });

  it("durability + tamper detection across instances", () => {
    ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 2n },
      { accountId: "expense:pay", direction: "debit", minor: 2n },
    ] });
    const reloaded = new FinancialLedger(path.join(dir, "ledger.json"));
    assert.strictEqual(reloaded.listTransactions().length, 1);

    // Tamper with the persisted record → chain verification refuses to load
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));
    raw.transactions[0].entries[0].minor = "999999";
    fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify(raw));
    assert.throws(() => new FinancialLedger(path.join(dir, "ledger.json")), /hash chain INVALID/);
  });

  it("fabricated tx hashes are refused", () => {
    const tx = ledger.commit({ type: "payment_out", entries: [
      { accountId: "wallet:USDC:base", direction: "credit", minor: 1n },
      { accountId: "expense:pay", direction: "debit", minor: 1n },
    ] });
    assert.throws(() => ledger.attachTxHash(tx.id, "totally-made-up"), /TX_HASH_INVALID/);
    ledger.attachTxHash(tx.id, "0x" + "a".repeat(64));
    assert.strictEqual(ledger.getTransaction(tx.id).txHash, "0x" + "a".repeat(64));
  });
});

describe("Spend controls", () => {
  let dir, ledger, spend;

  beforeEach(() => {
    dir = tmpDir();
    ledger = new FinancialLedger(path.join(dir, "ledger.json"));
    ledger.ensureAccount({ id: "w", kind: "asset", unit: "USDC", network: "base", name: "w" });
    ledger.ensureAccount({ id: "e", kind: "expense", unit: "USDC", network: "base", name: "e" });
    spend = new SpendManager(ledger, path.join(dir, "limits.json"));
  });

  it("daily limit refuses the breaching claim and passes the safe one", () => {
    spend.setLimits({ dailyMinor: 10_000_000n }); // 10 USDC
    // A settled payment today consuming 8 USDC — settled the honest way:
    // committed, evidenced, then walked through the state machine.
    const t = ledger.commit({ type: "payment_out", entries: [
      { accountId: "w", direction: "credit", minor: 8_000_000n, note: "GDEST" },
      { accountId: "e", direction: "debit", minor: 8_000_000n },
    ] });
    ledger.attachTxHash(t.id, "0x" + "c".repeat(64), { level: "chain_verified" });
    ledger.transition(t.id, "SUBMITTED");
    ledger.transition(t.id, "CONFIRMED");
    ledger.transition(t.id, "SETTLED");
    const refused = spend.check({ minor: 3_000_000n, unit: "USDC", network: "base" });
    assert.strictEqual(refused.allowed, false);
    assert.match(refused.reason, /Daily spend limit/);
    const ok = spend.check({ minor: 2_000_000n, unit: "USDC", network: "base" });
    assert.strictEqual(ok.allowed, true);
  });

  it("pending (non-settled) consumption counts — money in flight is spent", () => {
    spend.setLimits({ dailyMinor: 10_000_000n });
    ledger.commit({ type: "payment_out", state: "PENDING", entries: [
      { accountId: "w", direction: "credit", minor: 9_000_000n },
      { accountId: "e", direction: "debit", minor: 9_000_000n },
    ] });
    const d = spend.check({ minor: 2_000_000n, unit: "USDC", network: "base" });
    assert.strictEqual(d.allowed, false);
  });

  it("per-transaction ceiling enforced", () => {
    spend.setLimits({ perTransactionMinor: 1_000_000n });
    const d = spend.check({ minor: 2_000_000n, unit: "USDC", network: "base" });
    assert.strictEqual(d.allowed, false);
    assert.match(d.reason, /Single-transaction limit/);
  });

  it("usage() reports without claiming", () => {
    const u = spend.usage("USDC");
    assert.strictEqual(typeof u.total, "bigint");
    assert.strictEqual(u.limits.dailyMinor, undefined);
  });
});

describe("Approval engine", () => {
  let dir, engine;

  beforeEach(() => {
    dir = tmpDir();
    engine = new ApprovalEngine(path.join(dir, "approvals.json"));
  });

  const params = { minor: 75_000_000n, unit: "USDC", network: "base", destination: DEST, type: "payment_out", feeMinor: 100_000n };

  it("binds approval to exact parameters — changed params are refused", () => {
    const req = engine.create(params, { level: "medium", notes: "" });
    const approved = engine.approve(req.id, params);
    assert.strictEqual(approved.state, "APPROVED");
    // A second request with a different amount
    const req2 = engine.create({ ...params, minor: 80_000_000n }, { level: "medium", notes: "" });
    assert.throws(
      () => engine.approve(req2.id, { ...params, minor: 99_000_000n }),
      /Parameter binding mismatch/
    );
  });

  it("expiry: an expired request can never be approved", () => {
    let now = Date.now();
    const clock = () => now;
    const eng = new ApprovalEngine(path.join(dir, "approvals2.json"), clock);
    const req = eng.create(params, { level: "low", notes: "" }, 1_000);
    now += 2_000;
    assert.throws(() => eng.approve(req.id, params), /expired/);
  });

  it("single-use: consumed approvals refuse re-approval and re-execution", () => {
    const req = engine.create(params, { level: "low", notes: "" });
    engine.approve(req.id, params);
    const res = engine.reserveForExecution(req.id, params);
    engine.finalizeExecution(req.id, res.ownerToken, "ltx_1");
    assert.throws(() => engine.approve(req.id, params), /not AWAITING_APPROVAL/);
    assert.throws(() => engine.reserveForExecution(req.id, params), /APPROVAL_NOT_EXECUTABLE/);
  });

  it("execution re-verifies parameters — post-approval substitution refused, nothing consumed", () => {
    const req = engine.create(params, { level: "low", notes: "" });
    engine.approve(req.id, params);
    assert.throws(
      () => engine.reserveForExecution(req.id, { ...params, destination: "0xsubstituted-destination" }),
      /EXECUTION_BINDING_MISMATCH/
    );
    assert.strictEqual(engine.get(req.id).state, "APPROVED", "failed reserve leaves the approval untouched");
  });

  it("reservation is exclusive — one approval funds exactly one execution", () => {
    const req = engine.create(params, { level: "low", notes: "" });
    engine.approve(req.id, params);
    const res = engine.reserveForExecution(req.id, params);
    assert.throws(() => engine.reserveForExecution(req.id, params), /APPROVAL_ALREADY_RESERVED/);
    engine.releaseReservation(req.id, res.ownerToken, "posting failed in test");
    assert.strictEqual(engine.get(req.id).state, "APPROVED", "released reservation returns to APPROVED");
  });

  it("REGRESSION (P23): a reservation loser cannot release the winner's reservation", () => {
    const req = engine.create(params, { level: "low", notes: "" });
    engine.approve(req.id, params);
    // Winner reserves…
    const winner = engine.reserveForExecution(req.id, params);
    // …a loser (no token, e.g. a concurrent process whose reserve threw)
    // attempts to release or finalize with a forged/absent token.
    assert.throws(() => engine.releaseReservation(req.id, "00000000-0000-4000-8000-000000000000", "loser"), /RESERVATION_OWNER_MISMATCH/);
    assert.throws(() => engine.finalizeExecution(req.id, "forged-token", "ltx_fake"), /RESERVATION_OWNER_MISMATCH/);
    assert.strictEqual(engine.get(req.id).state, "RESERVED", "loser attempts left the winner's reservation intact");
    // The real owner still finalizes cleanly.
    engine.finalizeExecution(req.id, winner.ownerToken, "ltx_real");
    assert.strictEqual(engine.get(req.id).state, "EXECUTED");
  });

  it("REGRESSION (P23): absent fee and zero fee hash identically — the fee bind cannot be dodged by omission", () => {
    const noFee = paramsHashOf({ minor: 100n, unit: "USDC", network: "base", destination: "0xab", type: "payment_out" });
    const zeroFee = paramsHashOf({ minor: 100n, unit: "USDC", network: "base", destination: "0xab", type: "payment_out", feeMinor: 0n });
    const realFee = paramsHashOf({ minor: 100n, unit: "USDC", network: "base", destination: "0xab", type: "payment_out", feeMinor: 1n });
    assert.strictEqual(noFee, zeroFee);
    assert.notStrictEqual(noFee, realFee);
  });

  it("hash canonicalization is stable regardless of key insertion order", () => {
    const a = paramsHashOf({ minor: 1n, unit: "usdc", network: "Base", destination: " X ", type: "t" });
    const b = paramsHashOf({ type: "t", destination: "X", network: "base", unit: "USDC", minor: 1n });
    assert.strictEqual(a, b);
  });
});

describe("Payment orchestrator (end-to-end lifecycle)", () => {
  let dir, fin;

  beforeEach(() => {
    dir = tmpDir();
    fin = new FinanceManager({ dir });
  });

  it("full lifecycle: created → (approval) → evidence → confirmed; SETTLED needs chain-verified evidence", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const DEST = "0x" + "a".repeat(40); // valid EVM destination (readiness P23)
    // Above the $50 default threshold → returns an approval request, no ledger posting
    const req = fin.payments.createOutPayment({
      amount: USDC("75"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: money.parseMinor("0.01", 6),
    });
    assert.ok(req.paramsHash, "approval request returned, not a payment");
    assert.strictEqual(fin.ledger.listTransactions().length, 0, "no money moved without a human");

    // Human approves the exact parameters
    const params = { minor: 75_000_000n, unit: "USDC", network: "base", destination: DEST, source: ids.sourceId, type: "payment_out", feeMinor: 10_000n };
    fin.approvals.approve(req.id, params);

    // Re-create with the approval → posts atomically (payment + fee)
    const p = fin.payments.createOutPayment({
      amount: USDC("75"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: 10_000n,
      approvalId: req.id,
    });
    assert.ok(p.id.startsWith("ltx_"));
    assert.strictEqual(p.state, "CREATED");
    assert.strictEqual(fin.approvals.get(req.id).state, "EXECUTED", "reservation finalized with the ledger ref");

    // Evidence-attached progress. Operator-asserted hash caps at CONFIRMED —
    // settlement requires chain-verified evidence (readiness P23).
    fin.payments.markSubmitted(p.id, "0x" + "f".repeat(64));
    const confirmed = fin.payments.markConfirmed(p.id);
    assert.strictEqual(confirmed.state, "CONFIRMED");
    assert.strictEqual(confirmed.evidenceLevel, "operator_asserted");
    assert.throws(() => fin.payments.markSettled(p.id), /SETTLE_REQUIRES_CHAIN_VERIFIED/);

    // Chain-verified evidence unlocks settlement.
    const verified = fin.payments.attachChainVerifiedEvidence(p.id, "0x" + "f".repeat(64), {
      provider: "test-rpc",
      receipt: { status: 1 },
    });
    assert.strictEqual(verified.evidenceLevel, "chain_verified");
    const settled = fin.payments.markSettled(p.id);
    assert.strictEqual(settled.state, "SETTLED");
  });

  it("REGRESSION (P23): a binding mismatch refuses and leaves the ledger byte-identical", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const DEST = "0x" + "b".repeat(40);
    // Exact observed sequence: approval created fee-less, presented with a fee.
    const req = fin.payments.createOutPayment({
      amount: USDC("75"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
    });
    fin.approvals.approve(req.id, {
      minor: 75_000_000n, unit: "USDC", network: "base", destination: DEST, source: ids.sourceId, type: "payment_out",
    });
    const before = fs.readFileSync(fin.ledger.filePathUsed, "utf8");
    assert.throws(
      () => fin.payments.createOutPayment({
        amount: USDC("75"),
        destination: DEST,
        sourceAccountId: ids.sourceId,
        destinationAccountId: ids.sourceId,
        counterAccountId: ids.counterId,
        feeAccountId: ids.feesId,
        feeMinor: 10_000n, // ← the parameter that moved
        approvalId: req.id,
      }),
      /EXECUTION_BINDING_MISMATCH/
    );
    const after = fs.readFileSync(fin.ledger.filePathUsed, "utf8");
    assert.strictEqual(after, before, "a refused execution must leave the ledger byte-identical");
    assert.strictEqual(fin.ledger.listTransactions().length, 0);
    assert.strictEqual(fin.approvals.get(req.id).state, "APPROVED", "approval not stranded or burned by the refusal");
  });

  it("REGRESSION (P23): GDEST-style junk destinations are refused before an approval exists", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    assert.throws(
      () => fin.payments.createOutPayment({
        amount: USDC("10"),
        destination: "GDEST123",
        sourceAccountId: ids.sourceId,
        destinationAccountId: ids.sourceId,
        counterAccountId: ids.counterId,
      }),
      /DESTINATION_INVALID/
    );
    assert.strictEqual(fin.ledger.listTransactions().length, 0);
  });

  it("REGRESSION (P23): idempotency-key with DIFFERENT parameters is a conflict, not a success", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const DEST = "0x" + "c".repeat(40);
    const mk = (feeMinor) => fin.payments.createOutPayment({
      amount: USDC("10"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeMinor,
      idempotencyKey: "key-1",
    });
    mk(0n);
    assert.throws(() => mk(10_000n), /IDEMPOTENCY_CONFLICT/);
  });

  it("REGRESSION (P23): amount + fee together cross the approval threshold; fee consumes spend budget", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const DEST = "0x" + "d".repeat(40);
    // 49.999 USDC + 0.01 fee = 50.009 > 50 threshold → approval required
    const req = fin.payments.createOutPayment({
      amount: USDC("49.999"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: 10_000n,
    });
    assert.ok(req.paramsHash, "amount+fee crossing the threshold triggers approval");
    assert.strictEqual(fin.ledger.listTransactions().length, 0);

    // Spend cap counts amount+fee: daily cap exactly 10 USDC refuses 9.999 + 0.01 fee.
    fin.spend.setLimits({ dailyMinor: 10_000_000n });
    assert.throws(
      () => fin.payments.createOutPayment({
        amount: USDC("9.999"),
        destination: DEST,
        sourceAccountId: ids.sourceId,
        destinationAccountId: ids.sourceId,
        counterAccountId: ids.counterId,
        feeMinor: 10_000n,
      }),
      /SPEND_REFUSED/
    );
  });

  it("REGRESSION (P23): unknown units fail closed — always require approval", () => {
    const ids = fin.ensureStandardAccounts("SHIB", "base"); // unit with no configured threshold
    const req = fin.payments.createOutPayment({
      amount: money.token("SHIB", "base", "1", 18),
      destination: "0x" + "e".repeat(40),
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    assert.ok(req.paramsHash, "unknown unit → approval required regardless of amount");
  });

  it("REGRESSION (P23): fiat thresholds use 2-decimal minor units — a large 2-dp fiat payment triggers approval", () => {
    // Fiat accounts carry no network — a hosted-style EUR payment over the
    // per-unit threshold must still be gated.
    const ids = fin.ensureStandardAccounts("EUR");
    assert.strictEqual(ids.sourceId, "wallet:EUR");
    const req = fin.payments.createOutPayment({
      amount: money.fiat("EUR", "500"), // 50_000 minor > 5_000 threshold
      destination: "vendor@example.eu",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    assert.ok(req.paramsHash, "EUR 500 triggers approval via the 2-dp threshold table");
    // …while a small fiat payment below the threshold executes directly.
    const small = fin.payments.createOutPayment({
      amount: money.fiat("EUR", "20"),
      destination: "vendor@example.eu",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    assert.ok(small.ledgerTxId, "EUR 20 posts without approval");
  });

  it("REGRESSION (P23): a dead idempotency key (cancelled/failed original) is surfaced, never re-served as success", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("10"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      idempotencyKey: "dead-key",
    });
    fin.ledger.transition(p.id, "CANCELLED", "operator cancelled before submission");
    assert.throws(
      () => fin.payments.createOutPayment({
        amount: USDC("10"),
        destination: DEST,
        sourceAccountId: ids.sourceId,
        destinationAccountId: ids.sourceId,
        counterAccountId: ids.counterId,
        idempotencyKey: "dead-key",
      }),
      /IDEMPOTENCY_KEY_DEAD/
    );
  });

  it("REGRESSION (P23): cancelling a CREATED payment releases its spend consumption", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    fin.spend.setLimits({ dailyMinor: 10_000_000n });
    const p = fin.payments.createOutPayment({
      amount: USDC("9"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    // CREATED money-in-flight is consumed: only 1 USDC headroom remains.
    assert.strictEqual(fin.spend.check({ minor: 2_000_000n, unit: "USDC", network: "base" }).allowed, false);
    fin.ledger.transition(p.id, "CANCELLED", "test cancel");
    // CANCELLED releases: the same claim passes again.
    assert.strictEqual(fin.spend.check({ minor: 2_000_000n, unit: "USDC", network: "base" }).allowed, true);
  });

  it("REGRESSION (P23): operator-asserted evidence never reaches settled volume in billing", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    // Payment A: full honest lifecycle to chain-verified SETTLED.
    const a = fin.payments.createOutPayment({
      amount: USDC("5"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    fin.payments.markSubmitted(a.id, "0x" + "7".repeat(64));
    fin.payments.markConfirmed(a.id);
    fin.payments.attachChainVerifiedEvidence(a.id, "0x" + "7".repeat(64), { provider: "test-rpc", receipt: { status: 1 } });
    fin.payments.markSettled(a.id);
    // Payment B: operator-asserted evidence — stuck at CONFIRMED, unverifiable.
    const b = fin.payments.createOutPayment({
      amount: USDC("3"),
      destination: "0x" + "f".repeat(40),
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    fin.payments.markSubmitted(b.id, "0x" + "8".repeat(64));
    fin.payments.markConfirmed(b.id);
    const s = fin.billing.summary();
    assert.strictEqual(s.settledCount, 1, "only the chain-verified payment counts as settled");
    assert.strictEqual(s.volumeOutMinorByUnit.USDC, 8_000_000n, "volume covers both outflows (honest report of movement)");
    // …and the billing CSV carries the state so an accountant can see B is unverified.
    assert.ok(fin.billing.exportCsv().includes("CONFIRMED"));
  });

  it("REGRESSION (P23): fake or short hashes on an EVM network are rejected at attach time", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("1"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    assert.throws(() => fin.payments.markSubmitted(p.id, "0xdeadbeef123456"), /TX_HASH_INVALID/);
    assert.throws(() => fin.payments.markSubmitted(p.id, "deadbeef"), /TX_HASH_INVALID/);
    assert.strictEqual(fin.ledger.getTransaction(p.id).txHash, undefined, "refused hash was never stored");
  });

  it("REGRESSION (P23): one approval with N parallel PROCESSES → exactly one execution", { timeout: 60_000 }, async () => {
    const raceDir = tmpDir();
    const parent = new FinanceManager({ dir: raceDir });
    parent.ensureStandardAccounts("USDC", "base");
    const RACE_DEST = "0x" + "d".repeat(40);
    // Create the request from the SAME parameters the workers will present.
    const req = parent.payments.createOutPayment({
      amount: USDC("75"),
      destination: RACE_DEST,
      sourceAccountId: "wallet:USDC:base",
      destinationAccountId: "wallet:USDC:base",
      counterAccountId: "expense:payments:USDC:base",
      feeAccountId: "expense:fees:USDC:base",
    });
    parent.approvals.approve(req.id, {
      minor: 75_000_000n, unit: "USDC", network: "base", destination: RACE_DEST,
      source: "wallet:USDC:base", type: "payment_out",
    });

    const workerPath = path.join(__dirname, "fixtures", "race-worker.js");
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        new Promise((resolve) => {
          let out = "";
          const child = spawn(process.execPath, [workerPath, raceDir, req.id, String(i)], { stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", (d) => { out += d; });
          child.on("close", (code) => resolve({ code, out }));
        }),
      ),
    );

    const parsed = results.map((r) => {
      const line = r.out.trim().split("\n").pop() || "{}";
      return JSON.parse(line);
    });
    const executed = parsed.filter((p) => p.outcome === "EXECUTED");
    const refused = parsed.filter((p) => p.outcome === "REFUSED");
    assert.strictEqual(executed.length, 1, `exactly one worker executes (got ${executed.length}): ${JSON.stringify(parsed)}`);
    assert.strictEqual(refused.length, N - 1, "every other worker is refused");
    for (const r of refused) {
      assert.match(r.error, /APPROVAL_ALREADY_RESERVED|LOCK_TIMEOUT|APPROVAL_NOT_EXECUTABLE/, "refusal is the CAS, not a crash");
    }

    // Ground truth from a FRESH reader of the shared state:
    const after = new FinanceManager({ dir: raceDir });
    const payments = after.ledger.listTransactions().filter((t) => t.type === "payment_out");
    assert.strictEqual(payments.length, 1, "exactly one payment_out in the ledger");
    assert.strictEqual(after.approvals.get(req.id).state, "EXECUTED", "approval consumed exactly once");
  });

  it("below threshold: no approval needed; idempotent create returns the same payment", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const mk = () => fin.payments.createOutPayment({
      amount: USDC("10"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      idempotencyKey: "pay-once",
    });
    const a = mk();
    const b = mk();
    assert.strictEqual(a.id, b.id);
    assert.strictEqual(fin.ledger.listTransactions().filter((t) => t.type === "payment_out").length, 1);
  });

  it("spend limits gate the orchestrator — no bypass", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    fin.spend.setLimits({ perTransactionMinor: 1_000_000n });
    assert.throws(() => fin.payments.createOutPayment({
      amount: USDC("10"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    }), /SPEND_REFUSED/);
  });

  it("receipt renders the full audit trail", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("5"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    const r = fin.payments.receipt(p.id);
    assert.match(r, /FURLPAY PAYMENT RECEIPT/);
    assert.ok(r.includes(DEST), "receipt renders the full explicit destination, not a note-derived truncation");
    assert.match(r, /chain hash/);
  });

  it("treasury + billing derive from the ledger; fees separated from volume", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("5"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: 50_000n,
    });
    fin.payments.markSubmitted(p.id, "0x" + "9".repeat(64));
    fin.payments.markConfirmed(p.id);
    fin.payments.attachChainVerifiedEvidence(p.id, "0x" + "9".repeat(64), { provider: "test-rpc", receipt: { status: 1 } });
    fin.payments.markSettled(p.id);
    const s = fin.billing.summary();
    assert.strictEqual(s.volumeOutMinorByUnit.USDC, 5_000_000n);
    assert.strictEqual(s.feesMinorByUnit.USDC, 50_000n);
    assert.strictEqual(s.settledCount >= 1, true);

    const t = fin.treasury.status();
    const wallet = t.balances.find((b) => b.accountId === ids.sourceId);
    assert.strictEqual(wallet.totalMinor, -(5_000_000n + 50_000n), "source asset down by amount + fee");

    const csv = fin.billing.exportCsv();
    assert.match(csv, /^ledger_tx_id,seq,type,state,unit,network,minor,direction,tx_hash,created_at/);
    assert.ok(csv.split("\n").length > 3);
  });

  it("settlement capabilities are honest — no live adapter is claimed", () => {
    const caps = fin.payments.settlementCapabilities();
    assert.strictEqual(caps.find((c) => c.network === "stellar").mode, "simulated");
    assert.strictEqual(caps.find((c) => c.network === "base").mode, "none");
    assert.ok(caps.every((c) => c.mode !== "live"));
  });
});

describe("Financial event bus", () => {
  it("signs and verifies; tampered payloads and replays are refused", async () => {
    const dir = tmpDir();
    const bus = new FinancialEventBus({ journalPath: path.join(dir, "events.jsonl") });
    const ev = await bus.emit("payment.created", { id: "ltx_1", amount: "1000000" });
    assert.strictEqual(ev.seq, 1);
    assert.strictEqual(bus.verifyEnvelope(ev, { allowAnyTimestamp: true }), true);

    // Tamper
    const tampered = { ...ev, payload: { ...ev.payload, amount: "1" } };
    assert.strictEqual(bus.verifyEnvelope(tampered, { allowAnyTimestamp: true }), false);

    // Replay: same-or-lower seq refused on receive
    assert.throws(() => bus.receive(ev), /REPLAY_REFUSED/);

    // Fresh signed event with wrong signature refused
    const forged = { ...ev, seq: 2, signature: ev.signature };
    assert.throws(() => bus.receive(forged), /SIGNATURE_INVALID/);
  });

  it("journal persists and re-verifies across instances", async () => {
    const dir = tmpDir();
    const a = new FinancialEventBus({ journalPath: path.join(dir, "events.jsonl") });
    await a.emit("payment.settled", { id: "x" });
    await a.emit("treasury.balance_updated", { id: "y" });
    const b = new FinancialEventBus({ journalPath: path.join(dir, "events.jsonl") });
    assert.strictEqual(b.journalSize, 2);
    assert.strictEqual(b.recent(10)[0].seq, 2);
  });

  it("refuses non-https webhook configuration", () => {
    assert.throws(() => new FinancialEventBus({ webhookUrl: "http://example.com/hook" }), /https/);
  });
});

describe("FinanceManager facade", () => {
  it("manager wires every module against one directory", async () => {
    const dir = tmpDir();
    const fin = new FinanceManager({ dir });
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("3"),
      destination: DEST,
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    // Events emitted through the facade's bus (payment.created)
    await new Promise((r) => setTimeout(r, 50));
    const evs = fin.events.recent(5);
    assert.ok(evs.some((e) => e.type === "payment.created" && e.payload.paymentLedgerTxId === p.id));
    // Ledger reconcile is clean
    const r = fin.ledger.reconcile();
    assert.strictEqual(r.chainValid, true);
    assert.strictEqual(r.discrepancies.length, 0);
  });
});

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
    assert.throws(() => ledger.attachTxHash(tx.id, "totally-made-up"), /transaction hash/);
    ledger.attachTxHash(tx.id, "0xabc123def456");
    assert.strictEqual(ledger.getTransaction(tx.id).txHash, "0xabc123def456");
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
    // A settled payment today consuming 8 USDC
    const t = ledger.commit({ type: "payment_out", state: "SETTLED", entries: [
      { accountId: "w", direction: "credit", minor: 8_000_000n, note: "GDEST" },
      { accountId: "e", direction: "debit", minor: 8_000_000n },
    ] });
    void t;
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

  const params = { minor: 75_000_000n, unit: "USDC", network: "base", destination: "GDEST...", type: "payment_out", feeMinor: 100_000n };

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
    engine.consumeForExecution(req.id, params, "ltx_1");
    assert.throws(() => engine.approve(req.id, params), /not AWAITING_APPROVAL/);
    assert.throws(() => engine.consumeForExecution(req.id, params, "ltx_2"), /only APPROVED/);
  });

  it("execution re-verifies parameters — post-approval substitution refused", () => {
    const req = engine.create(params, { level: "low", notes: "" });
    engine.approve(req.id, params);
    assert.throws(
      () => engine.consumeForExecution(req.id, { ...params, destination: "GATTACKER..." }, "ltx"),
      /Execution binding mismatch/
    );
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

  it("full lifecycle: created → (approval) → evidence → confirmed → settled", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    // Above the $50 default threshold → returns an approval request, no ledger posting
    const req = fin.payments.createOutPayment({
      amount: USDC("75"),
      destination: "GDEST...",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: money.parseMinor("0.01", 6),
    });
    assert.ok(req.paramsHash, "approval request returned, not a payment");
    assert.strictEqual(fin.ledger.listTransactions().length, 0, "no money moved without a human");

    // Human approves the exact parameters
    const params = { minor: 75_000_000n, unit: "USDC", network: "base", destination: "GDEST...", source: ids.sourceId, type: "payment_out", feeMinor: 10_000n };
    fin.approvals.approve(req.id, params);

    // Re-create with the approval → posts
    const p = fin.payments.createOutPayment({
      amount: USDC("75"),
      destination: "GDEST...",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: 10_000n,
      approvalId: req.id,
    });
    assert.ok(p.id.startsWith("ltx_"));
    assert.strictEqual(p.state, "CREATED");

    // Evidence-attached progress; settle only after confirm
    fin.payments.markSubmitted(p.id, "0xfeedface1234");
    fin.payments.markConfirmed(p.id);
    const settled = fin.payments.markSettled(p.id);
    assert.strictEqual(settled.state, "SETTLED");
    assert.strictEqual(fin.payments.get(p.id).txHash, "0xfeedface1234");
  });

  it("below threshold: no approval needed; idempotent create returns the same payment", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const mk = () => fin.payments.createOutPayment({
      amount: USDC("10"),
      destination: "GDEST...",
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
      destination: "GDEST...",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    }), /SPEND_REFUSED/);
  });

  it("receipt renders the full audit trail", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("5"),
      destination: "GDEST...",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
    });
    const r = fin.payments.receipt(p.id);
    assert.match(r, /FURLPAY PAYMENT RECEIPT/);
    assert.match(r, /GDEST\.\.\./);
    assert.match(r, /chain hash/);
  });

  it("treasury + billing derive from the ledger; fees separated from volume", () => {
    const ids = fin.ensureStandardAccounts("USDC", "base");
    const p = fin.payments.createOutPayment({
      amount: USDC("5"),
      destination: "GDEST...",
      sourceAccountId: ids.sourceId,
      destinationAccountId: ids.sourceId,
      counterAccountId: ids.counterId,
      feeAccountId: ids.feesId,
      feeMinor: 50_000n,
    });
    fin.payments.markSubmitted(p.id, "0xabc123");
    fin.payments.markConfirmed(p.id);
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
      destination: "GDEST...",
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

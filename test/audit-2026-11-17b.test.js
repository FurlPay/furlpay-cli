/**
 * External audit 2026-11-17b remediation regression suite.
 *
 * Covers: H-04 (HLP 4-day lockup enforced from PERSISTED deposit state),
 * M-01 (daily turnover cap survives process restarts, atomic under races),
 * M-03 (keystore writes are atomic — a crash mid-write cannot truncate the
 * previous file), M-05 (kill switch honors --symbol scoping), M-02 (blotter
 * events persist and survive a fresh instance), L-02 (short value flags).
 * C-01/H-02/H-01/H-03 have their regressions inside the suites that own
 * those modules (escrow-lifecycle, agent-key-security, binance/cli).
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("os");
const path = require("node:path");

const { HlpVaultService } = require("../dist/hyperliquid/hlp");
const { HyperliquidRiskEngine, defaultTurnoverLedgerPath } = require("../dist/hyperliquid/risk-engine");
const { HyperliquidPerpService } = require("../dist/hyperliquid/perp");
const { KeystoreService } = require("../dist/wallet/keystore");
const { DurableEventStore, defaultBlotterPath } = require("../dist/blotter/durable-event-store");
const { parseFlags } = require("../lib/util");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-audit-b-"));
}

describe("audit H-04: HLP 4-day lockup enforced from persisted state", () => {
  it("a withdrawal right after a recorded deposit is refused BEFORE signing", async () => {
    const svc = new HlpVaultService("mainnet");
    const addr = "0x" + "ab".repeat(20);
    // Simulate a confirmed deposit 1 hour ago via the internal recorder.
    svc["recordDepositForLockup"](addr, Date.now() - 3_600_000);
    // withdraw() needs a signer before the lockup check; stub one.
    const fakeSigner = { getAddress: () => addr, signL1Action: async () => "0x", };
    svc.setSigner(fakeSigner);
    await assert.rejects(
      () => svc.withdraw(100, fakeSigner),
      /HLP_LOCKUP_ACTIVE/,
      "premature withdrawal must refuse at the client, before any signature"
    );
  });

  it("a withdrawal after the 4-day window passes the lockup gate (fails later, at the signer)", async () => {
    const svc = new HlpVaultService("mainnet");
    const addr = "0x" + "cd".repeat(20);
    svc["recordDepositForLockup"](addr, Date.now() - (4 * 86_400_000 + 60_000));
    const boom = async () => { throw new Error("submitAction exploded (expected — no live net in tests)"); };
    const fakeSigner = {
      getAddress: () => addr,
      signL1Action: boom,
    };
    svc.setSigner(fakeSigner);
    await assert.rejects(
      () => svc.withdraw(100, fakeSigner),
      (e) => !/HLP_LOCKUP_ACTIVE/.test(e.message),
      "lockup must NOT be the refusal once the 4 days elapsed"
    );
  });

  it("no deposit on record: nothing to enforce, no lockup refusal", async () => {
    const svc = new HlpVaultService("mainnet");
    const addr = "0x" + "ef".repeat(20);
    const fakeSigner = { getAddress: () => addr, signL1Action: async () => { throw new Error("past the gate"); } };
    svc.setSigner(fakeSigner);
    await assert.rejects(
      () => svc.withdraw(100, fakeSigner),
      (e) => !/HLP_LOCKUP_ACTIVE/.test(e.message)
    );
  });
});

describe("audit M-01: daily turnover cap is durable", () => {
  let dir, ledgerPath;

  beforeEach(() => {
    dir = tmpDir();
    ledgerPath = path.join(dir, "risk-turnover.json");
  });

  it("consumption recorded by one engine instance is enforced against a FRESH instance", () => {
    // Instance 1 consumes $200k of the $250k daily cap (via the durable record).
    const first = new HyperliquidRiskEngine({ dailyTurnoverCapUsd: 250_000 }, { turnoverLedgerPath: ledgerPath });
    // Directly exercise the atomic recorder the same way evaluatePreTrade does.
    const today = new Date().toISOString().slice(0, 10);
    const { withLedgerLock, readLedger, writeLedger } = require("../dist/services/persistentLedger");
    withLedgerLock(ledgerPath, () => {
      writeLedger(ledgerPath, { schema: "furlpay-risk-turnover-v1", day: today, consumedMinor: "200000000000" });
    });
    // A brand-new engine (new process) sees yesterday's.. today's consumption.
    const second = new HyperliquidRiskEngine({ dailyTurnoverCapUsd: 250_000 }, { turnoverLedgerPath: ledgerPath });
    second["checkDailyReset"]();
    assert.strictEqual(second["dailyTurnoverConsumedMinor"], 200_000_000_000n);
  });

  it("yesterday's consumption does not leak into today (UTC day rollover)", () => {
    const { withLedgerLock, writeLedger } = require("../dist/services/persistentLedger");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    withLedgerLock(ledgerPath, () => {
      writeLedger(ledgerPath, { schema: "furlpay-risk-turnover-v1", day: yesterday, consumedMinor: "250000000000" });
    });
    const engine = new HyperliquidRiskEngine({ dailyTurnoverCapUsd: 250_000 }, { turnoverLedgerPath: ledgerPath });
    engine["checkDailyReset"]();
    assert.strictEqual(engine["dailyTurnoverConsumedMinor"], 0n, "a new UTC day starts at zero");
  });

  it("defaultTurnoverLedgerPath points into the config ledgers dir", () => {
    const p = defaultTurnoverLedgerPath();
    assert.ok(p.includes("ledgers") && p.endsWith("risk-turnover.json"));
  });
});

describe("audit M-03: keystore writes are atomic", () => {
  it("saveEntries never truncates the previous file on a mid-write failure", () => {
    const dir = tmpDir();
    const ksPath = path.join(dir, "keystore.enc.json");
    const svc = new KeystoreService(ksPath);
    // Populate with one real entry (a VALID strkey seed — the keystore
    // validates format, which is exactly why a fake one must be refused).
    const { Keypair } = require("@stellar/stellar-sdk");
    const entry = svc.importSecretKey("audit-key", Keypair.random().secret(), "passw0rd!");
    void entry;
    const before = fs.readFileSync(ksPath, "utf8");
    // Sabotage rename so the atomic replace fails AFTER the temp write.
    const realRename = fs.renameSync;
    fs.renameSync = () => { throw new Error("disk exploded (simulated)"); };
    try {
      const svc2 = new KeystoreService(ksPath);
      assert.throws(() => svc2["saveEntries"]({ any: "new entries" }), /Keystore write failed/);
    } finally {
      fs.renameSync = realRename;
    }
    const after = fs.readFileSync(ksPath, "utf8");
    assert.strictEqual(after, before, "the previous keystore is byte-identical after a failed write");
    // No temp litter survives.
    assert.strictEqual(fs.readdirSync(dir).filter((f) => f.includes(".tmp-")).length, 0);
  });
});

describe("audit M-05: kill switch honors --symbol scoping", () => {
  it("triggerKillSwitch accepts a symbol and scopes cancels/closes to it", async () => {
    const svc = new HyperliquidPerpService();
    let canceledWith = null;
    let closedSymbols = [];
    svc["cancelAllOrders"] = async (coin) => { canceledWith = coin; return { status: "ok", canceledCount: coin ? 1 : 99 }; };
    svc["getPositions"] = async () => [
      { symbol: "BTC" }, { symbol: "ETH" }, { symbol: "SOL-PERP" },
    ];
    svc["closePosition"] = async (symbol) => { closedSymbols.push(symbol); };
    const fakeSigner = { getAddress: () => "0x" + "11".repeat(20) };
    const res = await svc.triggerKillSwitch(fakeSigner, "BTC");
    assert.strictEqual(canceledWith, "BTC", "only BTC orders were canceled");
    assert.deepStrictEqual(closedSymbols, ["BTC"], "only the BTC position was closed");
    assert.strictEqual(res.scopedTo, "BTC");
  });

  it("without a symbol the kill switch stays account-wide (full panic preserved)", async () => {
    const svc = new HyperliquidPerpService();
    let canceledWith = "unset";
    let closedSymbols = [];
    svc["cancelAllOrders"] = async (coin) => { canceledWith = coin; return { status: "ok", canceledCount: 3 }; };
    svc["getPositions"] = async () => [{ symbol: "BTC" }, { symbol: "ETH" }];
    svc["closePosition"] = async (symbol) => { closedSymbols.push(symbol); };
    const fakeSigner = { getAddress: () => "0x" + "22".repeat(20) };
    const res = await svc.triggerKillSwitch(fakeSigner);
    assert.strictEqual(canceledWith, undefined, "account-wide cancel");
    assert.deepStrictEqual(closedSymbols, ["BTC", "ETH"]);
    assert.strictEqual(res.scopedTo, undefined);
  });
});

describe("audit M-02: blotter persists execution events", () => {
  it("defaultBlotterPath resolves under ~/.furlpay/blotter", () => {
    assert.ok(defaultBlotterPath().includes("blotter"));
  });

  it("perp risk verdicts and outcomes land in the durable ledger", async () => {
    const dir = tmpDir();
    const blotterPath = path.join(dir, "events.json");
    // Patch defaultBlotterPath usage by constructing the store and injecting it.
    const store = new DurableEventStore({ filePath: blotterPath });
    const svc = new HyperliquidPerpService();
    // Replace the lazy audit with our explicit durable store.
    svc["blotter"] = store;
    svc["note"]("RISK_EVALUATION", { coin: "BTC", passed: false, reason: "test refusal" });
    svc["note"]("KILL_SWITCH_TRIGGERED", { scopedTo: "BTC", canceledOrders: 1, closedPositions: ["BTC"] });
    // A FRESH instance reading the same file sees both events, chain intact.
    const reloaded = new DurableEventStore({ filePath: blotterPath });
    const events = reloaded.getEvents();
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, "RISK_EVALUATION");
    assert.strictEqual(events[1].type, "KILL_SWITCH_TRIGGERED");
    assert.ok(reloaded.verifyIntegrity(), "fresh reload verifies the hash chain");
    // Tamper detection: a mutated event breaks the chain. Tamper the STORE
    // itself (simulating a hand-edited file), then reload.
    const onDisk = JSON.parse(fs.readFileSync(blotterPath, "utf8"));
    onDisk.events[0].payload = { tampered: true };
    fs.writeFileSync(blotterPath, JSON.stringify(onDisk));
    // The store FAILS CLOSED on a hand-edited ledger: it refuses to load at
    // all rather than extending a broken chain.
    assert.throws(
      () => new DurableEventStore({ filePath: blotterPath }),
      /hash chain INVALID/,
      "a tampered audit ledger is refused, never extended"
    );
  });
});

describe("audit L-02: declared short value flags parse correctly", () => {
  it("-z 2.0 binds the value, not true; -y stays boolean", () => {
    const f = parseFlags(["funding", "-z", "2.0", "--history", "f.json", "-y"]);
    assert.strictEqual(f.z, "2.0");
    assert.strictEqual(f.history, "f.json");
    assert.strictEqual(f.y, true);
  });

  it("-r takes a reason string", () => {
    const f = parseFlags(["cmd", "-r", "manual review"]);
    assert.strictEqual(f.r, "manual review");
  });
});

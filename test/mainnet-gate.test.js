/**
 * Mainnet Readiness Gate Test Suite (mainnet-readiness project, 2026-11-17).
 *
 * What is pinned, all offline against an injected transport:
 *   - HLP vaultTransfer wire format: INTEGER micro-USDC (1e6), never a float.
 *     `usd: 50` on the wire means $0.00005 — a unit bug that moves different
 *     money than the user asked to move. Deposit AND withdrawal are pinned,
 *     plus refusals for >6dp, non-finite, zero and the absurdity bound.
 *   - The readiness gate's classification contract: every blocking check PASS
 *     → verdict "ready"; a blocked safety condition (peg feed outage) or an
 *     unset prerequisite (master gate, signer) → verdict "not-ready".
 *   - The dry run evaluates through the REAL risk engine against stubbed
 *     market data and NEVER touches the /exchange endpoint — no signing path
 *     is reachable from a dry run.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const os = require("os");
const { mkdtempSync } = require("fs");

const { HlpVaultService } = require("../dist/hyperliquid/hlp");
const { MainnetGate } = require("../dist/mainnet/gate");

// ── transport stub ──────────────────────────────────────────────────────────

const MAINNET_INFO = "https://api.hyperliquid.xyz/info";

function stubFetch(routes) {
  return async (url, init) => {
    const hit = Object.keys(routes).find((k) => url.startsWith(k));
    if (!hit) return { ok: false, status: 503, json: async () => ({}) };
    const { status = 200, body } = routes[hit];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === "function" ? body(init && JSON.parse(init.body || "{}")) : body),
    };
  };
}

const HEALTHY_ROUTES = {
  [MAINNET_INFO]: {
    status: 200,
    body: (reqBody) => {
      if (reqBody.type === "allMids") return { BTC: "75000", ETH: "4000" };
      if (reqBody.type === "meta") {
        return { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }, { name: "ETH", szDecimals: 4, maxLeverage: 50 }] };
      }
      if (reqBody.type === "l2Book") return { levels: [[{ px: "75000.5", sz: "1" }], [{ px: "75000.5", sz: "1" }]] };
      throw new Error("unexpected info type " + reqBody.type);
    },
  },
  "https://api.coingecko.com": { status: 200, body: { "usd-coin": { usd: 0.9999 } } },
  "https://api.coinbase.com/v2/prices/USDC-USD/spot": { status: 200, body: { data: { amount: "0.9998" } } },
  "https://api.kraken.com": { status: 200, body: { result: { USDCUSD: { c: ["0.9998", "1"] } } } },
  "https://lite-api.jup.ag": { status: 200, body: { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { usdPrice: 0.9997 } } },
  "https://horizon.stellar.org/ledgers": { status: 200, body: { _embedded: { records: [{ sequence: 65530876 }] } } },
  "https://api.mainnet-beta.solana.com": {
    status: 200,
    body: { jsonrpc: "2.0", result: { epoch: 1089, absoluteSlot: 1, blockHeight: 1, slotIndex: 1, slotsInEpoch: 432000 }, id: 1 },
  },
};

// ── env management ──────────────────────────────────────────────────────────

let savedEnv;
before(() => {
  savedEnv = {
    LIVE: process.env.FURLPAY_LIVE,
    KEY: process.env.HYPERLIQUID_PRIVATE_KEY,
    ETH: process.env.ETH_PRIVATE_KEY,
  };
});
after(() => {
  if (savedEnv.LIVE === undefined) delete process.env.FURLPAY_LIVE; else process.env.FURLPAY_LIVE = savedEnv.LIVE;
  if (savedEnv.KEY === undefined) delete process.env.HYPERLIQUID_PRIVATE_KEY; else process.env.HYPERLIQUID_PRIVATE_KEY = savedEnv.KEY;
  if (savedEnv.ETH === undefined) delete process.env.ETH_PRIVATE_KEY; else process.env.ETH_PRIVATE_KEY = savedEnv.ETH;
});

// ── HLP wire format (Gap 2 — integer micro-USDC) ───────────────────────────

function stubHlpService(captured) {
  const svc = new HlpVaultService("mainnet", {
    getAddress: () => "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    signL1Action: async (action) => {
      captured.actions.push(action);
      return "0x" + "ab".repeat(32);
    },
  });
  // Isolate the durable lockup ledger per test instance — the 4-day guard is
  // real and durable, so a deposit in one test must never block another test.
  (svc).lockupLedgerPath = path.join(mkdtempSync(path.join(os.tmpdir(), "furlpay-hlp-")), "lockup.json");
  // Stub the stats query (would hit the network) — null share price skips the estimate.
  svc.getHlpStats = async () => ({ sharePriceUsd: null });
  // Stub the exchange transport — capture, never contact the wire.
  (svc).client = { submitAction: async (action, sig, nonce, vault) => {
    captured.submits.push({ action, sig, nonce, vault });
    return { status: "ok", response: { data: { txHash: "0x" + "cd".repeat(32) } } };
  } };
  return svc;
}

describe("HLP vaultTransfer wire format — integer micro-USDC", () => {
  it("deposit wires $50 as exactly 50000000 micro-USDC", async () => {
    process.env.FURLPAY_LIVE = "1";
    const captured = { actions: [], submits: [] };
    const svc = stubHlpService(captured);
    const res = await svc.deposit(50);
    assert.equal(res.status, "CONFIRMED");
    const action = captured.actions[0];
    assert.equal(action.type, "vaultTransfer");
    assert.equal(action.isDeposit, true);
    assert.equal(action.usd, 50000000, "the wire field must be the integer micro-USDC amount");
    assert.equal(Number.isInteger(action.usd), true);
  });

  it("withdrawal wires the integer too, with isDeposit false", async () => {
    process.env.FURLPAY_LIVE = "1";
    const captured = { actions: [], submits: [] };
    const svc = stubHlpService(captured);
    // Lockup ledger: no deposit on record → withdrawal allowed.
    await svc.withdraw(10.5);
    const action = captured.actions[0];
    assert.equal(action.isDeposit, false);
    assert.equal(action.usd, 10500000, "10.5 USD = 10,500,000 micro-USDC exactly");
  });

  it("rejects sub-micro-cent precision instead of silently rounding", async () => {
    process.env.FURLPAY_LIVE = "1";
    const captured = { actions: [], submits: [] };
    const svc = stubHlpService(captured);
    await assert.rejects(
      () => svc.deposit(50.1234567),
      /more than 6 decimal places/,
      "a silently-rounded deposit moves different money than the user asked to move"
    );
    assert.equal(captured.actions.length, 0, "nothing may be signed for a refused amount");
  });

  it("rejects zero, negative, non-finite and absurd amounts before any signing", async () => {
    process.env.FURLPAY_LIVE = "1";
    const captured = { actions: [], submits: [] };
    const svc = stubHlpService(captured);
    for (const bad of [0, -5, NaN, Infinity, 2e14]) {
      await assert.rejects(() => svc.deposit(bad), /must be positive|finite|sanity bound/);
    }
    assert.equal(captured.actions.length, 0);
  });
});

// ── readiness gate classification ───────────────────────────────────────────

describe("mainnet readiness gate", () => {
  it("every blocking check PASS → verdict ready", async () => {
    process.env.FURLPAY_LIVE = "1";
    process.env.HYPERLIQUID_PRIVATE_KEY = "0x" + "11".repeat(32);
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: stubFetch(HEALTHY_ROUTES), turnoverLedgerPath: path.join(tmp, "turnover.json"), lockupLedgerPath: path.join(tmp, "lockup.json") });
    const report = await gate.readiness();
    assert.equal(report.verdict, "ready");
    assert.equal(report.command, "mainnet readiness");
    for (const c of report.checks.filter((x) => x.blocksExecution)) {
      assert.equal(c.status, "PASS", `${c.id} must be PASS for a ready verdict (got ${c.status}: ${c.detail})`);
    }
  });

  it("a peg-feed outage is BLOCKED → not-ready (degraded is the control)", async () => {
    process.env.FURLPAY_LIVE = "1";
    process.env.HYPERLIQUID_PRIVATE_KEY = "0x" + "11".repeat(32);
    const routes = { ...HEALTHY_ROUTES };
    delete routes["https://api.coingecko.com"];
    delete routes["https://api.coinbase.com/v2/prices/USDC-USD/spot"];
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: stubFetch(routes), turnoverLedgerPath: path.join(tmp, "t.json"), lockupLedgerPath: path.join(tmp, "l.json") });
    const report = await gate.readiness();
    const peg = report.checks.find((c) => c.id === "hyperliquid.peg-feed");
    assert.equal(peg.status, "BLOCKED");
    assert.equal(report.verdict, "not-ready");
  });

  it("an unset master gate or missing signer is NOT_VERIFIED → not-ready", async () => {
    delete process.env.FURLPAY_LIVE;
    delete process.env.HYPERLIQUID_PRIVATE_KEY;
    delete process.env.ETH_PRIVATE_KEY;
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: stubFetch(HEALTHY_ROUTES), turnoverLedgerPath: path.join(tmp, "t.json"), lockupLedgerPath: path.join(tmp, "l.json") });
    const report = await gate.readiness();
    assert.equal(report.checks.find((c) => c.id === "gate.live-master").status, "NOT_VERIFIED");
    assert.equal(report.checks.find((c) => c.id === "hyperliquid.signer").status, "NOT_VERIFIED");
    assert.equal(report.verdict, "not-ready", "not-enabled is not ready — inert surfaces cannot execute");
    // Secrets never appear in the evidence.
    for (const c of report.checks) {
      assert.ok(!/0x[0-9a-f]{20,}/i.test(c.detail + " " + JSON.stringify(c)), "check evidence must never contain key material");
    }
  });
});

// ── dry run never signs ─────────────────────────────────────────────────────

describe("mainnet dry-run", () => {
  it("evaluates through the real risk engine and never touches /exchange", async () => {
    const seenUrls = [];
    const recording = async (url, init) => {
      seenUrls.push(url + " " + (init?.body ? JSON.parse(init.body).type : ""));
      return stubFetch(HEALTHY_ROUTES)(url, init);
    };
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: recording, turnoverLedgerPath: path.join(tmp, "t.json"), lockupLedgerPath: path.join(tmp, "l.json") });
    const res = await gate.dryRun({ coin: "BTC", side: "buy", size: 0.001, leverage: 1 });
    assert.equal(res.notSigned, true);
    assert.equal(res.notSubmitted, true);
    assert.equal(res.evaluated, true);
    assert.equal(res.risk.passed, true, "$75 notional against $10 min / $50k max must pass");
    assert.ok(seenUrls.every((u) => u.includes("info")), "only /info reads are reachable from a dry run");
  });

  it("the risk engine REFUSES a notional above the single-order cap", async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: stubFetch(HEALTHY_ROUTES), turnoverLedgerPath: path.join(tmp, "t.json"), lockupLedgerPath: path.join(tmp, "l.json") });
    const res = await gate.dryRun({ coin: "BTC", side: "buy", size: 1, leverage: 1 }); // 1 BTC @ 75k > $50k cap
    assert.equal(res.risk.passed, false);
    assert.match(res.risk.reason, /single order limit/);
    assert.equal(res.notSubmitted, true);
  });

  it("a broken book refuses evaluation (no synthetic mid is invented)", async () => {
    const routes = {
      ...HEALTHY_ROUTES,
      [MAINNET_INFO]: { status: 200, body: (reqBody) => (reqBody.type === "l2Book" ? { levels: [[], []] } : HEALTHY_ROUTES[MAINNET_INFO].body(reqBody)) },
    };
    const tmp = mkdtempSync(path.join(os.tmpdir(), "furlpay-gate-"));
    const gate = new MainnetGate({ fetchImpl: stubFetch(routes), turnoverLedgerPath: path.join(tmp, "t.json"), lockupLedgerPath: path.join(tmp, "l.json") });
    await assert.rejects(
      () => gate.dryRun({ coin: "BTC", side: "buy", size: 0.001, leverage: 1 }),
      /Empty book|DRY_RUN_NO_MARKET/,
      "a broken book must refuse evaluation — never a synthetic mid"
    );
  });
});

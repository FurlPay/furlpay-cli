/**
 * Capability Registry & Live Gate tests (readiness P1, 2026-11-17)
 *
 * Proves the mechanical guarantee the honesty matrix previously only
 * promised in prose:
 * - a signing path that never registered itself cannot execute,
 * - a simulated/local surface is never gated as live (and never signs),
 * - every registered live signing surface refuses without FURLPAY_LIVE=1,
 * - the opt-in opens exactly what it names — and nothing else,
 * - the gate fires BEFORE any network call is built (Binance stub: 0 calls).
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const { CAPABILITIES, assertLiveAllowed, isLiveOptIn, listCapabilities } = require("../dist/capabilities/registry");

describe("Capability registry live gate", () => {
  const saved = process.env.FURLPAY_LIVE;

  beforeEach(() => { delete process.env.FURLPAY_LIVE; });
  afterEach(() => {
    if (saved === undefined) delete process.env.FURLPAY_LIVE;
    else process.env.FURLPAY_LIVE = saved;
  });

  it("registry: every live signing surface is declared, and none go ungated", () => {
    const signing = listCapabilities().filter((c) => c.signsOrBroadcasts);
    assert.deepStrictEqual(
      signing.map((c) => c.id).sort(),
      ["binance.spot", "hyperliquid.hlp-deposit", "hyperliquid.hlp-withdraw", "hyperliquid.perp-execution"],
      "exactly the four live signing surfaces are registered — a new one must be added deliberately"
    );
    for (const c of signing) assert.strictEqual(c.mode, "live", `${c.id} signs but is not mode=live`);
    // Simulated surfaces never claim to sign — that combination is a lie.
    for (const c of listCapabilities()) {
      if (c.mode === "simulated" || c.mode === "local") {
        assert.strictEqual(c.signsOrBroadcasts, false, `${c.id} is ${c.mode} but claims to sign/broadcast`);
      }
    }
  });

  it("unknown surface ids refuse — no default pass for unregistered signing paths", () => {
    assert.throws(() => assertLiveAllowed("someone.new.signing-path"), /LIVE_GATE_UNKNOWN_SURFACE/);
  });

  it("simulated/local surfaces pass the gate (they never move value)", () => {
    assert.doesNotThrow(() => assertLiveAllowed("stellar.sdex"));
    assert.doesNotThrow(() => assertLiveAllowed("finance.payments"));
  });

  it("live signing surfaces refuse without FURLPAY_LIVE", () => {
    assert.strictEqual(isLiveOptIn(), false);
    for (const id of ["hyperliquid.perp-execution", "hyperliquid.hlp-deposit", "hyperliquid.hlp-withdraw", "binance.spot"]) {
      assert.throws(() => assertLiveAllowed(id), new RegExp(`LIVE_GATE_CLOSED.*${id.replace(".", "\\.")}`), `${id} must refuse`);
    }
  });

  it("FURLPAY_LIVE=1 opens the declared live surfaces", () => {
    process.env.FURLPAY_LIVE = "1";
    assert.strictEqual(isLiveOptIn(), true);
    assert.doesNotThrow(() => assertLiveAllowed("hyperliquid.perp-execution"));
    assert.doesNotThrow(() => assertLiveAllowed("binance.spot"));
  });
});

describe("Live gate wiring — the gate fires before the wire", () => {
  const saved = process.env.FURLPAY_LIVE;

  beforeEach(() => { delete process.env.FURLPAY_LIVE; });
  afterEach(() => {
    if (saved === undefined) delete process.env.FURLPAY_LIVE;
    else process.env.FURLPAY_LIVE = saved;
  });

  it("Binance marketOrder refuses at the gate and builds ZERO http requests", async () => {
    const { BinanceAdapter } = require("../dist/binance/binance.adapter");
    const savedKey = process.env.BINANCE_API_KEY;
    const savedSecret = process.env.BINANCE_API_SECRET;
    process.env.BINANCE_API_KEY = "stub-key";
    process.env.BINANCE_API_SECRET = "stub-secret";
    let calls = 0;
    const transport = async () => { calls++; throw new Error("must not be reached"); };
    try {
      const adapter = new BinanceAdapter({ env: "testnet", fetchImpl: transport, nowMs: () => 1_794_740_000_000 });
      await assert.rejects(
        () => adapter.marketOrder({ symbol: "BTCUSDT", side: "BUY", notionalUsd: 50 }, () => ({ authorized: true })),
        /LIVE_GATE_CLOSED/
      );
      assert.strictEqual(calls, 0, "the gate must fire before any signed request is built");
    } finally {
      if (savedKey === undefined) delete process.env.BINANCE_API_KEY;
      else process.env.BINANCE_API_KEY = savedKey;
      if (savedSecret === undefined) delete process.env.BINANCE_API_SECRET;
      else process.env.BINANCE_API_SECRET = savedSecret;
    }
  });
});

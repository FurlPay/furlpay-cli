"use strict";
// Binance integration battery — the signing boundary, the environment
// separation, and the agent-trust gate. Everything here runs against stubbed
// transport; live/testnet verification is BLOCKED on credentials and is a
// separate, clearly-labeled suite.
//
// The battery exercises the signed-order path, so it runs with the capability
// live gate opted in (FURLPAY_LIVE=1) — exactly as an operator would. The
// gate's refusal behavior is proven separately in test/live-gate.test.js.
process.env.FURLPAY_LIVE = "1";
const test = require("node:test");
const assert = require("node:assert");
const { signRequest, hmacSha256Hex, credentialsFromEnv } = require("../dist/binance/binance.auth.js");
const { BinanceClient, BinanceApiError, HOSTS } = require("../dist/binance/binance.client.js");
const { BinanceAdapter, binanceCapabilities } = require("../dist/binance/binance.adapter.js");

const FIXED_NOW = 1_794_740_000_000;
const SECRET = "test-secret-key-never-a-real-credential";
const KEY = "test-public-api-key";

const CREDENTIALS = { apiKey: KEY, apiSecret: SECRET };

function stubFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || null });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call: " + url);
    return typeof next === "function" ? next(url, init) : next;
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("signing is deterministic and covers exactly the bytes sent", () => {
  const signed = signRequest(CREDENTIALS, "GET", "/api/v3/account", {}, {
    nowMs: FIXED_NOW,
    recvWindowMs: 5000,
  });
  const expectedSig = hmacSha256Hex(
    SECRET,
    `timestamp=${FIXED_NOW}&recvWindow=5000`
  );
  assert.strictEqual(signed.queryString, `timestamp=${FIXED_NOW}&recvWindow=5000&signature=${expectedSig}`);
  assert.strictEqual(signed.headers["X-MBX-APIKEY"], KEY);
  // The signature is HMAC-SHA256 of the exact query prefix — no hidden bytes.
  assert.strictEqual(signed.queryString.split("signature=")[1], expectedSig);
});

test("recvWindow and timestamp are added by the signer, not trusted from the caller", () => {
  const signed = signRequest(CREDENTIALS, "POST", "/api/v3/order", {}, { nowMs: FIXED_NOW });
  assert.ok(signed.queryString.includes(`timestamp=${FIXED_NOW}`));
  assert.ok(signed.queryString.includes(`recvWindow=5000`));
});

test("the API secret never appears in the signed output", () => {
  const signed = signRequest(CREDENTIALS, "GET", "/api/v3/account", {}, { nowMs: FIXED_NOW });
  assert.ok(!signed.queryString.includes(SECRET));
  assert.ok(!signed.headers["X-MBX-APIKEY"].includes(SECRET));
});

test("credentials come from the environment only — never argv, never defaults", () => {
  assert.strictEqual(credentialsFromEnv({}), null);
  assert.deepStrictEqual(
    credentialsFromEnv({ BINANCE_API_KEY: "k", BINANCE_API_SECRET: "s" }),
    { apiKey: "k", apiSecret: "s" }
  );
});

test("testnet and mainnet hosts are distinct constants — never silently swapped", () => {
  assert.strictEqual(HOSTS.testnet.spot, "https://testnet.binance.vision");
  assert.strictEqual(HOSTS.mainnet.spot, "https://api.binance.com");
  assert.notStrictEqual(HOSTS.testnet.spot, HOSTS.mainnet.spot);
  const tn = new BinanceClient({
    env: "testnet", market: "spot", apiKey: KEY, apiSecret: SECRET, fetchImpl: async () => jsonResponse(200, {}),
  });
  assert.strictEqual(tn.baseUrl, "https://testnet.binance.vision");
});

test("exchange errors surface code, message and http status — never a synthetic success", async () => {
  const fetchImpl = stubFetch([jsonResponse(418, { code: -1021, msg: "Timestamp outside recvWindow" })]);
  const client = new BinanceClient({
    env: "testnet", market: "spot", apiKey: KEY, apiSecret: SECRET, fetchImpl, nowMs: () => FIXED_NOW,
  });
  await assert.rejects(
    client.accountSnapshot(),
    (e) => e instanceof BinanceApiError && e.code === -1021 && e.httpStatus === 418
  );
});

test("balances pass the signed request; the adapter filters zero rows", async () => {
  const fetchImpl = stubFetch([
    jsonResponse(200, {
      accountType: "SPOT", canTrade: true,
      balances: [
        { asset: "USDT", free: "100.00000000", locked: "0.00000000" },
        { asset: "BTC", free: "0.00000000", locked: "0.00000000" },
      ],
    }),
  ]);
  const client = new BinanceClient({
    env: "testnet", market: "spot", apiKey: KEY, apiSecret: SECRET, fetchImpl, nowMs: () => FIXED_NOW,
  });
  const snap = await client.accountSnapshot();
  assert.strictEqual(snap.balances.length, 2, "client returns the exchange rows verbatim");
  assert.strictEqual(snap.balances[0].asset, "USDT");

  // The adapter layer filters zero-value rows.
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl: stubFetch([
      jsonResponse(200, {
        accountType: "SPOT", canTrade: true,
        balances: [
          { asset: "USDT", free: "100.00000000", locked: "0.00000000" },
          { asset: "BTC", free: "0.00000000", locked: "0.00000000" },
        ],
      }),
    ]), nowMs: () => FIXED_NOW });
    const filtered = await adapter.balances();
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].asset, "USDT");
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
  // The request carried the signature and the API key header.
  const call = fetchImpl.calls[0];
  assert.ok(call.url.startsWith("https://testnet.binance.vision/api/v3/account?"));
  assert.ok(call.url.includes("signature="));
  assert.strictEqual(call.init.headers["X-MBX-APIKEY"], KEY);
});

test("capability registry: withdrawals are explicitly FALSE, oco/websockets declared not-implemented", () => {
  const caps = binanceCapabilities("testnet");
  assert.strictEqual(caps.supports.withdrawals, false);
  assert.strictEqual(caps.supports.ocoOrders, false);
  assert.strictEqual(caps.supports.websockets, false);
  assert.strictEqual(caps.supports.balances, true);
  assert.strictEqual(caps.supports.marketOrders, true);
});

test("the adapter refuses to construct without environment credentials", () => {
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_SECRET;
  try {
    assert.throws(() => new BinanceAdapter({ env: "testnet" }), /BINANCE_API_KEY/);
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
  }
});

test("the mandate gate runs BEFORE signing — a refused order never becomes a request", async () => {
  const fetchImpl = stubFetch([]); // zero expected calls
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl, nowMs: () => FIXED_NOW });
    await assert.rejects(
      adapter.marketOrder(
        { symbol: "BTCUSDT", side: "BUY", notionalUsd: 9_999, agentAddress: "0xagent" },
        () => ({ authorized: false, reason: "exceeds mandate maxSingleOrderUsd" })
      ),
      /POLICY_REFUSED: exceeds mandate maxSingleOrderUsd/
    );
    assert.strictEqual(fetchImpl.calls.length, 0, "no HTTP request may be built for a refused order");
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
});

test("an authorized market buy sends quoteOrderQty and surfaces the exchange's own confirmation", async () => {
  const fetchImpl = stubFetch([
    jsonResponse(200, {
      symbol: "BTCUSDT", orderId: 991, clientOrderId: "cli-1", status: "NEW",
      executedQty: "0", transactTime: FIXED_NOW,
    }),
  ]);
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl, nowMs: () => FIXED_NOW });
    const order = await adapter.marketOrder(
      { symbol: "btcusdt", side: "BUY", notionalUsd: 50, agentAddress: "0xagent" },
      () => ({ authorized: true })
    );
    assert.strictEqual(order.orderId, 991);
    assert.strictEqual(order.status, "NEW");
    const call = fetchImpl.calls[0];
    // POST order parameters travel in the urlencoded REQUEST BODY, never the
    // URL query — order details must not leak into proxies and access logs
    // (audit P4, CWE-598).
    assert.strictEqual(call.init.method, "POST");
    assert.strictEqual(call.init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.ok(call.init.body.includes("type=MARKET"));
    assert.ok(call.init.body.includes("quoteOrderQty=50"));
    assert.ok(call.init.body.includes("symbol=BTCUSDT"));
    assert.ok(call.init.body.includes("signature="));
    assert.ok(!call.url.includes("type=MARKET"), "order params must not appear in the URL");
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
});

test("market SELL refuses to invent a quantity from a float price", async () => {
  const fetchImpl = stubFetch([]);
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl, nowMs: () => FIXED_NOW });
    await assert.rejects(
      adapter.marketOrder(
        { symbol: "BTCUSDT", side: "SELL", notionalUsd: 50, agentAddress: "0xagent" },
        () => ({ authorized: true })
      ),
      /MARKET_SELL_QUANTITY_REQUIRED/
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
});

test("non-numeric notional is refused before any gate or network call", async () => {
  const fetchImpl = stubFetch([]);
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl, nowMs: () => FIXED_NOW });
    await assert.rejects(
      adapter.marketOrder(
        { symbol: "BTCUSDT", side: "BUY", notionalUsd: Number.NaN, agentAddress: "0xagent" },
        () => ({ authorized: true })
      ),
      /notionalUsd must be a positive finite number/
    );
    await assert.rejects(
      adapter.marketOrder(
        { symbol: "BTCUSDT", side: "BUY", notionalUsd: 0, agentAddress: "0xagent" },
        () => ({ authorized: true })
      ),
      /notionalUsd must be a positive finite number/
    );
    assert.strictEqual(fetchImpl.calls.length, 0);
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
});

test("there is no withdrawal capability anywhere on the adapter surface", () => {
  const saved = { k: process.env.BINANCE_API_KEY, s: process.env.BINANCE_API_SECRET };
  process.env.BINANCE_API_KEY = KEY;
  process.env.BINANCE_API_SECRET = SECRET;
  try {
    const adapter = new BinanceAdapter({ env: "testnet", fetchImpl: async () => jsonResponse(200, {}), nowMs: () => FIXED_NOW });
    assert.strictEqual(adapter.capabilities.supports.withdrawals, false);
    assert.strictEqual(typeof adapter.withdraw, "undefined");
    assert.strictEqual(typeof adapter.withdrawCrypto, "undefined");
    assert.strictEqual(typeof adapter.transferOut, "undefined");
  } finally {
    if (saved.k) process.env.BINANCE_API_KEY = saved.k;
    else delete process.env.BINANCE_API_KEY;
    if (saved.s) process.env.BINANCE_API_SECRET = saved.s;
    else delete process.env.BINANCE_API_SECRET;
  }
});

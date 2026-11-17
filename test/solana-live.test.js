/**
 * Solana Live Read-Only Surface Test Suite (gap report 2026-11-17, Gap 5).
 *
 * Offline tests with an injected transport — what is pinned:
 *   - Address validation fails closed (base58 charset + length, no 0/O/I/l).
 *   - https-only RPC endpoint enforcement.
 *   - Real JSON-RPC response parsing for getEpochInfo / getBalance.
 *   - RPC protocol errors and HTTP failures THROW — never a synthetic slot,
 *     never epoch 0.
 *   - Jupiter: alias resolution, integer-amount enforcement (a float amount
 *     is a precision bug, not convenience), slippage bounds, and the
 *     INDICATIVE execution label that can never be filled by this build.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { SolanaRpcClient, assertValidSolanaAddress } = require("../dist/solana/rpc");
const { JupiterClient, resolveMint, KNOWN_MINTS } = require("../dist/solana/jupiter");

/** Build a fetch impl from a map: url → {status, body}. Unmapped URLs get HTTP 503. */
function fetchMap(map) {
  return async (url, init) => {
    const hit = Object.keys(map).find((k) => url.startsWith(k));
    if (!hit) return { ok: false, status: 503, json: async () => ({}) };
    const { status = 200, body, capture } = map[hit];
    if (capture) capture(init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === "function" ? body(JSON.parse(init.body)) : body),
    };
  };
}

const MAINNET = "https://api.mainnet-beta.solana.com";
const VALID_MINT = "So11111111111111111111111111111111111111112";

describe("solana address validation — fail closed", () => {
  it("accepts a real base58 address", () => {
    assert.equal(assertValidSolanaAddress(VALID_MINT), VALID_MINT);
  });

  it("rejects base58-lookalike chars (0, O, I, l) and wrong lengths", () => {
    for (const bad of ["0x1234567890abcdef", "lO1", VALID_MINT.slice(0, 31), "g".repeat(45), ""]) {
      assert.throws(() => assertValidSolanaAddress(bad), /INVALID_SOLANA_ADDRESS/, `should reject: ${bad}`);
    }
  });

  it("rejects a non-base58 address BEFORE any network request", async () => {
    let calls = 0;
    const client = new SolanaRpcClient({ fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ result: { value: 0 } }) }; } });
    await assert.rejects(() => client.getBalanceLamports("not-a-base58-address!"), /INVALID_SOLANA_ADDRESS/);
    assert.equal(calls, 0, "invalid input must never produce an RPC call");
  });
});

describe("solana rpc client", () => {
  it("refuses non-https endpoints at construction", () => {
    assert.throws(() => new SolanaRpcClient({ rpcUrl: "http://evil.example" }), /INSECURE_URL/);
  });

  it("parses a real getEpochInfo response shape", async () => {
    const client = new SolanaRpcClient({
      fetchImpl: fetchMap({
        [MAINNET]: {
          status: 200,
          body: { jsonrpc: "2.0", result: { epoch: 1089, absoluteSlot: 470600311, blockHeight: 448615116, slotIndex: 152311, slotsInEpoch: 432000, transactionCount: 567117230629 }, id: 1 },
        },
      }),
    });
    const epoch = await client.getEpochInfo();
    assert.equal(epoch.epoch, 1089);
    assert.equal(epoch.absoluteSlot, 470600311);
    assert.equal(epoch.slotsInEpoch, 432000);
    assert.equal(epoch.transactionCount, 567117230629);
  });

  it("surfaces JSON-RPC protocol errors with the method name — never a fake result", async () => {
    const client = new SolanaRpcClient({
      fetchImpl: fetchMap({ [MAINNET]: { status: 200, body: { jsonrpc: "2.0", error: { message: "Invalid param" } } } }),
    });
    await assert.rejects(() => client.getEpochInfo(), /getEpochInfo.*Invalid param/s);
  });

  it("surfaces HTTP failures and missing results", async () => {
    const httpFail = new SolanaRpcClient({ fetchImpl: fetchMap({ [MAINNET]: { status: 429, body: {} } }) });
    await assert.rejects(() => httpFail.getSlot(), /HTTP 429/);
    const noResult = new SolanaRpcClient({ fetchImpl: fetchMap({ [MAINNET]: { status: 200, body: { jsonrpc: "2.0" } } }) });
    await assert.rejects(() => noResult.getSlot(), /no result/);
  });

  it("getBalance returns lamports as an integer", async () => {
    const client = new SolanaRpcClient({
      fetchImpl: fetchMap({ [MAINNET]: { status: 200, body: { jsonrpc: "2.0", result: { value: 4298304561, context: { slot: 1 } } } } }),
    });
    const lamports = await client.getBalanceLamports(VALID_MINT);
    assert.equal(lamports, 4298304561);
    assert.equal(Number.isInteger(lamports), true);
  });
});

describe("jupiter client — indicative-only routing surface", () => {
  it("resolves aliases and validates raw mints", () => {
    assert.equal(resolveMint("sol"), KNOWN_MINTS.SOL);
    assert.equal(resolveMint("USDC"), KNOWN_MINTS.USDC);
    assert.equal(resolveMint(VALID_MINT), VALID_MINT);
    assert.throws(() => resolveMint("NOT!A@MINT"), /INVALID_SOLANA_ADDRESS/);
  });

  it("refuses a non-https base URL", () => {
    assert.throws(() => new JupiterClient({ baseUrl: "http://x.example" }), /INSECURE_URL/);
  });

  it("enforces integer raw amounts (on-chain has no fractional lamports)", async () => {
    const client = new JupiterClient({ fetchImpl: fetchMap({}) });
    await assert.rejects(() => client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "100.5" }), /JUPITER_INVALID_AMOUNT/);
    await assert.rejects(() => client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "0" }), /JUPITER_INVALID_AMOUNT/);
    await assert.rejects(() => client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "-5" }), /JUPITER_INVALID_AMOUNT/);
  });

  it("enforces slippage bounds [0, 10000]", async () => {
    const client = new JupiterClient({ fetchImpl: fetchMap({}) });
    await assert.rejects(() => client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "1", slippageBps: 10001 }), /JUPITER_INVALID_SLIPPAGE/);
    await assert.rejects(() => client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "1", slippageBps: 1.5 }), /JUPITER_INVALID_SLIPPAGE/);
  });

  it("parses the real quote shape and labels it INDICATIVE", async () => {
    const client = new JupiterClient({
      fetchImpl: fetchMap({
        "https://lite-api.jup.ag": {
          status: 200,
          body: {
            inputMint: VALID_MINT, outputMint: KNOWN_MINTS.USDC,
            inAmount: "100000000", outAmount: "7248627", slippageBps: 50,
            priceImpactPct: "0", swapMode: "ExactIn",
            routePlan: [{ swapInfo: { label: "ZeroFi" } }, { swapInfo: { label: "Orca" } }],
          },
        },
      }),
    });
    const q = await client.quote({ inputMint: "SOL", outputMint: "USDC", amount: "100000000" });
    assert.equal(q.execution, "INDICATIVE");
    assert.deepEqual(q.routeLabels, ["ZeroFi", "Orca"]);
    assert.equal(q.outAmount, "7248627");
    assert.equal(q.slippageBps, 50);
  });

  it("a malformed or failed quote response is null — no route is fabricated", async () => {
    const bad = new JupiterClient({ fetchImpl: fetchMap({ "https://lite-api.jup.ag": { status: 200, body: { unexpected: true } } }) });
    assert.equal(await bad.quote({ inputMint: "SOL", outputMint: "USDC", amount: "1" }), null);
    const down = new JupiterClient({ fetchImpl: fetchMap({}) });
    assert.equal(await down.priceUsd("SOL"), null);
  });

  it("priceUsd parses the v3 shape; non-finite prices are null", async () => {
    const client = new JupiterClient({
      fetchImpl: fetchMap({ "https://lite-api.jup.ag": { status: 200, body: { [VALID_MINT]: { usdPrice: 72.31, decimals: 9, liquidity: 781086335 } } } }),
    });
    const p = await client.priceUsd("SOL");
    assert.equal(p.usdPrice, 72.31);
    assert.equal(p.decimals, 9);
    assert.equal(p.mint, VALID_MINT);
    const nan = new JupiterClient({ fetchImpl: fetchMap({ "https://lite-api.jup.ag": { status: 200, body: { [VALID_MINT]: { usdPrice: NaN } } } }) });
    assert.equal(await nan.priceUsd("SOL"), null);
  });
});

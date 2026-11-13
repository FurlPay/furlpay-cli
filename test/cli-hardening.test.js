/**
 * CLI hardening regression tests — tx verify, faucet, config validate.
 *
 * Network behavior is exercised through injected fetch implementations;
 * no test in this file touches the real network.
 */

const assert = require("assert");
const test = require("node:test");
const {
  verifyTransaction,
  isValidTxHash,
  requestFunds,
  isValidStellarAddress,
  FRIENDBOT_URLS,
  validateConfig,
  CANONICAL_PASSPHRASES,
  DEFAULT_CONFIG,
} = require("../dist/index");
const { Keypair } = require("@stellar/stellar-sdk");

// ---------------------------------------------------------------------------
// tx verify — honest Horizon lookup semantics
// ---------------------------------------------------------------------------

const GOOD_HASH = "ab".repeat(32);

function fetchJson(status, body) {
  return async () => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
}

test("txVerify: rejects malformed hashes without any network request", async () => {
  assert.equal(isValidTxHash("not-a-hash"), false);
  assert.equal(isValidTxHash("AB".repeat(32)), false, "uppercase hex is rejected (hashes are lowercase)");
  assert.equal(isValidTxHash("ab".repeat(31) + "zz"), false);

  let networkCalled = false;
  const res = await verifyTransaction("nope", {
    fetchImpl: async () => {
      networkCalled = true;
      throw new Error("must not be called");
    },
  });
  assert.equal(networkCalled, false, "invalid hash must short-circuit before any fetch");
  assert.equal(res.status, "INVALID_HASH");
});

test("txVerify: CONFIRMED_SUCCESS reports inclusion and honesty strings", async () => {
  const res = await verifyTransaction(GOOD_HASH, {
    network: "testnet",
    fetchImpl: fetchJson(200, {
      successful: true,
      ledger: 123456,
      created_at: "2026-11-13T00:00:00Z",
      source_account: "GAAAA",
      operation_count: 2,
      fee_charged: "200",
      result_xdr: "AAAAAA==",
    }),
  });
  assert.equal(res.status, "CONFIRMED_SUCCESS");
  assert.equal(res.found.successful, true);
  assert.equal(res.found.ledger, 123456);
  assert.match(res.whatWasVerified, /included in finalized ledger 123456/);
  assert.match(res.whatWasNotVerified, /not an independent cryptographic re-verification/i);
});

test("txVerify: a transaction included in a ledger but failed is CONFIRMED_FAILED, never 'successful'", async () => {
  const res = await verifyTransaction(GOOD_HASH, {
    fetchImpl: fetchJson(200, { successful: false, ledger: 99 }),
  });
  assert.equal(res.status, "CONFIRMED_FAILED");
  assert.equal(res.found.successful, false);
});

test("txVerify: 404 is NOT_FOUND with explicit non-existence disclaimer", async () => {
  const res = await verifyTransaction(GOOD_HASH, { fetchImpl: fetchJson(404, {}) });
  assert.equal(res.status, "NOT_FOUND");
  assert.match(res.whatWasNotVerified, /NOT proof the transaction does not exist/i);
  assert.match(res.whatWasNotVerified, /different network|not yet included/i);
});

test("txVerify: outages are UNAVAILABLE and never presented as evidence about the tx", async () => {
  const res = await verifyTransaction(GOOD_HASH, {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(res.status, "UNAVAILABLE");
  assert.match(res.whatWasNotVerified, /not evidence about the transaction/i);
  assert.match(res.error, /ECONNREFUSED/);
});

// ---------------------------------------------------------------------------
// faucet — Friendbot funding with honest reporting
// ---------------------------------------------------------------------------

test("faucet: address validation gates every request locally", () => {
  assert.equal(isValidStellarAddress("GABC"), false);
  assert.equal(isValidStellarAddress(""), false);
  assert.equal(isValidStellarAddress("garbage-addr"), false);
  assert.equal(isValidStellarAddress(Keypair.random().publicKey()), true);
});

test("faucet: only faucet-capable networks are exposed — mainnet has no entry", () => {
  assert.deepStrictEqual(Object.keys(FRIENDBOT_URLS).sort(), ["futurenet", "testnet"]);
  assert.ok(FRIENDBOT_URLS.testnet.startsWith("https://"));
  assert.ok(FRIENDBOT_URLS.futurenet.startsWith("https://"));
});

test("faucet: success requires the Friendbot's own successful response", async () => {
  const kp = Keypair.random();
  let calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("friendbot")) {
      return { status: 200, ok: true, json: async () => ({ hash: "cd".repeat(32), ledger: 777 }) };
    }
    // Horizon account lookup after funding
    return {
      status: 200,
      ok: true,
      json: async () => ({ balances: [{ asset_type: "native", balance: "10000.0000000" }] }),
    };
  };
  const res = await requestFunds(kp.publicKey(), { network: "testnet", fetchImpl });
  assert.equal(res.funded, true);
  assert.equal(res.transactionHash, "cd".repeat(32));
  assert.equal(res.ledger, 777);
  assert.equal(res.balanceVerified, true);
  assert.ok(calls.some((u) => u.startsWith(FRIENDBOT_URLS.testnet)), "uses the documented friendbot endpoint");
});

test("faucet: a Friendbot refusal is reported as NOT funded with the raw reason", async () => {
  const kp = Keypair.random();
  const res = await requestFunds(kp.publicKey(), {
    network: "testnet",
    fetchImpl: async () => ({ status: 429, ok: false, text: async () => "rate limited" }),
  });
  assert.equal(res.funded, false);
  assert.match(res.error, /did not fund the account/);
  assert.match(res.error, /No funding occurred/);
  assert.match(res.error, /429/);
});

test("faucet: unreachable Friendbot is a funding failure, never a fabricated success", async () => {
  const kp = Keypair.random();
  const res = await requestFunds(kp.publicKey(), {
    network: "futurenet",
    fetchImpl: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(res.funded, false);
  assert.match(res.error, /Friendbot unreachable/);
  assert.equal(res.transactionHash, null);
});

// ---------------------------------------------------------------------------
// config validate
// ---------------------------------------------------------------------------

test("config validate: shipped defaults pass", () => {
  const res = validateConfig(DEFAULT_CONFIG);
  const failed = res.checks.filter((c) => !c.ok && c.severity === "error");
  assert.ok(res.valid, `defaults must validate; failed: ${JSON.stringify(failed)}`);
  assert.ok(res.checks.length >= 10, "covers network, wallet, trading, agent_trust, ui");
});

test("config validate: canonical passphrases are pinned", () => {
  assert.equal(CANONICAL_PASSPHRASES.mainnet, "Public Global Stellar Network ; September 2015");
  assert.equal(CANONICAL_PASSPHRASES.testnet, "Test SDF Network ; September 2015");
  const bad = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  bad.network.mainnet.passphrase = "wrong passphrase";
  const res = validateConfig(bad);
  assert.equal(res.valid, false);
  const failed = res.checks.find((c) => c.name === "network.mainnet.passphrase");
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /canonical/);
});

test("config validate: unenforceable agent caps are rejected", () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  bad.agent_trust.maxSingleTxUsd = 500;
  bad.agent_trust.dailyVelocityCapUsd = 250; // single-tx cap exceeds the daily cap
  const res = validateConfig(bad);
  assert.equal(res.valid, false);
  assert.equal(res.checks.find((c) => c.name === "agent_trust.singleTxWithinDailyCap").ok, false);
});

test("config validate: zero slippage is an error (it silently disables protection)", () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  bad.trading.defaultSlippagePct = 0;
  const res = validateConfig(bad);
  assert.equal(res.valid, false);
  assert.equal(res.checks.find((c) => c.name === "trading.defaultSlippagePct").ok, false);
});

test("config validate: memory keyring is at least a warning, never silently OK", () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  bad.wallet.keyringBackend = "memory";
  const res = validateConfig(bad);
  const warn = res.checks.find((c) => c.name === "wallet.keyringBackend.memoryWarning");
  assert.ok(warn, "memory keyring must produce an explicit warning");
  assert.equal(warn.severity, "warning");
});

test("config validate: http:// (non-https) endpoints are rejected", () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  bad.network.testnet.horizonUrl = "http://horizon-testnet.stellar.org";
  const res = validateConfig(bad);
  assert.equal(res.valid, false);
  assert.equal(res.checks.find((c) => c.name === "network.testnet.horizonUrl").ok, false);
});

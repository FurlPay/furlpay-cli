/**
 * Key-material redaction property test (readiness P3, 2026-11-17)
 *
 * For any error thrown, any stringification, and any JSON serialization of
 * the signer stack, the private key hex must never appear. This is the
 * mechanical guarantee behind "secrets stay out of terminal output".
 */

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const { HyperliquidSigner } = require("../dist/hyperliquid/signer");

function keyLeakScanner(secretHex) {
  const needle = secretHex.toLowerCase().replace(/^0x/, "");
  return (text) => text.toLowerCase().includes(needle);
}

describe("Key-material redaction", () => {
  it("P0: the private key never appears in signer errors, toString, or JSON", async () => {
    const wallet = ethers.Wallet.createRandom();
    const secretHex = wallet.privateKey;
    const leaks = keyLeakScanner(secretHex);
    const signer = new HyperliquidSigner(secretHex, false);

    // Address is public; the key is not.
    assert.ok(!leaks(signer.getAddress()), "address output must not contain the key");
    assert.ok(!leaks(String(signer)), "toString must not contain the key");
    assert.ok(!leaks(JSON.stringify(signer)), "JSON serialization must not contain the key");

    // Signing produces {r,s,v} only.
    const sig = await signer.signL1Action({ type: "order", orders: [], grouping: "na" }, Date.now());
    assert.ok(!leaks(JSON.stringify(sig)), "signature envelope must not contain the key");

    // Admin-action refusal (the fail-closed guard) must not leak the key either.
    try {
      await signer.signL1Action({ type: "withdraw3" }, Date.now());
      assert.fail("admin action must be refused");
    } catch (e) {
      assert.ok(!leaks(String(e.message)), `refusal message must not contain the key (got: ${e.message.slice(0, 60)}…)`);
      assert.match(e.message, /SECURITY_VIOLATION/);
    }

    // Bad input errors stay clean too.
    for (const bad of [null, undefined, 42, { noType: true }]) {
      try {
        await signer.signL1Action(bad, -1);
      } catch (e) {
        assert.ok(!leaks(String(e?.message ?? e)), "input-validation errors must not contain the key");
      }
    }
  });

  it("P1: a second signer built from a DIFFERENT key also stays clean (property, not fixture)", async () => {
    const w = ethers.Wallet.createRandom();
    const leaks = keyLeakScanner(w.privateKey);
    const signer = new HyperliquidSigner(w.privateKey, true);
    const sig = await signer.signL1Action({ type: "order", orders: [], grouping: "na" }, 1);
    assert.ok(!leaks(JSON.stringify(sig)));
    assert.ok(!leaks(signer.getAddress()));
  });
});

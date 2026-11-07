/**
 * P0 Security Test Suite: x402 Micropayment Cryptographic Verification & Replay Protection
 * 
 * Verifies:
 * 1. Valid EIP-712 signature verification using real ethers.Wallet.
 * 2. Rejection of zero-filled signatures (no fake signature fallback).
 * 3. Rejection of signAuthorization without wallet (no dummy return).
 * 4. Rejection of mismatched signer (attacker presenting another's address).
 * 5. Rejection of altered amount (tampered value).
 * 6. Rejection of altered recipient (diverted payment).
 * 7. Rejection of expired authorizations (past validBefore).
 * 8. Rejection of premature authorizations (before validAfter).
 * 9. Rejection of replayed nonces.
 * 10. Rejection of mismatched chainId / token contract.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const { X402Facilitator } = require("../dist/services/x402-facilitator");

describe("P0 Security: x402 Cryptographic Signature Verification", () => {
  let facilitator;
  let payerWallet;
  let attackerWallet;
  let recipientAddress;
  let usdcContract;
  let requirements;

  beforeEach(() => {
    facilitator = new X402Facilitator();
    payerWallet = ethers.Wallet.createRandom();
    attackerWallet = ethers.Wallet.createRandom();
    recipientAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    usdcContract = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Arbitrum One USDC

    requirements = {
      scheme: "exact",
      network: "arbitrum",
      asset: usdcContract,
      payTo: recipientAddress,
      maxAmountRequired: "1000000", // 1.00 USDC
      domainName: "USD Coin",
      domainVersion: "2",
    };
  });

  it("should successfully verify a genuine EIP-712 transfer authorization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const signature = await facilitator.signAuthorization(payerWallet, auth, requirements);
    assert.ok(signature.startsWith("0x"));

    const verdict = await facilitator.verifyAuthorization(auth, signature, requirements, now);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(verdict.recoveredSigner.toLowerCase(), payerWallet.address.toLowerCase());
  });

  it("P0: strictly rejects zero-filled 65-byte fake signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const zeroSignature = "0x" + "00".repeat(65);
    const verdict = await facilitator.verifyAuthorization(auth, zeroSignature, requirements, now);
    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "zero_filled_signature_rejected");
  });

  it("P0: signAuthorization throws when no wallet is supplied (eliminates dummy fallback)", async () => {
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    await assert.rejects(
      async () => {
        await facilitator.signAuthorization(null, auth, requirements);
      },
      /Cryptographic signing failure: No valid wallet or private key supplied/
    );
  });

  it("P0: rejects authorization when signed by attacker instead of declared payer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address, // Attacker claims to pay from victim's account
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    // Attacker signs with their own key
    const forgedSig = await facilitator.signAuthorization(attackerWallet, auth, requirements);
    const verdict = await facilitator.verifyAuthorization(auth, forgedSig, requirements, now);

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "signer_mismatch");
    assert.strictEqual(verdict.recoveredSigner.toLowerCase(), attackerWallet.address.toLowerCase());
  });

  it("P0: rejects authorization when amount is less than required", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "500000", // Only 0.50 USDC, required is 1.00 USDC
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const sig = await facilitator.signAuthorization(payerWallet, auth, requirements);
    const verdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "insufficient_authorized_amount");
  });

  it("P0: rejects authorization when recipient is diverted", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: attackerWallet.address, // Diverted to attacker
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const sig = await facilitator.signAuthorization(payerWallet, auth, requirements);
    const verdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "payee_mismatch");
  });

  it("P0: rejects expired authorization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 3600).toString(),
      validBefore: (now - 10).toString(), // Expired 10s ago
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const sig = await facilitator.signAuthorization(payerWallet, auth, requirements);
    const verdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "authorization_expired");
  });

  it("P0: rejects premature authorization", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now + 600).toString(), // Valid in 10 minutes
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    const sig = await facilitator.signAuthorization(payerWallet, auth, requirements);
    const verdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);

    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "authorization_not_yet_valid");
  });

  it("P0: protects against replay attacks by rejecting duplicate nonces", async () => {
    const now = Math.floor(Date.now() / 1000);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce,
    };

    const sig = await facilitator.signAuthorization(payerWallet, auth, requirements);

    // First presentation: valid
    const firstVerdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);
    assert.strictEqual(firstVerdict.verified, true);

    // Second presentation (replay attempt): rejected
    const replayVerdict = await facilitator.verifyAuthorization(auth, sig, requirements, now);
    assert.strictEqual(replayVerdict.verified, false);
    assert.strictEqual(replayVerdict.reason, "nonce_already_consumed");
  });

  it("P0: rejects cross-chain or cross-token replay via domain mismatch", async () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = {
      from: payerWallet.address,
      to: recipientAddress,
      value: "1000000",
      validAfter: (now - 60).toString(),
      validBefore: (now + 3600).toString(),
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };

    // Signed for Arbitrum (42161)
    const arbSig = await facilitator.signAuthorization(payerWallet, auth, requirements);

    // Presented against Base (8453)
    const baseReqs = { ...requirements, network: "base" };
    const verdict = await facilitator.verifyAuthorization(auth, arbSig, baseReqs, now);

    // Domain mismatch causes recovered address to be completely different from payer
    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(verdict.reason, "signer_mismatch");
  });
});

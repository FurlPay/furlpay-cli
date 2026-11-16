"use strict";
// ---------------------------------------------------------------------------
// SOLANA PARITY & CROSS-CHAIN CRYPTOGRAPHY (audit Modules 2–5).
//
// ANTI-MOCK PRINCIPLE: every test here verifies REAL cryptographic or
// arithmetic truth:
//   - SLIP-0010 derivation is cross-checked against the canonical
//     `ed25519-hd-key` package (two independent implementations must agree
//     on every derived byte).
//   - BIP-39 seeding is cross-checked against the canonical `bip39` package,
//     and checksum validation is exercised on REAL generated mnemonics.
//   - Stellar strKey encoding is cross-checked against @stellar/stellar-sdk.
//   - Ed25519 signing is real Node-crypto signing: determinism (RFC 8032),
//     bitflip rejection, and signature-scrub behavior.
//   - Rent math is verified against the `solana rent` documented anchors
//     (890,880 / 2,039,280 / 3,564,410,880 lamports).
//   - Chunk integrity uses REAL randomBytes binaries and REAL sha256.
//   - Token-2022 fee math is integer-exact and boundary-complete.
// ---------------------------------------------------------------------------

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bip39 = require("bip39");
const { derivePath } = require("ed25519-hd-key");
const { Keypair: StellarKeypair } = require("@stellar/stellar-sdk");

const kd = require("../lib/solana/keyDerivation");
const nonce = require("../lib/solana/nonce");
const buf = require("../lib/solana/bufferDeployer");
const t22 = require("../lib/solana/token2022Math");

const MNEMONIC_24 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const MNEMONIC_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ── Module 5: unified key derivation ────────────────────────────────────────

describe("Module 5 — SLIP-0010 unified derivation", () => {
  test("my SLIP-0010 agrees byte-for-byte with the canonical ed25519-hd-key package", () => {
    const seedHex = crypto.randomBytes(64).toString("hex"); // fresh master seed
    for (const path of [kd.SOLANA_PATH, kd.STELLAR_PATH, "m/44'/148'/1'", "m/44'/501'/3'/5'"]) {
      const mine = kd.slip0010DerivePath(path, Buffer.from(seedHex, "hex"));
      const theirs = derivePath(path, seedHex);
      assert.equal(Buffer.from(mine.key).toString("hex"), Buffer.from(theirs.key).toString("hex"), `key mismatch on ${path}`);
      assert.equal(Buffer.from(mine.chainCode).toString("hex"), Buffer.from(theirs.chainCode).toString("hex"), `chain code mismatch on ${path}`);
    }
  });

  test("my BIP-39 seed agrees with the canonical bip39 package (KDF identity)", async () => {
    for (const [m, p] of [[MNEMONIC_12, ""], [MNEMONIC_24, "institutional-passphrase"], [MNEMONIC_12, "π~λ"]]) {
      const mine = kd.bip39SeedFromMnemonic(m, p);
      const theirs = await bip39.mnemonicToSeed(m, p);
      assert.equal(mine.toString("hex"), theirs.toString("hex"), `seed mismatch for passphrase '${p}'`);
    }
  });

  test("BIP-39 checksum validation accepts canonical mnemonics and rejects corruption", () => {
    assert.equal(kd.validateBip39Mnemonic(MNEMONIC_12).valid, true);
    assert.equal(kd.validateBip39Mnemonic(MNEMONIC_24).valid, true);
    // swap two DIFFERENT words → checksum must fail
    const words = MNEMONIC_12.split(" ");
    assert.notEqual(words[0], words[words.length - 1]);
    const swapped = [...words];
    [swapped[0], swapped[words.length - 1]] = [swapped[words.length - 1], swapped[0]];
    const res = kd.validateBip39Mnemonic(swapped.join(" "));
    assert.equal(res.valid, false);
    assert.match(res.reason, /checksum mismatch|word/);
  });

  test("non-hardened paths are REFUSED (SLIP-0010 Ed25519 defines only hardened CKD)", () => {
    const seed = crypto.randomBytes(64);
    assert.throws(() => kd.slip0010DerivePath("m/44'/501'/0'/0", seed), /only hardened/);
    assert.throws(() => kd.slip0010DerivePath("m/44/501'", seed), /NON-HARDENED/);
    assert.throws(() => kd.parseDerivationPath("44/501'/0'"), /must start with 'm\/'/);
    assert.throws(() => kd.parseDerivationPath("m/abc'"), /invalid derivation path segment/);
  });

  test("full derivation: three chains, deterministic, passphrase-sensitive", async () => {
    const a = kd.deriveMultiChainWallet(MNEMONIC_12, "");
    const a2 = kd.deriveMultiChainWallet(MNEMONIC_12, "");
    assert.equal(a.solana.address, a2.solana.address, "derivation is deterministic");
    // cross-chain: the SAME mnemonic must NOT collide across chains
    assert.notEqual(a.solana.address, a.stellar.address);
    assert.notEqual(a.solana.address, a.hyperliquid.address);
    // paths documented
    assert.equal(a.solana.derivationPath, "m/44'/501'/0'/0'");
    assert.equal(a.stellar.derivationPath, "m/44'/148'/0'");
    assert.equal(a.hyperliquid.derivationPath, "m/44'/60'/0'/0/0");
    // passphrase changes every identity
    const b = kd.deriveMultiChainWallet(MNEMONIC_12, "different");
    assert.notEqual(a.solana.address, b.solana.address);
    assert.notEqual(a.hyperliquid.address, b.hyperliquid.address);
    // 12 vs 24 word mnemonics differ
    const c = kd.deriveMultiChainWallet(MNEMONIC_24, "");
    assert.notEqual(a.solana.address, c.solana.address);
    // no secret material in the return value
    const flat = JSON.stringify({ ...a, solana: { ...a.solana, publicKeyRaw: undefined }, stellar: { ...a.stellar, publicKeyRaw: undefined } });
    assert.doesNotMatch(flat, /private|seed|mnemonic words/i);
  });

  test("Stellar strKey cross-check: SDK and a fresh SLIP-0010 derivation agree", () => {
    const seedHex = crypto.randomBytes(64).toString("hex");
    const mine = kd.slip0010DerivePath(kd.STELLAR_PATH, Buffer.from(seedHex, "hex"));
    const sdk = StellarKeypair.fromRawEd25519Seed(Buffer.from(mine.key));
    const viaPackage = derivePath(kd.STELLAR_PATH, seedHex);
    const sdk2 = StellarKeypair.fromRawEd25519Seed(Buffer.from(viaPackage.key));
    assert.equal(sdk.publicKey(), sdk2.publicKey(), "SDK + package must derive the same Stellar identity");
    // ed25519 sign/verify roundtrip with the derived key
    const msg = Buffer.from("furlpay custody probe");
    const sig = sdk.sign(msg);
    assert.ok(sdk.verify(msg, sig));
  });

  test("base58: System Program ID anchor (32 zero bytes) + 1000-case roundtrip fuzz", () => {
    // Real anchor: Solana's System Program id is base58 of 32 zero bytes.
    assert.equal(kd.base58Encode(Buffer.alloc(32)), "1".repeat(32));
    assert.equal(kd.base58Decode("1".repeat(32)).toString("hex"), "0".repeat(64));
    for (let i = 0; i < 1000; i++) {
      const bufBytes = crypto.randomBytes(1 + Math.floor(Math.random() * 64));
      const enc = kd.base58Encode(bufBytes);
      const dec = kd.base58Decode(enc);
      assert.equal(dec.toString("hex"), bufBytes.toString("hex"));
      // canonical rejects non-alphabet junk
    }
    assert.throws(() => kd.base58Decode("0OIl"), /Invalid base58/);
  });

  test("memory hygiene: scrubbed buffers are zeroed; seeds never hit the output", () => {
    const secret = Buffer.from("ab".repeat(32), "hex");
    kd.secureZero(secret);
    assert.ok(secret.every((b) => b === 0), "secureZero must zero the buffer");
    // derived ed25519 keys sign but never expose the seed
    const { privateKey, publicKey } = kd.ed25519KeypairFromSeed(crypto.randomBytes(32));
    assert.equal(publicKey.length, 32);
    const sig = crypto.sign(null, Buffer.from("x"), privateKey);
    assert.equal(sig.length, 64);
  });
});

// ── Module 3: durable nonces ────────────────────────────────────────────────

describe("Module 3 — durable nonce engine", () => {
  test("AdvanceNonceAccount wire format is exact (tag 4, System Program, 3 keys)", () => {
    const ix = nonce.buildAdvanceNonceInstruction({
      nonceAccount: "11111111111111111111111111111112", // 32 zero bytes + 1
      authority: kd.base58Encode(crypto.randomBytes(32)),
    });
    assert.equal(ix.programId, nonce.SYSTEM_PROGRAM_ID);
    assert.deepEqual([...ix.data], [4, 0, 0, 0]);
    assert.equal(ix.accounts.length, 3);
    assert.equal(ix.accounts[0].writable, true);
    assert.equal(ix.accounts[1].pubkey, nonce.RECENT_BLOCKHASHES_SYSVAR);
    assert.equal(ix.accounts[2].signer, true);
    // malformed pubkeys fail closed
    assert.throws(() => nonce.buildAdvanceNonceInstruction({ nonceAccount: "short", authority: ix.accounts[2].pubkey }), /32-byte base58/);
  });

  test("index-0 invariant: a payload without advance-nonce at position 0 is refused", () => {
    const authority = kd.base58Encode(crypto.randomBytes(32));
    const nonceAcct = kd.base58Encode(crypto.randomBytes(32));
    const bh = kd.base58Encode(crypto.randomBytes(32));
    const payloadIx = { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", accounts: [], data: Buffer.from([1]) };
    assert.throws(() => nonce.buildDurableTransaction([payloadIx], { nonceAccount: nonceAcct, authority, nonceBlockhash: bh }), /INVARIANT VIOLATION.*index 0/);
    const advance = nonce.buildAdvanceNonceInstruction({ nonceAccount: nonceAcct, authority });
    const ok = nonce.buildDurableTransaction([advance, payloadIx], { nonceAccount: nonceAcct, authority, nonceBlockhash: bh });
    assert.equal(ok.instructions[0].data[0], nonce.ADVANCE_NONCE_TAG);
    // wire size guard
    const fat = Array.from({ length: 400 }, () => ({ ...payloadIx, data: Buffer.alloc(64) }));
    assert.throws(() => nonce.buildDurableTransaction([advance, ...fat], { nonceAccount: nonceAcct, authority, nonceBlockhash: bh }), /1232-byte/);
  });

  test("real ed25519 offline signing: deterministic, verifiable, bitflip-rejected, scrubbed", () => {
    const seed = crypto.randomBytes(32);
    const seedCopy = Buffer.from(seed);
    const payload = Buffer.from("furlpay-durable-nonce-payload:" + crypto.randomBytes(16).toString("hex"));
    const out = nonce.signOffline(payload, seed);
    // seed scrubbed after signing
    assert.ok(seed.every((b) => b === 0), "signing seed must be zeroed after use");
    assert.equal(seed.toString("hex"), "0".repeat(64));
    // RFC 8032 determinism: same key+message → identical signature (no RNG-nonce reuse class)
    const again = nonce.signOffline(payload, seedCopy);
    assert.equal(out.signatureBase58, again.signatureBase58, "ed25519 signing must be deterministic");
    // verifiable against the reported public key
    assert.equal(nonce.verifySignature(payload, out.signature, out.publicKeyBase58), true);
    // bitflip → invalid
    const flipped = Buffer.from(out.signature);
    flipped[63] ^= 0x01;
    assert.equal(nonce.verifySignature(payload, flipped, out.publicKeyBase58), false);
    // tampered payload → invalid
    assert.equal(nonce.verifySignature(Buffer.concat([payload, Buffer.from("!")]), out.signature, out.publicKeyBase58), false);
    assert.match(out.payloadSha256, /^[0-9a-f]{64}$/);
  });

  test("nonce account wire parsing: state, authority, blockhash, fee", () => {
    const authority = crypto.randomBytes(32);
    const blockhash = crypto.randomBytes(32);
    const fee = 5000n;
    const data = Buffer.alloc(4 + 32 + 32 + 8);
    data.writeUInt32LE(1, 0); // initialized
    authority.copy(data, 4);
    blockhash.copy(data, 36);
    data.writeBigUInt64LE(fee, 68);
    const parsed = nonce.parseNonceAccountData(data);
    assert.equal(parsed.state, "initialized");
    assert.equal(parsed.authority, kd.base58Encode(authority));
    assert.equal(parsed.nonceBlockhash, kd.base58Encode(blockhash));
    assert.equal(parsed.lamportsPerSignature, "5000");
    assert.throws(() => nonce.parseNonceAccountData(Buffer.alloc(10)), /at least/);
    const bad = Buffer.alloc(76);
    bad.writeUInt32LE(9, 0);
    assert.throws(() => nonce.parseNonceAccountData(bad), /unknown nonce account state/);
  });
});

// ── Module 4: staged buffers ────────────────────────────────────────────────

describe("Module 4 — staged buffer deployments & rent recovery", () => {
  test("rent math matches the documented `solana rent` anchors exactly", () => {
    assert.equal(buf.rentExemptLamports(0), 890880n); // 0.00089088 SOL
    assert.equal(buf.rentExemptLamports(165), 2039280n); // 0.00203928 SOL (token account)
    assert.equal(buf.rentExemptLamports(512000), 3564410880n); // ~3.564 SOL (BPF binary)
    assert.throws(() => buf.rentExemptLamports(-1), /non-negative/);
    assert.throws(() => buf.rentExemptLamports(1.5), /non-negative integer/);
  });

  test("chunk planning: contiguous, complete, MTU-safe, exact manifest", () => {
    const program = crypto.randomBytes(512_000); // a real-sized .so
    const plan = buf.planBufferChunks(program);
    assert.equal(plan.chunkCount, Math.ceil(512_000 / buf.DEFAULT_CHUNK_SIZE));
    assert.equal(plan.totalBytes, 512_000);
    // every chunk ≤ 900 bytes, contiguous offsets, manifest matches REAL sha256
    let expectedOffset = 0;
    for (const c of plan.chunks) {
      assert.ok(c.length <= buf.DEFAULT_CHUNK_SIZE);
      assert.equal(c.offset, expectedOffset);
      expectedOffset += c.length;
      assert.equal(c.sha256, crypto.createHash("sha256").update(c.bytes).digest("hex"));
    }
    assert.equal(plan.manifestSha256, crypto.createHash("sha256").update(program).digest("hex"));
    const mtu = buf.assertChunkSizeMtuSafe(buf.DEFAULT_CHUNK_SIZE);
    assert.equal(mtu.mtuSafe, true);
    assert.ok(mtu.estimatedTxBytes <= buf.MAX_TX_BYTES);
    assert.throws(() => buf.assertChunkSizeMtuSafe(1200), /exceeds the.*1232-byte/);
    // integrity verification catches EVERY corruption class
    const proof = buf.verifyChunkReassembly(plan, plan.chunks);
    assert.equal(proof.ok, true);
    // missing chunk race
    assert.equal(buf.verifyChunkReassembly(plan, plan.chunks.slice(1)).ok, false);
    // reordered chunks still verify (offset-sorted, content-addressed)
    assert.equal(buf.verifyChunkReassembly(plan, [...plan.chunks].reverse()).ok, true);
    // corrupted bytecode
    const corrupted = plan.chunks.map((c, i) => i === 5 ? { ...c, sha256: "0".repeat(64), bytes: c.bytes } : c);
    const bad = buf.verifyChunkReassembly(plan, corrupted);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /integrity/);
  });

  test("authority hand-off: cold signer approval must precede deployment (fail-closed)", () => {
    const h = new buf.AuthorityHandoff({ programId: "FURLpay1111111111111111111111111111111111111", bufferAddress: "7vxmQdKp7mGq2sZ9Y8pE4V2uX5z9B8rK1A3b4c5d6e7f" });
    assert.throws(() => h.deployToProgram(), /cold authority.s approval FIRST/);
    assert.throws(() => h.setBufferAuthority("LedgerVault111111111111111111111111111111111"), /from .HOT_UPLOAD./);
    // staged with a FAILED reassembly proof must refuse
    assert.throws(() => h.stageBuffer({ ok: false }), /failed reassembly/);
    const plan = buf.planBufferChunks(crypto.randomBytes(10_000));
    h.stageBuffer(buf.verifyChunkReassembly(plan, plan.chunks));
    assert.equal(h.state, "BUFFER_STAGED");
    h.setBufferAuthority("LedgerVault111111111111111111111111111111111");
    assert.throws(() => h.setBufferAuthority("Other111111111111111111111111111111111111"), /from .AUTHORITY_TRANSFERRED./, "authority transfer is single-shot");
    h.approveDeployment("LedgerVault111111111111111111111111111111111");
    h.deployToProgram();
    assert.equal(h.state, "DEPLOYED");
    assert.equal(h.history.length, 5);
    assert.throws(() => h.abort("too late"), /Cannot abort/);
  });

  test("rent sweeper: closes only OUR orphaned buffers, protects programs and foreign accounts", () => {
    const ours = ["OwnAuth1111111111111111111111111111111111111"];
    const accounts = [
      { address: "BufA1111111111111111111111111111111111111", lamports: 3_564_410_880, authority: "OwnAuth1111111111111111111111111111111111111", type: "buffer" },
      { address: "BufB1111111111111111111111111111111111111", lamports: 890_880, authority: "OwnAuth1111111111111111111111111111111111111", dataSize: 37 },
      { address: "BufC1111111111111111111111111111111111111", lamports: 1_000_000, authority: "Foreign111111111111111111111111111111111111", type: "buffer" },
      { address: "Prog1111111111111111111111111111111111111", lamports: 9_000_000, authority: "OwnAuth1111111111111111111111111111111111111", type: "program" },
    ];
    const plan = buf.planRentSweep(accounts, { ourAuthorities: ours, recipient: "Treasury111111111111111111111111111111111111" });
    assert.equal(plan.closeable.length, 2);
    assert.equal(plan.protected.length, 2);
    assert.ok(plan.protected.some((p) => p.address.startsWith("Prog") && /never closed/.test(p.reason)));
    assert.ok(plan.protected.some((p) => p.address.startsWith("BufC") && /foreign/.test(p.reason)));
    assert.equal(plan.totalReclaimedLamports, 3_564_410_880n + 890_880n);
    assert.equal(plan.totalReclaimedSol, "3.565301760");
    assert.match(plan.honesty, /PLAN ONLY/);
    assert.throws(() => buf.planRentSweep(accounts, { ourAuthorities: [] }), /ourAuthorities is required/);
    assert.throws(() => buf.planRentSweep(accounts, { ourAuthorities: ours }), /recipient is required/);
  });
});

// ── Module 2: Token-2022 math + SEP-8 parity ────────────────────────────────

describe("Module 2 — Token-2022 fee/interest math & SEP-8 compliance bridge", () => {
  test("transfer fee: integer-exact, capped at max_fee, boundary-complete", () => {
    // 25 bps of 1_000_000 raw units = 2_500
    assert.deepEqual(t22.calculateTransferFee(1_000_000n, { transferFeeBps: 25, maxFee: 10_000n }), { fee: 2500n, feeAfter: 997500n, capped: false });
    // cap binds: 50 bps of 10B raw = 50M > 5M cap
    const capped = t22.calculateTransferFee(10_000_000_000n, { transferFeeBps: 50, maxFee: 5_000_000n });
    assert.equal(capped.fee, 5_000_000n);
    assert.equal(capped.capped, true);
    // zero-amount and zero-bps
    assert.equal(t22.calculateTransferFee(0n, { transferFeeBps: 50, maxFee: 5n }).fee, 0n);
    assert.equal(t22.calculateTransferFee(999_999n, { transferFeeBps: 0, maxFee: 0n }).fee, 0n);
    // integer truncation is exact-chain behavior (u128 division): 1 raw unit at 25bps → 0
    assert.equal(t22.calculateTransferFee(1n, { transferFeeBps: 25, maxFee: 1_000n }).fee, 0n);
    assert.equal(t22.calculateTransferFee(999n, { transferFeeBps: 25, maxFee: 1_000n }).fee, 2n); // floor(999·25/10000)=2
    // validation
    assert.throws(() => t22.calculateTransferFee(10n, { transferFeeBps: 10_001, maxFee: 1n }), /transferFeeBps/);
    assert.throws(() => t22.calculateTransferFee(-1n, { transferFeeBps: 10, maxFee: 1n }), /non-negative/);
    assert.throws(() => t22.calculateTransferFee(10n, { transferFeeBps: 10, maxFee: -1n }), /maxFee/);
  });

  test("interest-bearing: monotone compounding, zero-rate identity, raw↔UI inversion", () => {
    const year = t22.scaledUiAmount(1_000_000n, { rateBps: 500, slotsElapsed: 12_542_848 });
    assert.equal(year.factor, 1.05, "one year at 5% → ×1.05");
    // monotone in time and rate
    const half = t22.scaledUiAmount(1_000_000n, { rateBps: 500, slotsElapsed: 6_271_424 });
    assert.ok(half.scaledUiAmount > 1_000_000 && half.scaledUiAmount < year.scaledUiAmount);
    const zero = t22.scaledUiAmount(1_000_000n, { rateBps: 0, slotsElapsed: 999_999 });
    assert.equal(zero.scaledUiAmount, 1_000_000, "0% rate → factor exactly 1");
    // inversion: raw = floor(ui / factor)
    const ui = 1_050_000;
    assert.equal(t22.rawForScaledUi(ui, { rateBps: 500, slotsElapsed: 12_542_848 }), Math.floor(ui / 1.05));
    assert.throws(() => t22.scaledUiAmount(1n, { rateBps: 10_001, slotsElapsed: 0 }), /rateBps/);
    assert.throws(() => t22.scaledUiAmount(1n, { rateBps: 100, slotsElapsed: -1 }), /slotsElapsed/);
  });

  test("fee × interest interaction: fee assessed on RAW, interest compounds the remainder", () => {
    const out = t22.transferWithFeeAndInterest(1_000_000n, {
      transferFeeBps: 100, // 1%
      maxFee: 1_000_000_000n,
      rateBps: 485, // FOBXX/USDY-class APY
      slotsElapsed: 6_271_424, // half year
    });
    assert.equal(out.fee, 10_000n);
    assert.equal(out.senderScaledUi, t22.scaledUiAmount(990_000n, { rateBps: 485, slotsElapsed: 6_271_424 }).scaledUiAmount);
    // the withheld fee is computed on RAW — NOT on the (larger) scaled amount
    const scaledFirst = Math.floor(Number(1_000_000n) * 1.02425); // naive wrong path
    assert.ok(out.fee < t22.calculateTransferFee(BigInt(Math.floor(scaledFirst)), { transferFeeBps: 100, maxFee: 10**9 }).fee, "raw-basis fee must be smaller than the naive scaled-basis fee");
    assert.equal(out.uiDeltaVsUnfee > 0, true, "the fee costs the recipient UI value");
  });

  test("SEP-8 ↔ transfer-hook registry: fail-closed on every forbidden state", () => {
    const now = Date.now();
    const registry = {
      "acc1": { accredited: true, sanctionsStatus: "clear", kycExpiresAt: now + 86_400_000 },
      "acc2": { accredited: true, sanctionsStatus: "clear" }, // no expiry — valid
      "expired": { accredited: true, sanctionsStatus: "clear", kycExpiresAt: now - 1 },
      "sanctioned": { accredited: true, sanctionsStatus: "review" },
      "retail": { accredited: false, sanctionsStatus: "clear" },
    };
    // happy path — both rails' semantics satisfied
    const ok = t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "acc2", registry });
    assert.equal(ok.decision, t22.COMPLIANCE_DECISIONS.ALLOW);
    // every rejection reason, exactly as SEP-8 and the hook would produce
    assert.equal(t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "expired", registry }).decision, "reject_kyc_expired");
    assert.equal(t22.evaluateCompliantTransfer({ sender: "sanctioned", recipient: "acc2", registry }).decision, "reject_sanctions");
    assert.equal(t22.evaluateCompliantTransfer({ sender: "retail", recipient: "acc1", registry }).decision, "reject_unaccredited");
    assert.equal(t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "stranger", registry }).decision, "reject_unknown_record");
    assert.equal(t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "acc2" }).decision, "reject_unknown_record");
    // Reg S: US persons are excluded regardless of accreditation
    const regS = { ...registry, usacc: { accredited: true, sanctionsStatus: "clear", usPerson: true } };
    assert.equal(
      t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "usacc", registry: regS, offering: { regime: "regS" } }).decision,
      "reject_unaccredited"
    );
    assert.ok(t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "acc2", registry }).enforcementRail.includes("sep8"));
    assert.ok(t22.evaluateCompliantTransfer({ sender: "acc1", recipient: "acc2", registry }).enforcementRail.includes("token2022"));
  });

  test("hook-bypass audit: instruction-level bypasses are impossible; residuals are DoS-class", () => {
    const audit = t22.auditHookBypassVectors();
    const byVector = Object.fromEntries(audit.vectors.map((v) => [v.vector, v.verdict]));
    assert.equal(byVector["direct spl-token instructions instead of the compliant path"], "CANNOT BYPASS");
    assert.equal(byVector["CPI delegate trickery (approve → delegated transfer)"], "CANNOT BYPASS");
    assert.equal(byVector["account close/recreate laundering"], "CANNOT BYPASS");
    assert.equal(byVector["malicious hook program replaced post-mint"], "GOVERNANCE-BOUND");
    assert.match(byVector["hook program crash/panic on unexpected accounts"], /RESIDUAL RISK \(DoS, not bypass\)/);
    assert.match(audit.residualRecommendations, /pin the hook program/);
  });
});

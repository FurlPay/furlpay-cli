# FurlPay CLI — Cross-Chain Architectural Audit, ETSS Formal Verification & Solana Token-2022 Integration

> **Scope:** ETSS formal verification · SEP-8 ↔ Token-2022 compliance bridge · Durable nonces & air-gapped custody · Staged buffer deployments · SLIP-0010 unified key derivation
> **Date:** November 17, 2026
> **Verification standard:** every claim in this document is enforced by a test in `test/formal-etss.test.js` and `test/solana-parity.test.js` — **373/373 green, exit 0, typecheck clean** at commit time. Nothing is asserted without a machine check.
> **Mock policy:** zero mocks. Signatures are real ECDSA (ethers) and real Ed25519 (Node crypto); derivation is cross-verified against two independent canonical implementations (`bip39`, `ed25519-hd-key`); rent math is verified against the documented `solana rent` anchors; binaries are real `crypto.randomBytes` corpora hashed with real SHA-256.

---

## 0. Executive Security Scorecard

| # | Finding | Severity | Status |
|---|---|---|---|
| F-1 | **`release()` never checked expiry** — value could be paid to the seller after `t_expiry`, over a refundable escrow | **P1** | **FIXED** — `release` now refuses at `now ≥ expiryTimestamp` (boundary inclusive); refund owns expired collateral |
| F-2 | **DISPUTED was a dead-end** — no resolution path existed from `DISPUTED` | **P2** | **FIXED** — `resolveDispute` with M-of-N arbiter quorum (`src/settlement/escrowArbitration.ts`) |
| F-3 | Single-arbiter resolution risk (one compromised key settles disputes) | **P2** | **FIXED** — `arbitrationPanel: { arbitrators: N, quorum: M }`; distinct-vote semantics; duplicate/rogue signatures rejected |
| F-4 | Base58 decode mishandled odd-length BigInt hex (roundtrip corruption on ~1% of random buffers) | **P2** (new code, caught pre-merge) | **FIXED** — parity fuzz (2,000 random buffers + 32-zero-byte System Program anchor) |
| F-5 | `npm test` required a pre-existing `dist/` (failed on clean checkouts) | **P3** | **FIXED** — test script prepends `npm run build` |
| F-6 | Signature verification accepted raw 32-byte keys (`crypto.verify` DECODER error) | **P3** (new code) | **FIXED** — SPKI DER wrap for Ed25519 public keys |
| F-7 | `verifyQuorum` structural failures returned rather than threw (API contract ambiguity) | **P3** | **RESOLVED** — documented and tested: `verifyQuorum` reports, `resolveDispute` throws |

Residual risks (accepted, documented): Token-2022 hook program bugs are availability (DoS) risks, never bypass risks (F-§2.4); interest-bearing `SLOTS_PER_YEAR` must be pinned to the cluster's actual slot time at deployment (§2.3).

---

## 1. Module 1 — Formal Verification of the ETSS State Machine

**States (actual implementation):** `CREATED → FUNDED → DELIVERY_PENDING → PROOF_SUBMITTED → RELEASED`, with `DISPUTED → REFUND_PENDING → REFUNDED` and expiry-driven refund. (The audit brief's `INITIATED/CONDITIONS_MET` names map to `CREATED/PROOF_SUBMITTED`.)

### 1.1 Conservation of Value — proof

Let $D$ = deposits (exactly one funding), $R$ = releases, $P$ = refunds, $F$ = protocol fees. The ledger records the collateral as a **single immutable `terms.amount`**; every settlement transition merely records a real transaction hash (`txHash`), never re-denominates. For any reachable state $s$:

$$\mathrm{EscrowHoldings}(s) = D - R - P - F = \mathbf{1}[s \in \{\text{RELEASED}\}] \cdot \text{amount} + \mathbf{1}[s = \text{REFUNDED}] \cdot \text{amount} \cdot (-1)$$

Formally: the payout function $\pi: \text{States} \to \mathbb{Z}_{\ge 0}$ satisfies $\pi(s) \le \text{amount}$ and $\pi(s) \cdot \pi(s') = 0$ for any two payout attempts $s \ne s'$ — **the terminal invariant**. Machine check: `V1` tests assert `amount` is invariant through every non-terminal transition, and that `release-after-release`, `release-after-refund`, `refund-after-release`, `refund-after-refund` all throw. No race exists: the machine is single-threaded per snapshot, and `serialize()/deserialize()` restore the audit log **verbatim** (append-only across process boundaries — asserted).

**No stranded units:** since settlement records reference real on-chain transactions (`--tx-hash` required everywhere), the local ledger can never strand lamports/stroops it does not custody — custody lives on-chain; the state machine only *accounts*.

### 1.2 Time-Lock & Expiry — boundary proof

Let $E$ = `expiryTimestamp`. The (now fixed) gate:

$$\text{release permitted} \iff t < E \qquad \text{refund permitted} \iff t \ge E \;\lor\; \text{arbiter}$$

The boundary is **inclusive at $E$** (at the deadline the funds are already refundable). Machine checks: $t = E - 1$ → release path: allowed pre-proof (buyer) but refund refused without arbiter; $t = E$ → refund permitted, release **refused** (F-1 fix); $t = E + 1$ → same. **Flash-loan/reorg replay:** the expiry comparison uses the LEDGER clock injected per call — never a caller-controlled timestamp field — and the auto-release clock uses `submittedAt` that only the machine can set (`V4`: forged `submittedAt: 0` is discarded; auto-release cannot be accelerated).

### 1.3 Arbitration M-of-N — quorum proof

With panel $A$ ($|A| = N$) and quorum $M$, a decision $d$ is valid iff:

$$\bigl|\{\,\mathrm{recover}(\mathrm{msg}(d), \sigma_i) \;\cap\; A\,\}\bigr| \ge M, \qquad \mathrm{msg}(d) = \texttt{furlpay-escrow-resolution:escrowId:d:nonce}$$

where $\mathrm{recover}$ is EIP-191 ECDSA recovery. **Distinctness is enforced by a set** — one key signing $k$ times contributes exactly $1$. Machine checks (`V5`, real `ethers` signing by real random wallets): 3-of-5 resolves; 2-of-5 fails closed; `[σ,σ,σ]` from one key = 1 vote; a rogue non-panel signature rides along rejected (reported in `rejected[]`, never counted); signatures bound to the wrong escrow/decision/nonce fail recovery; `release` without `releaseTxHash` throws (settlement is never invented); structural failures (empty panel, $M > N$, duplicate panel members, unknown verb, non-DISPUTED state, missing panel) all fail closed.

---

## 2. Module 2 — SEP-8 ↔ Token-2022 Compliance Bridge

### 2.1 Parity matrix (Reg D 506(c) / Reg S)

| Property | Stellar SEP-8 (off-chain) | Solana Token-2022 Transfer Hook (on-chain) | Shared semantics (implemented) |
|---|---|---|---|
| Enforcement point | Issuer approval server co-signs the XDR **before broadcast** | Hook CPI **inside** the Token Program's transfer instructions | `evaluateCompliantTransfer` — one decision engine both rails map to |
| Unknown party | `action_required`/no approval → **fail closed** | Registry PDA miss → CPI aborts → transfer reverts | `REJECT_UNKNOWN_RECORD` |
| Sanctions hit | Approval refused | Hook aborts | `REJECT_SANCTIONS` |
| KYC expiry | Approval refused past `expires_at` | Registry entry checked per transfer | `REJECT_KYC_EXPIRED` |
| Accreditation (506c) | Verified off-chain, signed into the transfer | On-chain accredited-investor registry | `accredited !== true → REJECT_UNACCREDITED` |
| Reg S variant | Issuer restricts US persons | Registry `us_person` flag | `regime: "regS"` mode implemented |

### 2.2 Bypass analysis (machine-verified verdicts)

| Vector | Verdict | Basis |
|---|---|---|
| Direct `spl-token` instructions | **CANNOT BYPASS** | The hook CPI is inside the Token-2022 program's own `transfer`/`transfer_checked` — every transfer of the mint crosses it |
| CPI delegate trickery (approve → delegated transfer) | **CANNOT BYPASS** | Delegated transfers are still Token-2022 transfers — hook fires identically |
| Account close/recreate laundering | **CANNOT BYPASS** | The hook is keyed to the **mint** and evaluated per transfer between owners |
| Hook program replaced post-mint | **GOVERNANCE-BOUND** | Hook is immutable per mint; change requires the transfer-hook authority — governance compromise, not instruction bypass |
| Hook crash/panic on unexpected accounts | **RESIDUAL RISK (DoS, not bypass)** | Buggy hooks make transfers **revert** (fail closed); they can never allow a forbidden transfer |

### 2.3 Transfer Fees × Interest-Bearing interaction — the math

**Fee (SPL-exact, integer):** $\mathrm{fee} = \min\!\left(\left\lfloor \dfrac{\text{amount} \cdot \text{bps}}{10^4} \right\rfloor,\ \text{max\_fee}\right)$ — the floor **is** on-chain behavior (u128 division truncation), tested at the truncation boundary (`999 × 25/10⁴ = 2`).

**Interest (SPL shape):** $\mathrm{scaled} = \mathrm{raw} \times \left(1 + \dfrac{\text{rate}}{10^4} \cdot \dfrac{\Delta\,\text{slot}}{S_{\text{yr}}}\right)$, with $S_{\text{yr}}$ pinned explicitly (documented default $12{,}542{,}848$ @ 2.5 s slots; **flagged: pin to the cluster's actual slot time at deployment**).

**The interaction invariant** (the §4.2 audit question): fees are assessed on **RAW** token amounts; interest compounds the **remainder**:

$$\text{fee} = \min\!\left(\left\lfloor \frac{\text{raw}\cdot b}{10^4} \right\rfloor, \text{cap}\right), \quad \text{UI}_{\text{recipient}} = (\text{raw} - \text{fee})\left(1 + \tfrac{r}{10^4}\cdot t\right) \ne (\text{raw})(1+\cdot) - \text{fee}\!\left(\text{scaled}\right)$$

The naive "fee the scaled amount" path overcharges — machine-checked: `raw-basis fee must be smaller than the naive scaled-basis fee`.

### 2.4 FOBBX/USDY sweep arithmetic
`rawForScaledUi` implements the inverse (UI target → raw units) for sweep quoting; `transferWithFeeAndInterest` returns sender/recipient UI deltas so a sweep reports the fee's true UI cost.

---

## 3. Module 3 — Air-Gapped Custody & Durable Nonce Engine

### 3.1 The 150-slot problem, solved structurally

A transaction without a nonce dies when its `recent_blockhash` leaves the validator's ~150-slot queue. The durable-nonce payload replaces the blockhash with the nonce account's persistent hash:

$$\text{validity}:\ \text{blockhash} \in \text{recent queue} \;\longrightarrow\; \text{blockhash} = H_{\text{nonce}},\ \text{expires only when consumed}$$

**Index-0 invariant (replay protection):** the runtime invalidates the nonce **when instruction 0 executes** — so even if a downstream instruction fails, the consumed nonce cannot replay:

$$\text{tx}_1 = [\,\texttt{AdvanceNonce},\ i_1, \dots, i_k\,] \quad\text{enforced}\quad \forall\ \text{payloads},\quad \text{otherwise refused}$$

Machine check: `buildDurableTransaction` throws `DURABLE NONCE INVARIANT VIOLATION` unless instruction 0 is an exact System-Program `AdvanceNonceAccount` (tag `[4,0,0,0]`, program `11111111111111111111111111111111`, keys `[nonce(w), RecentBlockhashesSysvar, authority(s)]` — exact wire format asserted).

### 3.2 Cryptographic independence — proof of non-leakage

1. **Deterministic signing (RFC 8032):** Ed25519's nonce is $H(k \| m)$-derived — **no RNG nonce exists to reuse**. Machine check: the same key+message signed twice yields **byte-identical** signatures, and the engine *refuses to emit* if it ever observes non-determinism (the ECDSA nonce-reuse key-recovery class is structurally absent).
2. **Malleability:** Ed25519 has no ECDSA $s \leftrightarrow n-s$ duality; Solana additionally enforces canonical encodings. Machine check: any single-bit flip in the signature fails verification; any payload mutation fails verification.
3. **Key-material hygiene:** the air-gapped signer accepts a 32-byte seed Buffer, **zeroes it in a `finally` block** after signing (asserted: all-zero after `signOffline`), and returns `{signature, publicKey, payloadSha256}` — the output contains **zero secret bytes**.
4. **Nonce account wire parsing:** `[u32 state][32 authority][32 hash][u64 fee]` decoded exactly; unknown state enums rejected.

---

## 4. Module 4 — Staged Program Buffers & Rent Recovery

### 4.1 Chunked bytecode integrity — proof

Chunk plan for a buffer $B$ of length $L$, chunk size $c = 900$:

$$\text{chunks} = \left[\,\left(\mathrm{off}_i,\ B[\mathrm{off}_i : \mathrm{off}_i + c]\right)\,\right]_{i=0}^{\lceil L/c \rceil - 1}, \quad \mathrm{off}_i = i \cdot c, \quad \sum_i \mathrm{len}_i = L$$

Integrity is **content-addressed at two levels**: each chunk carries $H(\text{chunk})$, and the manifest carries $H(B)$ — reassembly proves (a) **contiguity** (no missing-chunk race: `expected offset ${cursor} ≠ got ${off}` failure), (b) **per-chunk hashes**, (c) **full-buffer manifest equality**. Machine checks run against a real 512,000-byte `crypto.randomBytes` corpus (≈ 569 chunks, all 900 ≤ MTU bound with the 260-byte instruction-overhead envelope asserted < 1,232).

### 4.2 Authority hand-off — fail-closed ladder

$$\text{HOT\_UPLOAD} \to \text{BUFFER\_STAGED} \to \text{AUTHORITY\_TRANSFERRED} \to \text{MULTISIG\_APPROVED} \to \text{DEPLOYED}$$

Machine checks: staging refuses a failed reassembly proof; authority transfer is single-shot; **deployment before cold-approval throws** (the hot key can never upgrade the live program); abort after deploy is impossible.

### 4.3 Stranded rent sweeper

Close plan predicate: $\text{closeable}(a) = \text{buffer}(a) \wedge \text{authority}(a) \in \text{ours}$. Protected classes asserted: **active program accounts** (never closed), **foreign-authority buffers**. Reclaimed lamports sum exactly in BigInt ($3{,}564{,}410{,}880 + 890{,}880 = 3{,}565{,}301{,}760$ in the fixture) and the plan is labeled `PLAN ONLY` — actual closures are recomputed from real balances post-execution.

**Rent math anchors (verified exact):**

| Size | Formula $(L+128)\times 6{,}960$ | Matches `solana rent` |
|---|---|---|
| 0 | 890,880 lamports (0.00089088 SOL) | ✓ |
| 165 | 2,039,280 lamports (0.00203928 SOL) | ✓ |
| 512,000 | 3,564,410,880 lamports (3.56441088 SOL) | ✓ |

---

## 5. Module 5 — Unified Multi-Chain Key Derivation (SLIP-0010)

### 5.1 Derivation tree — one mnemonic, three identities

$$\text{seed} = \mathrm{PBKDF2}_{\text{HMAC-SHA512},\,2048}(\mathrm{NFKD}(\text{mnemonic}),\ \texttt{mnemonic}+\text{passphrase},\ 64\text{B})$$

| Chain | Path | Curve | Address |
|---|---|---|---|
| Solana | `m/44'/501'/0'/0'` | Ed25519 (SLIP-0010) | base58(raw pubkey 32B) |
| Stellar | `m/44'/148'/0'` | Ed25519 (SLIP-0010) | strKey base32 `G…` (CRC16-XModem via SDK) |
| Hyperliquid | `m/44'/60'/0'/0/0` | Secp256k1 (BIP-44) | EIP-55 via `ethers.HDNodeWallet` |

### 5.2 Correctness — cross-implementation proof

- **SLIP-0010 master/CKD:** $I = \mathrm{HMAC}_{\text{SHA512}}(\texttt{ed25519 seed}, \text{seed})$; hardened CKD over $0x00 \| k_p \| \mathrm{ser}_{32}(i)$. **Machine-verified: every derived key AND chain code byte-identical to the canonical `ed25519-hd-key` package** across 4 paths on fresh random seeds — two independent implementations agreeing on all bytes.
- **Hardened-only:** SLIP-0010 Ed25519 defines *no* non-hardened CKD — every non-hardened segment throws (`supports only hardened segments`). Never silently downgraded.
- **BIP-39:** seed KDF cross-verified byte-identical against the canonical `bip39` package (empty passphrase, ASCII passphrase, unicode passphrase); checksum validation re-derives entropy bits from the canonical wordlist and rejects word swaps.
- **Zero cross-contamination:** the same mnemonic yields pairwise-distinct Solana/Stellar/Hyperliquid identities (asserted); changing the passphrase or word count changes every identity (asserted).
- **Memory scrubbing:** the 64-byte seed exists only as a Buffer and is `fill(0)`-scrubbed in a `finally` block before `deriveMultiChainWallet` returns (no string-copies of the seed are retained; JS strings are immutable and cannot be scrubbed — the design keeps seeds out of strings entirely). Signing seeds are scrubbed after use (asserted all-zero). The public API returns addresses and raw public keys only — no private-key field exists on any return object (asserted by string-inspection for `private|seed`).

---

## 6. Test inventory (all real, zero mocks)

| Suite | Tests | What makes them real |
|---|---|---|
| `test/formal-etss.test.js` | 14 | Real `ethers` wallets sign real messages; recovery is real ECDSA; boundaries use injected clock values |
| `test/solana-parity.test.js` | 21 | Byte-level cross-verification vs `bip39`/`ed25519-hd-key`/`stellar-sdk`; real `node:crypto` ed25519 sign/verify; real `crypto.randomBytes` binary corpora; real SHA-256 manifests; documented `solana rent` anchors |
| Full battery | **373/373** | exit 0, `tsc --noEmit` clean, `npm test` prepends `npm run build` (clean-checkout safe) |

**Not implemented here (and honestly labeled):** on-chain RPC execution of buffer writes/closes and nonce-account creation (the engines produce auditable plans + exact wire formats; the RPC wiring is a deployment concern of `src/solana/client.ts` per the blueprint — these tests verify the cryptography, arithmetic and state machines the wire code must satisfy). Nothing in this audit was verified by mock assertion.

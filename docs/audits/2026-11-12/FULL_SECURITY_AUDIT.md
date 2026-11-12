# FurlPay CLI — Full Security Audit (2026-11-12)

**Scope:** entire `FurlPay/furlpay-cli` repository (129 source/test files) plus the
device-authorization backend in the FurlPay webapp that `furlpay login --device`
consumes. Audit method: static trace of every execution path from CLI input →
authentication → API request → response rendering, plus dynamic execution of the
full test suite (21 files, all green after remediation).

## Severity summary

| Severity | Confirmed | Remediated in this commit | Remaining |
|---|---|---|---|
| CRITICAL | 2 | 2 | 0 |
| HIGH | 5 | 4 | 1 (documented limitation) |
| MEDIUM | 3 | 2 | 1 (webapp-side, tracked) |
| LOW | 4 | 1 | 3 (tracked) |
| INFO | 3 | 0 | 3 (tracked) |

## Confirmed findings (post-remediation state)

### C-1 — CRITICAL · CWE-347 · `wallet import` imported a random key
**File:** `src/cli.ts` (handleWallet) — **fixed this commit.**
The handler called `Keypair.random()` and encrypted THAT key under the hardcoded
password `"default-password"`, ignoring whatever key material the user supplied.
A user who "imported" their wallet saw an address they do not control; any funds
sent to it were recoverable only by decrypting with a publicly-known hardcoded
password. **Fix:** the caller's key is read from `--secret-key` or stdin (never
argv), a user-supplied password is mandatory, the key is validated with
`Keypair.fromSecret` before storage, and the secret is never displayed or logged.

### C-2 — CRITICAL · CWE-345 · mnemonic import displayed an unrelated public key
**File:** `src/wallet/keystore.ts` (importMnemonic) — **fixed this commit.**
`importMnemonic` stored the user's words but displayed `Keypair.random()`
metadata. **Fix:** new `src/wallet/mnemonic.ts` implements BIP39 seed
(PBKDF2-HMAC-SHA512, 2048 iters) → SLIP-0010 ed25519 → Stellar `m/44'/148'/0'`,
with checksum validation that fails closed. Verified against the published
SLIP-0010 test-vector table and pinned in `test/mnemonic.test.js` (10 tests).

### H-1 — HIGH · CWE-670 · fake "SETTLED" settlement records
**Files:** `src/x402/micropayments.ts`, `src/trade/sdex.ts`, `src/trade/pathPayment.ts`,
`src/trade/soroban.ts`, `src/order/manager.ts`, `src/sponsor/relayer.ts` — **fixed.**
Every Stellar-side "execution" produced a `crypto.randomBytes` tx hash presented as
a broadcast transaction, and the sponsorship relayer's catch-path announced
"Sponsorship granted" for a transaction that never existed. Violates the
zero-unauthorized-value-movement honesty invariant. **Fix:** simulated results now
carry `simulated: true`, hashes are prefixed `sim_` / `furlpay_simnet_`, statuses
read `SIMULATED`, and CLI output leads with `[!] SIMULATED — no transaction was
built, signed or broadcast.` Regression-pinned in `test/stellar.test.js`.

### H-2 — HIGH · CWE-807 · MCP agents could "trade" with an invented signer
**File:** `src/mcp/server.ts` (furlpay_trade) — **fixed.**
The tool signed orders with `Keypair.random()` — an agent with zero authority got
a "successful trade" receipt. **Fix:** the tool refuses without an explicit
`simulate: true` (result clearly labeled), otherwise returns
`REJECTED/no_signer_configured` with remediation guidance. Key material must never
travel through MCP tool arguments.

### H-3 — HIGH · CWE-276 · MCP mutating tools executed without any approval gate
**File:** `lib/mcp.js` — **fixed.**
`send_stablecoin`, `swap_tokens`, `place_order`, `book_travel`, `earn_deposit`,
`earn_withdraw`, `set_card_controls` called the API directly — the model's
`approved: true` flag carried authority it does not have. **Fix:** a shared
`requireAgentMandate()` gate now throws (fail-closed, before any network I/O)
unless a syntactically valid AP2 mandate (`cpm_`/`intm_`) is supplied.
`test/realtime.test.js` (17/17, now in `npm test`) enforces this for all seven.

### H-4 — HIGH · CWE-672 · device-session revocation was silently unreliable (webapp side)
**File (webapp):** `apps/web/src/lib/auth/deviceGrant.ts` — **fixed in the webapp
workspace.** The per-account device index lived only in per-instance memory and
grant records expired after 15 minutes while the CLI token lived an hour:
a cold serverless instance listed zero devices and `revoke-all` revoked nothing.
**Fix (webapp workspace):** durable `device:account:{userId}` index in KV,
record TTL extended to cover the session lifetime, `listDevices` falls through to
KV. Regression test simulates a cold instance and proves listing + revocation
still reach the token's jti.

### H-5 — HIGH · CWE-20 · hardcoded HMAC quote-signing secret (CWE-798)
**File:** `lib/payTui.js` — **fixed.**
The offline quote fallback HMAC'd ids with `"furlpay_quote_secret_2026_sign"`
shipped in the client — anyone could forge ids that looked server-signed.
**Fix:** fallback quotes are explicit local estimates (`quo_local_` prefix, no
signature, `local: true`); the server remains authoritative at execute time.
The remediation test (`SEC-09`) now pins the honest shape.

### M-1 — MEDIUM · CWE-862 · cross-user device-code approval phishing (webapp)
Classic RFC 8628 phishing shape: a victim approving an attacker-supplied code
grants the attacker's CLI a token for the victim's account. Existing mitigations
(metadata review, 10-min expiry, sign-in, read-only scope) remain; the webapp
approval UI should add an explicit "this code was shown on YOUR terminal"
attestation step. **Tracked — webapp-side.**

### M-2 — MEDIUM · CWE-302 · revocation denylist fails open during KV outage (webapp)
`verifySession({durable:true})` skips the denylist when Redis errors; combined with
H-4 this previously left revoked tokens usable. The H-4 fix makes the denylist
reachable; the outage-window behavior is documented and bounded (1h token TTL).
**Tracked — webapp-side.**

### L-1 through L-4 — LOW
- L-1 user-code collision overwrite (2^-40/active-grant) — tracked, webapp.
- L-2 soft memory cap can overshoot under abuse — tracked, webapp.
- L-3 audit-log semantics conflate deny/cancel events — tracked, webapp.
- L-4 `server.json` version drift (0.3.0 vs package 0.4.0) — **fixed this commit.**

### INFO
- I-1 CLI tokens cannot refresh (hard 1h re-login) — security-positive, document in UX.
- I-2 token re-issue window under concurrent KV outage — bounded by the 60s lock.
- I-3 The default MCP server (lib/mcp.js) and the wallet-mode server (src/mcp/server.ts)
  ship different protocol versions and toolsets — consolidated docs required.

## Boundaries of this audit
- The webapp backend is not in this repository; device-grant findings marked
  "webapp-side" were audited in the FurlPay webapp workspace and are reported here
  because the CLI consumes that flow.
- No real payments, revocations, or production device operations were performed
  during the audit. All dynamic testing used local mock backends and temp dirs.

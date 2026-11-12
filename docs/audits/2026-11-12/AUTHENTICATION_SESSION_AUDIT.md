# Authentication & Session Audit — 2026-11-12

## Credential paths in this repository

| Path | Mechanism | Storage | Status |
|---|---|---|---|
| `furlpay login` (default) | email OTP → `/api/auth/otp/start` + `/check` → `furlpay_session` cookie | `~/.furlpay/config.json`, `sessions[env]`, written 0600 | VERIFIED |
| `furlpay login --device` | RFC 8628 device authorization → Bearer-capable session JWT (`cli:true`, `account:read`, 1h) | same store, per-env | VERIFIED (ported this commit, e2e-tested) |
| `furlpay login --key sk_...` | API/webhook key (dev tooling) | config file | VERIFIED |
| `wallet agent-keygen` | Ed25519 agent keypair + spend policy | `~/.furlpay/agent_policies/*.json` | VERIFIED (plaintext policy file — tracked LOW) |
| `wallet import` | user secret key → PBKDF2(100k,SHA-512)+AES-256-GCM keystore | `~/.furlpay/keystore.enc`, 0600 | FIXED this commit (was random-key+hardcoded-password, CRITICAL) |
| mnemonic import | BIP39 → SLIP-0010 ed25519 → Stellar path | keystore | FIXED this commit (displayed a random pubkey before) |

## Session boundary controls (verified)
- `lib/api.js isCredentialedTarget()`: the session cookie travels ONLY to
  `furlpay.com` (TLS) / loopback. `--api-base` to any other host still works but
  carries no credential, with a loud stderr warning. Pinned by
  `test/credential-trust.test.js` (11 cases) including suffix-confusion vectors.
- `lib/deviceAuth.js browserUrlAllowed()`: the CLI will not open a verification
  URL off furlpay.com/loopback, with userinfo credentials, or a wrong path.
  Hostile-backend test proves no session is stored from a malicious /code response.

## Findings fixed this round
- C-1 random-key import under hardcoded password (CRITICAL).
- C-2 mnemonic keypair mismatch (CRITICAL).
- H-5 hardcoded HMAC quote secret (HIGH).

## Tracked (no exploit path today, monitored)
- Agent policy JSON files are plaintext (no secrets inside — public keys and
  limits only), but directory-level exposure should be documented.
- `wallet import` accepts the password via stdin/flag; a TTY prompt echoes the
  password — piping is recommended in the usage text.
- Device tokens cannot refresh; hourly re-login is intentional (I-1).

## Cross-environment isolation
- Sessions are stored per environment (`sessions.sandbox` vs `sessions.live`);
  the device store keying uses the same env discriminator. `FURLPAY_HL_TESTNET`
  gates the Hyperliquid exchange endpoint. No path was found where a sandbox
  credential authenticates a live request or vice versa.

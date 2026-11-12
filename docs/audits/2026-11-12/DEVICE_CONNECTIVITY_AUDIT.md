# Device Connectivity & Authorization Audit — 2026-11-12

## The authorization flow, as verified in code

```
CLI (furlpay login --device)                    Webapp backend
  │ POST /api/auth/device/code ────────────────▶ 40-bit user_code (crypto-random,
  │ ◀── device_code (256-bit, returned ONCE)      32-symbol alphabet) + 256-bit
  │                                               device_code, HMAC-digested in KV
  │ open /device-auth?code=XXXX-XXXX ──▶ browser
  │                                        user signs in, reviews device metadata,
  │                                        approves  ──▶ grant bound to THAT account
  │ POST /api/auth/device/token (poll 5s)
  │ ◀── 400 authorization_pending / slow_down
  │ ◀── 200 { access_token, scope: account:read, device_session_id }
  │ token stored 0600 in ~/.furlpay/config.json — never printed
```

## What is verified and strong

| Control | Evidence |
|---|---|
| Human code ≠ credential | `deviceGrant.ts` — 8-char user_code for humans; 256-bit base64url device_code for the CLI, returned exactly once |
| Entropy | 40 bits crypto-random, no modulo bias (32 \| 256); 256-bit device code |
| Storage | HMAC-SHA256 digests only, keyed by the session secret; timing-safe compares with dummy-compare equalization |
| Lifecycle | 10-min grant TTL; expired grants cannot be approved/redeemed/revived; single-use exchange with one-winner Redis lock |
| Polling | 5s interval, server-side slow_down escalation (+5s, cap 60s); budgets: code 10/10min/IP, token 30/min/IP, lookup 10/10min/IP — all fail-closed (503) on KV outage |
| Brute force | 2^40 space vs ≤10^4 effective guesses per grant window at 1k-IP rotation ≈ 10^-8 success — infeasible |
| Binding | Approval binds the grant to the signed-in approver's account; second approval by another account refused |
| Token scope | JWT `cli:true`, `scopes:["account:read"]`, 1h hard expiry; `requireUser` enforces a CLI route denylist (whoami, device sessions, logout only) — payments/MFA/keys 403 |
| CLI-side trust | Verification URL allowlist (https furlpay.com / loopback only, no userinfo, path must be /device-auth); browser opened via argv-spawn (rundll32/open/xdg-open), never a shell string; Ctrl+C cancels the grant server-side |

## What the CLI can and cannot do with devices (current truth)

- CAN: authenticate via device authorization; list/revoke its own device sessions
  through `/api/auth/device/sessions` (read-only scope); cancel a pending grant.
- CANNOT (by design, not yet implemented anywhere): arbitrary remote-shell access
  to other computers, agent-initiated signing, refreshing its token.
- The webapp's "Connected devices" model is server-issued grants — there is no
  browser-fingerprint-based discovery anywhere in the flow.

## Remediated in this audit round
1. **Cold-instance revocation hole (HIGH, webapp):** durable per-account KV index +
   record TTL ≥ session lifetime; cold instances now list and revoke live device
   sessions. Regression test: `deviceGrant.spec.ts` ("lists and revokes a live
   device session from a COLD instance").
2. **CLI port:** `lib/deviceAuth.js` (RFC 8628 client: allowlist, slow_down handling,
   SIGINT cancel, JSON mode, zero token echo) shipped in this repository and wired
   to `furlpay login --device`, with end-to-end tests against a local mock backend
   (`test/device-auth.test.js`, 4 tests).

## Open items (webapp-side, tracked)
- M-1: explicit "code came from YOUR terminal" attestation step in the approval UI.
- I-1: document the 1-hour token lifetime in the CLI login output.

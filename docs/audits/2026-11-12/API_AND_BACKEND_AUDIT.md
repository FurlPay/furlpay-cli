# API & Backend Audit — 2026-11-12

Backend = FurlPay webapp (`furlpay.com` / `localhost:8787`), audited in the webapp
workspace; this document records what the CLI consumes and the guarantees it relies on.

## Endpoints consumed by the CLI

| Endpoint | Auth | CLI use | Notes |
|---|---|---|---|
| `/api/auth/otp/start`, `/api/auth/otp/check` | public + rate-limited | email login | verified webapp-side |
| `/api/auth/device/code` | public, 10/10min/IP, fail-closed | start device grant | scope validated (signing scopes rejected) |
| `/api/auth/device/token` | public, 30/min/IP | poll | slow_down escalation; single-use lock |
| `/api/auth/device/cancel` | public, 10/10min/IP | Ctrl+C | requires the device_code (not the user code) |
| `/api/auth/device/sessions`, `/sessions/[id]`, `/sessions/revoke-all` | session/token, scoped | list + revoke devices | cross-instance fix landed this round |
| `/api/cli/whoami` | CLI-token allowlist | login success display | returns email + scope + `signing:false`, no secrets |
| `/api/wallets`, `/api/overview`, `/api/v1/pay/*`, `/api/investing/order`, `/api/earn/*`, `/api/cards/settings`, `/api/travel/*`, `/api/transactions` | session cookie | tools/commands | server-side ownership checks |

## CLI-side transport guarantees (verified in lib/api.js)
1. Cookie only to furlpay.com-over-TLS or loopback; other hosts get a warning and
   a credential-less request.
2. JSON bodies only; no shell interpolation anywhere in the transport.
3. ECONNREFUSED produces an actionable error naming the env.
4. HMAC webhook signing (`t=<ts>,v1=<hmac>`) matches the compliance module.

## Webapp-side guarantees the CLI depends on (verified)
- Device grants: HMAC-digested codes only in storage; one-winner issuance;
  approval binds the grant to the approver's session; KV outage on
  `auth.device.*` buckets fails closed (503).
- CLI tokens: HS256 session JWTs, `cli:true`, `account:read`, 1h TTL, denylist
  enforced inside `requireUser` — payments/MFA/API-keys return 403 to CLI tokens.
- Device revocation now works across serverless instances (durable account index).

## Residual risks (documented, tracked)
- M-1 cross-user approval phishing: mitigations exist; attestation step pending.
- M-2 revocation denylist skips during KV outage (bounded by 1h token TTL).
- The `send` command posts a demo signature; the backend is the validation point
  and rejects it — the CLI should stop fabricating (roadmap P1.4).

## What was NOT audited
Production infrastructure (Vercel/ECS config, Terraform), the mobile clients, and
third-party endpoints beyond Hyperliquid's public API contract. No conclusions
about those are asserted anywhere in this audit.

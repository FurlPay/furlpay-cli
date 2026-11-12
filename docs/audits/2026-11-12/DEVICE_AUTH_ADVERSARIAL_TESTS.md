# Device Authorization — Adversarial Test Results (2026-11-12)

Environment: webapp workspace, dev KV fallback (isolated temp config),
`deviceGrant.spec.ts` — **10 tests, all green**, including the two new race tests.

## Races and adversarial scenarios

| Scenario | Expected | Result | Evidence |
|---|---|---|---|
| **8 concurrent polls redeeming one approved grant** | exactly ONE winner carries `issue:true`; losers cannot re-issue | PASS — one winner; post-commit re-poll → `invalid_grant` | "redeems a device code EXACTLY ONCE under concurrent polling" |
| **Two different accounts approve the same code concurrently** | exactly one approval wins; grant binds to the winner only | PASS — one success; poll exposes the winner's userId | "concurrent approvals by different accounts still bind exactly one owner" |
| Sequential re-approval by a second account | refused | PASS (pass-one test retained) | "refuses a second approval and hides the grant from another account" |
| Poll before approval / after deny / after cancel / after expiry | pending / access_denied / access_denied / expired_token | PASS (pass-one tests retained) | lifecycle tests |
| fast polling | slow_down with escalating interval | PASS | pass-one test retained |
| Cold instance after approval | device still listed + revocable; revocation reaches the token jti | PASS — F-1 regression test (wipe memory mirror, KV only) | "lists and revokes a live device session from a COLD instance" |
| Cancellation requires the device code (not the user code) | cancel with a wrong secret fails | PASS | pass-one test retained |
| Scope escalation at /code | `wallet:sign` scopes rejected; device_code absent from error body | PASS | routes tests |
| Token before approval | 400 authorization_pending; no token | PASS | routes tests |
| CLI token at the approve endpoint | 403 | PASS | routes tests |
| whoami over CLI token | identity + scope only; no totp/seed/secret in body | PASS | routes tests |
| Hostile verification URL (CLI side) | CLI refuses to open; no session stored | PASS (CLI e2e, mock backend) | `test/device-auth.test.js` "refuses to open a verification URL outside the allowlist" |

## Open adversarial scenarios (TRACKED, webapp-side)
- **KV outage between approval and token exchange:** the issuance lock releases after 60s; a grant could re-issue if the first `commitIssuedSession` persist failed. Bounded, requires a concurrent outage; F-8 from pass one, unchanged.
- **Approval-context phishing (M-1):** the approver sees device metadata, but nothing proves the code came from THEIR terminal; the QR code eases relay. Mitigation requires a UI attestation step.
- **In-flight request during revocation:** revocation writes the durable denylist; a request already past `verifySession` completes its handler. Bounded by handler duration; documented limitation.

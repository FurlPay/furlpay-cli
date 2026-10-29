# Phase 5 implementation status

This records verified repository changes, not a production certification. The
attached audit's 426-test count and zero-error monorepo typecheck are not results
of this CLI verification. The separate web workspace typecheck failed with
Buffer/ArrayBuffer type incompatibilities.

| Finding | Implementation and remaining work |
| --- | --- |
| SEC-12 | Windows configuration uses DPAPI CurrentUser encryption; old plaintext configuration migrates on read. Secrets travel through stdin, not process arguments. Corruption and vault failures stop authentication. POSIX files use mode 0600. macOS Keychain and Linux Secret Service integration remain open. |
| SEC-13 | HTTPS, origin checks and ordinary certificate validation exist. Production pin enforcement and RFC 9421 signatures remain open: approved active/backup SPKI pins, key enrollment, gateway verification and rotation/revocation contracts are required. |
| SEC-14 | The quoted fallback string and PAY_QUOTE_SECRET were not found in tracked code in the inspected web workspace. The server quote-signing implementation and deployed secret configuration still require verification. |
| SEC-15 | Automatic payment request keys are persisted atomically before dispatch and reused for matching requests across restarts and time windows. The identity includes API base, environment, source account, recipient, integer cents, currency and memo. Concurrent reservation fails closed. |
| SEC-16 | Profile website URLs are parsed and restricted to HTTPS without credentials, whitespace, terminal controls or directional controls. Invalid schemes are omitted at every layout width. |

## Retry behavior

The journal is in `~/.furlpay/payment-requests`. It contains hashed identities,
request UUIDs and timestamps, never cookies. A timeout does not clear a record.
Automatic matching requests continue to reuse the stored key, including after a
successful response. This requires an explicit new `--idempotency-key` for a
separate, otherwise identical payment. Reconcile the old request before doing so.
The backend must still enforce idempotency atomically. Deleting the journal removes
retry protection. If a process crashes while holding a journal lock, reconcile the
key before manually removing the corresponding lock.

## Verification and boundaries

Regression tests cover cross-window retry identity, different payment identities,
unsafe URI schemes, credential-store round trips and corrupt configuration. The
Windows run exercises DPAPI itself; POSIX CI checks permissions. DPAPI binds to the
Windows user, not necessarily a TPM, and does not protect against code already
running as that user.

Native platform signing and notarization, package-manager submissions, production
streams, Stripe synchronization, settlement finality, AP2 authorization and backend
atomic ledger invariants require their respective services and release credentials.
They are not proven by a CLI preview or this test suite. Pushing source does not
publish an npm release or deploy the payment backend.

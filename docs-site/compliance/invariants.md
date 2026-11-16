# Developer Compliance Invariants

Non-negotiable rules for anyone building on or extending this CLI. Every one of them is enforced in code today — regressions fail tests.

## 1. Never bypass SEP-8 verification

Client code must never simulate or fabricate SEP-8 issuer approval. If an issuer approval server is unreachable, the transaction **fails closed**. `rwa kyc` exits non-zero with guidance; regulated-asset results carry `sep8Status: "not_performed"`.

## 2. Never claim retail perpetual availability in the US

All documentation, help text and marketing must state that derivatives and margin shorting are restricted to verified non-US persons or qualified Eligible Contract Participants (7 U.S.C. § 1a(18)). The CLI surfaces this in `furlpay short mechanisms`.

## 3. Never output plaintext payment card credentials

PAN and CVV never appear in terminal output, command history or persistent logs.

## 4. Enforce the Travel Rule at the protocol level

Cross-chain bridges and stablecoin transfers above $3,000 (€1,000 EU) must integrate encrypted IVMS101 counterparty-VASP exchange **before** on-chain execution.

## 5. Keep local tools and hosted services strictly separated

Where the CLI is a pure client, maintain decentralized RPC paths. Where it touches platform APIs, require authenticated KYC/KYB session tokens. The session cookie is read-only and can never sign.

## Engineering corollaries already in the codebase

- **Zero fabricated hashes** — missing exchange tx hash → `PENDING_CONFIRMATION`, never a synthetic id; escrow fund/release require a real `--tx-hash`
- **Fail closed on missing config** — no signer, no agent policy, unreachable approval server: refuse
- **Honesty labels at runtime** — every simulated surface says `SIMULATED` / `LOCAL_SIMULATION` / `simulated: true` in its structured output
- **Whitelist receipt fields** — structured receipts copy known fields only; secrets can't ride along
- **Integer money math** — BigInt cents / fixed-point; audited ceilings on amounts; correct negative-sign handling
- **Stable idempotency** — header + body key per payment intent; unknown outcomes reconcile, never auto-retry under a new key
- **Atomic spend ledgers** — OS-file-locked validate-and-record under one lock; daily rollover at 00:00 UTC; no policy → refusal
- **Credential-attachment allowlist** — the session cookie goes only to `furlpay.com` over TLS or loopback

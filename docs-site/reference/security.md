# Security Model

The CLI's security posture rests on one architectural decision — **identity and custody are decoupled** — plus fail-closed defaults everywhere money could move.

## Dual-plane architecture

| Plane | Holds | Can do | Cannot do |
|---|---|---|---|
| **Identity** (web session, `furlpay login`) | Read-only session cookie (`account:read`) | Read balances, KYC tier, order blotter | Move funds — it holds no signing keys |
| **Execution** (local signing) | Keys in Ledger / extension / keystore / agent wallets | Sign orders & transfers locally | Leave the machine — zero key material is transmitted |

## Custody options

1. **Hardware** — Ledger Nano S/X/Stax over USB HID, clear-signed on the device screen
2. **Extension loopback** — Freighter / Albedo bridge on `127.0.0.1:4024`
3. **Encrypted keystore** — PBKDF2 (100k, SHA-512) + AES-256-GCM at `~/.furlpay/keystore.enc`
4. **Delegated agent wallets** — EIP-712 Phantom Agent keys (Chain ID 1337) with file-locked spend policies
5. **Exchange API** — Binance HMAC keys, withdrawal capability structurally absent

## Threat model & defenses

| Threat | Defense |
|---|---|
| Stolen web session cookie | Scope decoupling — cookie is read-only; no signing keys exist server-side |
| Info-stealer malware | OS-bound sealing (DPAPI / `0600` POSIX); secrets never in plaintext, never in argv, echo suppressed on interactive input |
| Key in shell history | Argv rejection — secrets via stdin or environment only |
| AI prompt injection ("trade $100k") | Read-only MCP default — value-moving tools are structurally absent from tools/list and refused with `EXECUTION_MODE_REQUIRED`; execution mode adds two-phase preview→confirm (hash-bound, single-use, policy re-run on the STORED amount); OS-file-locked caps (single-tx + daily) evaluated atomically; `requiresUserInteraction` forces human `[y/N]` |
| Compromised exchange API key | Structural absence of withdrawal methods + your Binance-side withdrawal disable + IP binding |
| Adverse slippage / MEV | Pre-trade guardrails; orders >15% from mid rejected as fat-finger; per-side slippage caps with absolute-deviation math; 50 bps default market buffer |
| Credential exfiltration via `--api-base` | Cookie only attaches to `furlpay.com` over TLS or loopback; other targets go credential-less, loudly |
| Payment replay | Persistent nonce ledger + stable idempotency keys; unknown outcomes are never retried under a new key |
| Escrow proof forgery | ECDSA seller-signature verification, spec-hash equality, ledger-clock timestamps |
| Backdated auto-release | `submittedAt` from caller input is discarded — ledger clock only |
| Compromised or diverging price source | Oracle aggregator gates on cross-source agreement (±1–3% per asset): a disagreement returns per-source readings with a **null price** — never a blended number; sanity bands drop out-of-band prints; the Pyth provider is inactive unless an operator configures a gateway + verified feed IDs, and rejects stale publishes

## Money-math integrity

- **BigInt integer cents** for payment amounts; fixed-point decimals for PnL/funding — sign handling correct for fractional negatives (`-0.50` stays negative)
- Audited **$10M single-transfer ceiling** and per-command bounds
- Slippage = absolute deviation from best executable price — sell-side dumps cannot bypass the cap
- No `Math.random()` anywhere security-relevant; `crypto.randomUUID()` / `crypto.getRandomValues()` only

## Distribution security

- npm installs integrity-checked by the registry (sha512 + signatures); the package publishes with npm provenance (sigstore, OIDC-bound to the repo and workflow)
- Release assets (tarball, `checksums.txt`, CycloneDX SBOM) carry build-provenance attestations — `gh attestation verify --repo FurlPay/furlpay-cli <file>`
- Release builds gated on tag/version consistency, full typecheck + tests, and a three-OS smoke install of the packed tarball before publishing
- No postinstall scripts; no secrets in the package; CI actions are SHA-pinned

## Reporting

See [SECURITY.md](https://github.com/FurlPay/furlpay-cli/blob/main/SECURITY.md) in the repository for responsible-disclosure details.

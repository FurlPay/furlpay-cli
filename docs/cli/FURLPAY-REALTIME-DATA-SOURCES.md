# FurlPay CLI authoritative data sources

The table records what the inspected backend actually exposes today. It is a truthful integration inventory, not a product roadmap represented as live data.

| Module | Current source | Transport | CLI state today | Stream contract required | Reconnect and test result |
| --- | --- | --- | --- | --- | --- |
| Wallet balances | Authenticated GET /api/wallets | REST polling | UNKNOWN without provenance | Committed ledger balance event, source ID/time/sequence | Snapshot and stale/offline handling tested |
| Ledger | Admin-only GET /api/ledger | REST polling | UNKNOWN without provenance | Committed ledger posting event; TigerBeetle evidence if adopted | Scope and access are server-enforced; replay client tested |
| Payment lifecycle | POST /api/v1/pay/quote and /execute | Request/response | Quote/receipt only | Scoped payment state events with durable ID | Quote binding and unknown-outcome handling tested |
| Business directory | GET /api/v1/pay/directory/[handle] | REST polling | UNKNOWN without provenance | KYB/sanctions decision events, expiry and source evidence | Handle input and value sanitisation tested |
| KYB / AML | Included in quote and directory responses | Request/response | Used for payment authorization | Compliance decision event with source/expiry | Payment rejects non-verified/non-clear data |
| Chain health | GET /api/chain/status | REST polling | UNKNOWN; mock rows suppressed | RPC/provider source, block timestamp and finality events | Mock values hidden; reorg client test passes |
| Solana / EVM finality | No proven stream endpoint | Not available | OFFLINE/UNKNOWN | Backend-normalised subscription events; never direct privileged terminal RPC | Reorg logic is tested against envelope fixtures |
| Stripe payments | No authenticated listing or stream route | Not available | OFFLINE | Verified, deduplicated webhook-to-event pipeline and REST reconciliation | Reported unavailable; no false live state |
| Customers | No organisation-scoped listing or stream route | Not available | OFFLINE | Tenant-scoped CDC/event feed plus paginated snapshot | Reported unavailable |
| Security events | Admin-only GET /api/ops/security | REST polling | UNKNOWN without provenance | Security event stream carrying source IDs/times | Permission failure becomes OFFLINE |
| AI live context | FurlPay REST through MCP | Snapshot | UNKNOWN | Same event envelope and permissions | Financial mutation tools reject execution |

## Acceptance rule

An entry moves to LIVE only after the backend endpoint has been integrated, its records carry the required envelope fields, and an end-to-end test verifies reconnect, replay, scope isolation, duplicate handling, out-of-order messages, and its source-specific confirmation semantics.

## Payment source of truth

A payment monitor can never authorize a payment. The execution path re-resolves the recipient, verification and sanctions status, source account, quote, amount, fee, limits, and permission at the server. The dashboard balance is never used as the sole spendable authority.

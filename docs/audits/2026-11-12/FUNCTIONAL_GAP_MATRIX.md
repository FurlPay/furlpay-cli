# Functional Gap Matrix — Second Pass (2026-11-12)

Every command/help/README claim cross-checked against the registry, the TS and
JS implementations, and both MCP registries. Statuses: ✅ verified working ·
🔶 SIMULATED (labeled, no network effect) · ❌ documented-but-missing ·
🟡 partial.

## Account & device management
| Capability | Status | Gap |
|---|---|---|
| Email-OTP login | ✅ | — |
| Device authorization (`login --device`) | ✅ (e2e-tested) | token cannot refresh (1h, by design) |
| Device listing/revocation | ✅ webapp-side; CLI-token allowlisted | rename device: webapp-only |
| Account switching | 🟡 | per-env sessions only; no named profiles |
| Remote computer control | — | does not exist anywhere; do not represent as a CLI capability |

## Financial capabilities
| Capability | Status | Gap |
|---|---|---|
| Hyperliquid perps/leverage/kill-switch/HLP deposit | ✅ env-key gated | withdraw: ❌ in help, no handler (`handleEarn` drops to usage) |
| HLP stats | 🟡 | hardcoded fallback figures (sharePrice/PnL/APY) — labeled? not yet: TRACKED |
| A2A pay / swap / bridge / invest / earn / cards (web rail) | ✅ | `send` demo signature (TRACKED); `accounts` fabricated fallback row (TRACKED) |
| Stellar SDEX trades / path payment / Soroban swap | 🔶 SIMULATED | real Horizon submit missing; help does not yet say SIMULATED |
| x402 micropayments | 🔶 SIMULATED | real protocol integration missing |
| Escrow create | ✅ | fund/proof/release/dispute: ❌ in help, unreachable from CLI |
| Agent autonomous settlement | ✅ **removed by design this pass** | personal rail: agents propose, humans approve |

## Terminal capabilities
| Capability | Status | Gap |
|---|---|---|
| Hyperliquid TUI workstation | ✅ | — |
| JSON/CSV/table/quiet output | ✅ (+ this pass: CSV formula-neutralized, cells sanitized) | — |
| Command history / session recovery | ❌ | not implemented |
| Connection diagnostics | 🟡 | realtime state machine tested (17/17); no diagnostics UX |

## Developer capabilities
| Capability | Status | Gap |
|---|---|---|
| MCP default server (19 tools) | ✅ | 7 mutating tools gated; 6 gates remain CLI-side only (backend per-rail enforcement TRACKED) |
| MCP wallet server (24 tools) | 🟡 | protocol version differs (2024-11-05 vs 2025-06-18); `furlpay_balance`/FOBXX sweep labeled SIMULATED this pass; `furlpay_get_funding`/`portfolio_risk`/`get_rwa_quote` still canned (TRACKED) |
| Webhook trigger/listen + signed test events | ✅ | HMAC-SHA256, real forwarding |
| Logs | 🔶 canned 5-line loop | needs real audit/event storage |
| `rwa kyc` | 🔶 SEP-8 hardcoded approved | real approval-server integration missing |
| Hardware wallet / WalletConnect / extension | 🔶 decorative | no HID, no real QR payload, loopback never started |

## Docs-vs-code mismatches (this pass)
- help documents `earn hlp withdraw` and 4 escrow subcommands that have no handler → implement or remove (P1).
- `server.json` version parity fixed in pass one; `CHANGELOG.md` whitelisted but absent.
- README does not mark simulated commands as simulation → P3 honesty pass.

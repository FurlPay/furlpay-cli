# Feature Gap Analysis — 2026-11-12

Classification: ✅ IMPLEMENTED-AND-VERIFIED · 🟡 PARTIAL · 🔶 SIMULATED (no real network effect, now labeled) · ❌ DOCUMENTED-BUT-MISSING

## Account & device management
| Feature | Class | Evidence |
|---|---|---|
| Email-OTP login | ✅ | lib/commands.js:17-56 |
| Device authorization (RFC 8628) | ✅ (ported this commit) | lib/deviceAuth.js + e2e tests |
| Automatic browser opening with safe fallback | ✅ | argv-spawn, FURLPAY_NO_BROWSER/CI guard |
| Device listing / revocation via webapp | ✅ webapp-side; CLI token can read+revoke its sessions | webapp `/api/auth/device/sessions` |
| Device connectivity to other machines (remote shell) | N/A by design | no such feature exists anywhere in the stack; do not confuse account device sessions with remote computer access |
| Multi-account switching | 🟡 | per-env sessions only, no named-account switcher |

## Terminal capabilities
| Feature | Class | Evidence |
|---|---|---|
| Hyperliquid TUI workstation (live order book) | ✅ | src/tui/interactive-terminal.ts |
| SDEX order-book terminal | 🔶 hardcoded book | src/tui/terminal.ts:27-29 (dead code path) |
| JSON/quiet/CSV output | ✅ | lib/output.js |
| Session/command history | ❌ not implemented | — |
| Secure reconnection diagnostics | 🟡 | lib/realtime.js (tested 17/17) |

## Financial capabilities
| Feature | Class | Evidence |
|---|---|---|
| Hyperliquid perps, leverage, kill-switch, HLP deposit | ✅ (env-key gated) | src/hyperliquid/* |
| HLP withdraw | ❌ documented in help, no branch | bin/furlpay.js:66 vs src/cli.ts handleEarn |
| Stellar SDEX trades | 🔶 simulation only | sdex.ts / pathPayment.ts / soroban.ts |
| Escrow create | ✅ state machine | src/settlement/escrow.ts |
| Escrow fund/proof/release/dispute | ❌ documented, unreachable from CLI | bin help vs handleEscrow |
| A2A pay / swap / bridge / invest / earn / cards (web) | ✅ | lib/commands.js |
| x402 micropayments | 🔶 simulation only | src/x402/micropayments.ts |

## Developer capabilities
| Feature | Class | Evidence |
|---|---|---|
| MCP default server (19 tools) | ✅ | lib/mcp.js |
| MCP wallet server (24 tools) | 🟡 mixed real/canned (canned now labeled) | src/mcp/server.ts |
| Webhook trigger/listen with HMAC-SHA256 forwarding | ✅ | lib/util.js sign(), bin/furlpay.js:237-306 |
| Signed test events | ✅ | same path |
| Shell completions | ✅ | lib/completion.js |
| `logs` | 🔶 canned loop | bin/furlpay.js:289-306 |
| `accounts` fallback row | 🔶 fabricates a treasury row when API empty | lib/commands.js:1001-1010 |

## Mock inventory (all previously unlabeled, now `SIMULATED`-marked)
`wallet connect ledger` (no HID), `connect walletconnect/sep7` (decorative QR),
`connect extension` (loopback server never started), `order manager` fixtures,
`rwa kyc` (SEP-8 hardcoded approved), `portfolio`, `logs`, Hyperliquid status
hardcoded ONLINE, HLP stats fallback figures, markets sample-symbol list.

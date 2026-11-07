# FurlPay CLI streaming security audit

## Implemented controls

| Area | Control | Evidence |
| --- | --- | --- |
| Authentication | Session-cookie authentication is required before a stream target is constructed | Stream target tests and identity preflight |
| Origin confinement | Only same-origin /api paths are accepted; redirects and URL credentials are refused | Transport tests |
| Transport encryption | HTTPS is required except loopback HTTP in sandbox | API transport tests |
| Scope | Every event must match the signed-in subject and organisation | Scope mismatch regression tests |
| Event integrity | Schema version, ID, topic, sequence, source/time, authoritative and committed flags are required | Envelope validation tests |
| Replay | Last-Event-ID and WebSocket subscription cursor use the last accepted event only | SSE and WebSocket integration tests |
| Ordering | Duplicate and out-of-order events are ignored; a gap forces a new snapshot | Reconciliation tests |
| Availability | 15 s handshake and heartbeat thresholds; bounded reconnect; expired auth stops monitoring | EOF, disconnect, 401 and recovery tests |
| Resource limits | SSE and WebSocket events are limited to 1 MiB; rows are bounded | Oversized frame test |
| Output safety | ANSI, OSC 52, controls, BiDi overrides, and hidden characters are removed | Terminal-sanitiser tests |
| Privacy | Projection allowlists data fields and excludes secret, session, payment-card and PII-shaped keys | Projection tests |
| AI authorization | MCP rejects financial mutations; models cannot create consent | MCP mutation regression test |

## Findings and operational limits

1. The existing backend does not provide a generic financial event endpoint. The CLI therefore uses polling and displays a non-LIVE freshness state.
2. The current chain-status implementation can label generated mock block heights as healthy. The CLI filters source=mock records so they never reach a live terminal panel.
3. Stripe and customer feeds are absent. The CLI marks them unavailable and must not be represented as integrations until authenticated, tenant-scoped APIs and verified webhook reconciliation exist.
4. Server-side event authentication, tenant authorization, event-source signing, and webhook verification are mandatory backend responsibilities. The client validates claims but cannot establish their truth independently.

## Deployment gate

Do not advertise general live monitoring until the event endpoint is deployed with committed event producers and end-to-end production evidence. No release or real-money transfer was performed by this implementation.

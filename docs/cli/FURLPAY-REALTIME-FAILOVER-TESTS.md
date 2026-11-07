# FurlPay CLI real-time failover tests

The Node test suite covers the failure modes below with in-process SSE, WebSocket, and API fixtures.

| Scenario | Expected client behaviour | Result |
| --- | --- | --- |
| SSE chunk boundaries and multiline frames | Parse only completed frames | Pass |
| Stream EOF | Mark disconnected and reconnect | Pass |
| WebSocket ping/pong | Detect stalled peer and reconnect | Pass |
| 401/403 stream response | Stop rather than retry with stale credentials; hide values | Pass |
| Network disconnect | Reconcile a fresh REST snapshot and reconnect with cursor | Pass |
| Duplicate event | Ignore without changing state | Pass |
| Out-of-order event | Ignore without rollback | Pass |
| Sequence gap | Enter SYNCING and require snapshot before updates | Pass |
| Event replay | Send Last-Event-ID / WebSocket after cursor | Pass |
| Scope mismatch | Reject cross-subject or cross-organisation event | Pass |
| Missing provenance | Mark UNKNOWN rather than LIVE | Pass |
| Mock chain source | Hide simulated block values | Pass |
| Reorganisation | Replace value with lower real block and pending confirmation | Pass |
| Oversized stream event | Terminate the transport at 1 MiB | Pass |
| Invalid control text | Strip terminal control/injection payload | Pass |
| Terminal suspend or delayed timer | Invalidate stream and reconcile | Covered by age timer logic |
| Customer pagination | No route exists | Not verifiable |
| Stripe duplicate webhook | No terminal feed exists | Not verifiable |
| Live Solana commitment changes | No terminal feed exists | Not verifiable |
| Live EVM reorg/provider outage | No terminal feed exists | Not verifiable |

Run the suite with:

~~~sh
npm test
~~~

Not-verifiable rows are deliberate deployment blockers for a claim of end-to-end live coverage. The CLI's stream client is ready to validate those events when the scoped backend producers are available.

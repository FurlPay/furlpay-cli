# FurlPay CLI real-time architecture

## Status

The CLI has a complete client-side real-time state machine and authenticated SSE/WebSocket transports. The inspected FurlPay backend currently has no general authenticated financial event endpoint, so the default production behaviour is automatic REST reconciliation with truthful UNKNOWN or DELAYED freshness. It does not claim to be LIVE based on a cache or a successful snapshot.

## Principles

1. The backend, not the terminal, decides whether a record is authoritative, committed, confirmed, spendable, verified, or final.
2. A dashboard balance is informational. Payment execution always retrieves a fresh server quote and makes its own authorization decision.
3. The CLI never connects to databases, Stripe, a ledger, or a blockchain RPC using privileged credentials. Those systems publish through FurlPay's authenticated API.
4. Absence of provenance is visible. The client uses LIVE, SYNCING, DELAYED, STALE, OFFLINE, and UNKNOWN instead of inferring status.

## Client topology

~~~text
authoritative system -> FurlPay API snapshot -> CLI reconciliation store -> terminal
                               |
                               +-> authenticated SSE or WebSocket event feed
                                       -> validate -> deduplicate -> sequence check
                                       -> render within a 16 ms batch
~~~

Each monitor begins by authenticating through GET /api/profile, then obtains a REST snapshot. A configured stream endpoint is connected only after that scope is established. On connection loss, a sequence gap, resume from sleep, or network switch, the monitor marks its panels SYNCING, retrieves a new snapshot, and reconnects with the last accepted event ID.

## Event envelope

The backend event feed must send JSON with this contract:

~~~json
{
  "schemaVersion": 1,
  "id": "ledger:posting:01J...",
  "topic": "wallet",
  "type": "snapshot",
  "sequence": 812,
  "subject": "authenticated-user-id",
  "organization": "optional-organization-id",
  "source": "TigerBeetle",
  "sourceTimestamp": "2026-10-29T10:00:00.000Z",
  "ingestedAt": "2026-10-29T10:00:00.125Z",
  "authoritative": true,
  "committed": true,
  "confirmation": "committed",
  "records": []
}
~~~

The first event for a topic must be a snapshot. Updates must be contiguous per-topic sequences. A reorganisation is a new, monotonically sequenced replacement record with its actual confirmation state; a decreased block height never becomes final merely because it was rendered.

## Transports

SSE requests use the session cookie, same-origin endpoint, HTTPS, a 15-second handshake limit, a 1 MiB frame limit, Last-Event-ID replay cursor, and a 15-second heartbeat expectation. WebSocket requests use the same session scope, disable redirects and per-message compression, cap payloads at 1 MiB, send a subscribe message with the replay cursor, and use ping/pong heartbeats.

Both transports reconnect with bounded exponential backoff, beginning immediately and capping at 30 seconds. HTTP 401/403 stops the monitor and marks values OFFLINE. A 404/405/501 stream endpoint falls back to polling, marked as polling rather than streaming.

## Freshness states

| State | Meaning | Terminal treatment |
| --- | --- | --- |
| LIVE | Stream is active and source plus sync timestamps are within threshold | Display records and provenance |
| SYNCING | Starting, reconnecting, or reconciling a sequence gap | Hide financial values |
| DELAYED | Timestamp exceeds fresh threshold or polling supplies a snapshot | Display with warning |
| STALE | Timestamp exceeds stale threshold | Hide financial values |
| OFFLINE | Source unavailable, stream auth expired, or request failed | Hide financial values |
| UNKNOWN | Backend did not supply required provenance | Show only as unverified snapshot |

Defaults are 15 seconds for fresh, 60 seconds for stale, and 15 seconds for heartbeats. All are configurable per invocation.

## Payment status

The payment screen is deliberately separate from the monitor. It obtains an authoritative recipient, compliance decision, account, fee, amount, quote ID, and balance from POST /api/v1/pay/quote. Immediately before POST /api/v1/pay/execute it validates that quote again. A receipt is only called completed or settled when it includes server-issued ledger evidence and a settlement timestamp. Pending and approval states retain their actual names. Timeouts and 5xx responses become UNKNOWN and provide an idempotency key for reconciliation.

## Backend work still required

The CLI cannot make a backend event system exist. Before a monitor can display LIVE financial values, FurlPay needs an authenticated same-origin event service that implements this envelope and has real integrations for committed ledger postings, directory/KYB changes, payment lifecycle events, chain finality, and deduplicated Stripe webhooks. The Stripe and customer APIs described in the data-source matrix also need implementation.

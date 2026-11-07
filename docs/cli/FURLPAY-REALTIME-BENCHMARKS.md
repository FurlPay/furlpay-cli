# FurlPay CLI real-time benchmarks

Measured on 2026-10-29 with Node v22.23.4 on Windows x64, AMD Ryzen 5 4600H. The harness runs 500 measured iterations after warm-up and uses the actual terminal renderer, SSE parser, validation, reconciliation store, and freshness-aware dashboard projection.

| Measurement | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Payment-screen render at 120 columns | 10.880 ms | 19.238 ms | 23.612 ms |
| Local SSE parse, validate, reconcile and render | 4.297 ms | 11.965 ms | 13.974 ms |

The renderer batches terminal writes at 16 ms. The local p95 is below the 50 ms rendering target. The raw result is committed as [benchmark-results.json](benchmark-results.json).

These numbers are local synthetic measurements. They do not establish FurlPay-event propagation, blockchain finality, RPC latency, Stripe webhook delivery, or public internet performance; those remain UNVERIFIED until measured from deployed, authoritative systems.

Run:

~~~sh
npm run benchmark
~~~

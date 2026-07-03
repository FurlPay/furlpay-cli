# Furlpay CLI

[![npm](https://img.shields.io/npm/v/%40furlpay%2Fcli)](https://www.npmjs.com/package/@furlpay/cli)
[![CI](https://github.com/FurlPay/furlpay-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FurlPay/furlpay-cli/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

`stripe-cli` for stablecoins. Develop and test [Furlpay](https://furlpay.com) webhook integrations from your terminal: forward sandbox events to localhost, trigger signed test events on demand, and tail request/response cycles. Zero dependencies, Node 18+.

## Installation

```bash
npm install -g @furlpay/cli
```

This installs the `furlpay` binary.

## Commands

| Command | Description |
|---|---|
| `furlpay login --key sk_sandbox_...` | Store your API key locally for subsequent commands. |
| `furlpay listen --forward-to <url>` | Stream sandbox webhook events and forward each one, signed, to your local endpoint. |
| `furlpay trigger <event.type>` | Emit a single signed test event (for example `card.transaction.authorized`). |
| `furlpay events` | List every event type you can trigger. |
| `furlpay logs --tail` | Stream recent API request/response cycles. |
| `furlpay help` | Usage summary (`-h`, `--help` also work). |

## Typical workflow

Terminal 1 — run your app:

```bash
npm run dev   # your webhook handler at http://localhost:3000/api/webhooks
```

Terminal 2 — forward signed events to it:

```bash
furlpay login --key sk_sandbox_demo
furlpay listen --forward-to localhost:3000/api/webhooks
```

Terminal 3 — fire a test event:

```bash
furlpay trigger card.transaction.authorized
```

## Signatures

Every event the CLI emits is signed with the same HMAC-SHA256 `furlpay-signature` scheme the production API uses, so your handler exercises real verification in development:

```
furlpay-signature: t=1719900000,v1=5257a869e7...
```

Verify with [`@furlpay/furlpay-node`](https://www.npmjs.com/package/@furlpay/furlpay-node):

```ts
import { Furlpay } from "@furlpay/furlpay-node";

const event = Furlpay.webhooks.constructEvent(rawBody, sigHeader, endpointSecret);
```

The signature includes a timestamp and is validated with a constant-time comparison and a plus/minus 300 second tolerance, so replayed or stale events are rejected.

## Related

- [furlpay-node](https://github.com/FurlPay/furlpay-node) — the Node.js/TypeScript SDK
- [furlpay-openapi](https://github.com/FurlPay/furlpay-openapi) — OpenAPI 3.1 spec
- [Documentation](https://furlpay.com/docs)

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## License

MIT

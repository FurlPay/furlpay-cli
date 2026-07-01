# Furlpay CLI

[![CI](https://github.com/FurlPay/furlpay-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/FurlPay/furlpay-cli/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

`stripe-cli` for stablecoins — test [Furlpay](https://furlpay.com) webhooks and
events from your terminal. Zero dependencies.

## Install

```bash
npm install -g @furlpay/cli
```

## Commands

```bash
furlpay login --key sk_sandbox_...                         # store your key locally
furlpay listen --forward-to localhost:3000/api/webhooks    # stream sandbox webhooks
furlpay trigger card.transaction.authorized                # emit a signed test event
furlpay events                                             # list triggerable event types
furlpay logs --tail                                        # stream request/response cycles
```

Every event the CLI emits is signed with the same HMAC-SHA256
`furlpay-signature` scheme the production API uses, so your webhook handler
verifies real signatures in development:

```
furlpay-signature: t=1719900000,v1=5257a869e7...
```

Verify with [`@furlpay/furlpay-node`](https://github.com/FurlPay/furlpay-node):

```ts
Furlpay.webhooks.constructEvent(rawBody, sigHeader, endpointSecret);
```

## License

MIT

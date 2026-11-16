# Configuration & Diagnostics

Everything lives under `~/.furlpay/`. On POSIX the directory is created `0700` with `0600` files; on Windows secrets are DPAPI-sealed to the current user.

## The config file

`~/.furlpay/config.json` holds environment selection, API endpoints and per-environment session cookies:

```json
{
  "env": "sandbox",
  "sandboxUrl": "http://localhost:8787",
  "liveUrl": "https://furlpay.com",
  "sessions": { "sandbox": "…", "live": "…" }
}
```

```bash
furlpay env sandbox   # point at mock endpoints & testnets
furlpay env live      # point at production mainnet APIs
```

::: warning
The live environment never silently falls back to sandbox endpoints, and a live session cookie is never sent over plain HTTP — not even to localhost.
:::

## Validate the local config

```bash
furlpay config validate [--output json]
```

Structural checks, zero network calls:

- canonical network passphrases (Stellar mainnet/testnet strings must be exact)
- `https` endpoints everywhere except loopback development
- slippage and pre-trade risk bounds are inside sane ranges
- **agent-trust cap consistency** — a single-transaction cap may never exceed the daily cap

Non-zero exit on any error, so it drops straight into CI.

## Doctor — machine-readable diagnostics

```bash
furlpay doctor [--output json]
```

Checks the install method, registry health, local config and live API connectivity. **Exits non-zero when the API liveness check fails** — scripts can rely on it as a gate.

## Transaction verification semantics

```bash
furlpay tx verify <64-hex-hash> [--network mainnet|testnet] [--output json]
```

`tx verify` performs `GET /transactions/{hash}` against the documented Horizon endpoint for the selected network and reports **exactly what a lookup proves**:

| Result | Meaning |
|---|---|
| `CONFIRMED_SUCCESS` | Real transaction, succeeded on-chain |
| `CONFIRMED_FAILED` | Real transaction, failed on-chain |
| `NOT_FOUND` | No such tx visible — **explicitly not proof of absence** |
| `INVALID_HASH` | Malformed hash |
| `UNAVAILABLE` | Horizon outage — never evidence about the transaction |

This is an API lookup of finalized ledger history, and it never claims to be cryptographic re-verification. Exit codes: `0` = confirmed success, `1` = everything else.

## Testnet faucet

```bash
furlpay faucet --address <G...> [--network testnet|futurenet]
```

Real Stellar Friendbot funding on testnet/futurenet only — **mainnet is refused outright** (real XLM cannot be fabricated). `FUNDED` is reported only on an actual successful Friendbot response, with the funding tx hash and an independent Horizon balance check.

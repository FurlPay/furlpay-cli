# A2A Payments (`furlpay pay`)

Account-to-account stablecoin transfers to a verified business handle. No FurlPay fee. The payment flow is **quote-bound and consent-first** — every invariant below is enforced in code and covered by the test suite.

## Quick start

```bash
# Always quote what a payment WOULD look like — offline, zero API calls
furlpay pay --demo

# Headless (non-TTY): explicit consent is mandatory, or nothing happens
furlpay pay '@recipient' 10 USD --yes --json

# Dry-run: fetch a real server quote, never execute
furlpay pay --dry-run '@recipient' 10 USD --json

# Interactive TTY: renders the reviewed quote, waits for a single y keypress
furlpay pay '@recipient' 250 USD
```

::: tip Quote handles in PowerShell
Unquoted `@handle` is consumed as a splat operator and shifts your arguments. Always quote: `furlpay pay '@recipient' 10 USD`. The CLI also detects the shifted shape and refuses with a hint instead of paying the wrong party.
:::

## The execution flow, step by step

1. **Input contract** (`validateInput`) — handle, amount and currency are validated before anything else. Amounts are parsed to **BigInt integer cents** (no IEEE-754 anywhere near money) with an audited $10,000,000.00 single-transfer ceiling. Boolean consent flags take no values — `--yes=false` is refused, not interpreted.
2. **Headless consent gate** — a non-interactive terminal without `--yes`/`--agent` refuses with `confirmation_required` **before any network call**. Zero requests leave the machine.
3. **Quote binding** (`validateQuote`) — the server quote must match the intent exactly: recipient handle, amount, currency, non-negative fee, KYB `verified`, sanctions `clear`, and an **authoritative** source account with sufficient balance. Any deviation refuses the payment.
4. **Consent** — interactive single-keypress confirmation (pasted input is ignored; EOF/expiry cancels), or explicit `--yes`/`--agent`.
5. **Expiry re-check** — a quote that lapses *during* confirmation cannot be sent (`quote_expired`).
6. **Execute with a stable idempotency key** — sent in both the `Idempotency-Key` header and the body. The key is stable for the lifetime of the payment intent.
7. **Honest outcome classification** — see below. Only a provable settlement ever prints as one.

## Outcome classification

| Outcome | Meaning |
|---|---|
| `completed` | Server returned a complete settlement (transferId, ledgerTxId, settledAt, exact amount) — a whitelisted receipt is printed |
| `pending` / `requires_approval` | Async states, reported as exactly what they are — never described as settled |
| `failed` | A recognized 4xx rejection — the payment did not happen |
| `unknown` | Transport fault, 5xx, or a malformed response. **Never auto-retried** — the idempotency key is surfaced for reconciliation, because a retry with a NEW key could double-pay |

## Receipts that cannot leak

Receipts are built by field whitelist — `status`, `transferId`, `ledgerTxId`, `settledAt`, `amount`, `currency`, `fee`, `rail`. Anything else riding on the response object (`totpSecret`, session tokens, …) structurally cannot reach the output. A `failed` response throws rather than printing a fake receipt.

## JSON mode

`--json` prints one machine-readable object describing the final state — ideal for agents and scripts:

```json
{
  "ok": true,
  "status": "completed",
  "transferId": "tr_real",
  "ledgerTxId": "ledger_real",
  "settledAt": "2026-11-17T00:00:00.000Z",
  "amount": 10,
  "currency": "USD",
  "idempotencyKey": "0d5f7c2e-…"
}
```

## Sending to a raw address

```bash
furlpay send 25 0xAbc… --token USDC --chain arbitrum
```

## Currency support

`USD`, `USDC` and `EUR`. A human may omit currency (defaults to USD); `--agent` payments **must** state it explicitly — automation never assumes.

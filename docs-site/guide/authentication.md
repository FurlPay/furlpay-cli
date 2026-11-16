# Authentication

FurlPay CLI uses a **dual-plane** model: the login session is a *read-only identity token* — it can never move funds. All transaction signing happens locally with keys the session never sees.

## Browser device login (recommended for desktops)

```bash
furlpay login --device
```

The RFC 8628 device-authorization flow, mirroring `gh auth login`:

1. The CLI requests a device code from the FurlPay API (`scope: account:read`).
2. It displays an 8-character verification code (e.g. `WDJB-4972`) and opens your browser at `https://furlpay.com/device-auth?user_code=WDJB-4972`.
3. You sign in on the web dashboard (Passkey / WebAuthn, Google SSO, or email 2FA) and click **Approve**.
4. The CLI polls the token endpoint with exponential backoff and stores the session cookie in `~/.furlpay/config.json`.

The terminal prints:

```
✓ Successfully authenticated with FurlPay. Transaction signing was not granted.
```

**Open-redirect guardrail:** the CLI validates the browser URL before launching — non-HTTPS targets, arbitrary schemes, embedded credentials and non-`furlpay.com` domains are refused (CWE-601).

## Headless email OTP login (servers & CI)

```bash
furlpay login --email trader@institutional-desk.com
```

1. The CLI triggers a 6-digit one-time code to your registered email.
2. Enter the code at the `Enter code:` prompt.
3. The session cookie is minted and stored.

## Keys are never argv

Secrets are **refused as command-line arguments** (visible in process listings and shell history). Mnemonics, private keys and API keys must arrive via environment variables or stdin:

```bash
# Correct: piped via stdin
printf '%s\n' "twelve word mnemonic ..." "keystore_password" | furlpay wallet import --name primary --mnemonic

# Correct: environment
export HYPERLIQUID_PRIVATE_KEY="0x..."
export BINANCE_API_KEY="..."
export BINANCE_API_SECRET="..."
```

## Session management

```bash
furlpay whoami    # active session, verified email, KYC tier, Safe address
furlpay logout    # revoke the local session cookie
furlpay env live  # switch environment (sandbox | live) — endpoints follow
```

Session cookies are stored per-environment (`sandbox` / `live`) and are only ever attached to credentialed hosts: `furlpay.com` over TLS, or loopback for development. Pointing `--api-base` elsewhere sends the request **without** the credential and says so, rather than leaking the cookie (see the [Security Model](/reference/security)).

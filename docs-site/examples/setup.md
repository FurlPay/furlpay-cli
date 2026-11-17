# Examples — setup, wallets, agents (1–10)

## 1. First-time install (npm)

Requires Node.js ≥ 22.19.0. No administrator/root privileges needed.

```bash
npm install -g @furlpay/cli
furlpay --version
```

Verify: the version prints and `furlpay --help` lists the command groups.
Details and troubleshooting: [Installation](/guide/installation).

## 2. Windows PowerShell install

```powershell
irm https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.ps1 | iex
```

Per-user, no elevation. Options: `-Version X.Y.Z` (pin), `-DryRun`,
`-Uninstall`. The script verifies Node/npm and warns on unofficial registry
mirrors. Inspect it before piping to `iex` if that matters to you.

## 3. macOS / Linux quick install

```bash
curl -fsSL https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.sh | sh
```

Options: `--version X.Y.Z`, `--channel beta`, `--dry-run`, `--uninstall`.
The script never uses sudo and verifies the installed version afterwards.

## 4. CLI authentication

Two flows (RFC 8628 device login for browsers, headless OTP for servers):

```bash
# Browser flow — opens the authorization page (or prints the URL with FURLPAY_NO_BROWSER=1)
furlpay login --device

# Headless — OTP to your email; the CLI prompts for the code
furlpay login
```

Verify: `furlpay whoami` prints the active session. Secrets are never argv;
`login --key` accepts key material on **stdin only**:

```bash
printf '%s' "$MY_KEY" | furlpay login --key
```

## 5. Wallet connection (extension / SEP-7)

```bash
# Browser loopback bridge on 127.0.0.1:4024 for Freighter & Albedo
furlpay wallet connect extension --port 4024

# SEP-0007 URI rendered as a high-contrast ASCII QR for mobile wallets
furlpay wallet connect sep7
```

Verify: the bridge prints the account it connected (a device **probe** proves
reachability only — no balance is queried; use a Horizon lookup for funds).

## 6. Hardware wallet (Ledger) setup

```bash
furlpay wallet connect ledger --derivation-index 0
```

Prerequisites: Ledger connected over USB HID with the Stellar app open.
Derivation path `m/44'/148'/0'`. The CLI prints model, firmware, app version
and the public key. Signing requests are confirmed **on the device** — the
private key never leaves it.

## 7. Import an encrypted wallet (stdin only)

```bash
printf '%s\n%s\n' "<12/24-word mnemonic>" "<master password>" | furlpay wallet import --name desk-primary --mnemonic
```

The keystore is PBKDF2 + AES-256-GCM at `~/.furlpay/`; writes are atomic
(temp file → fsync → rename). Verify: `furlpay wallet list`. Piping is
recommended over typing because interactive input still echoes control of
the terminal (masking is applied, but a pipeline leaves no screen trace).

## 8. Create an agent wallet + spending policy

```bash
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --single-tx-cap 10.00 \
  --allowed-assets USDC,BTC,ETH,HYPE \
  --expiry 7d
```

This writes the policy file under `~/.furlpay/agent-policies/`. The
single-tx cap may not exceed the daily cap (`config validate` enforces the
consistency rule). Revoke by deleting/expiring the policy file — every gate
that reads it fails closed afterwards.

## 9. Read-only MCP configuration

```json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "furlpay",
      "args": ["mcp", "--wallet", "agent-alpha"]
    }
  }
}
```

Behavior (pinned by `test/mcp-hardening.test.js`): tools/list contains **no
value-moving tool**; a guessed call like `send_stablecoin` errors with
`EXECUTION_MODE_REQUIRED`. This is the default — nothing to enable for
safety.

## 10. Execution-enabled MCP configuration

```json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "furlpay",
      "args": ["mcp", "--wallet", "agent-alpha", "--enable-execution"]
    }
  }
}
```

Prerequisites: a policy for `agent-alpha` on disk (recipe 8). Without one,
execution mode **refuses to start** (exit 47). Even now, mutating tools
cannot be called directly — every value-moving call goes through the
two-phase protocol (next page, recipe 11).

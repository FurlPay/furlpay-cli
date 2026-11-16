# Installation

Requires **Node.js ≥ 22.19.0**. Works on Linux, macOS and Windows — no administrator/root privileges needed. Full verification, troubleshooting and uninstall steps below.

## npm — recommended

```bash
npm install -g @furlpay/cli
furlpay --version
```

## Quick install — macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.sh | sh
```

The script verifies Node/npm, warns on unofficial registry mirrors, **never uses sudo**, and verifies the installed version afterwards. Inspect it first, or run `sh install.sh --help` for:

| Flag | Effect |
|---|---|
| `--version X.Y.Z` | Pin a specific version |
| `--channel beta` | Install the beta channel |
| `--dry-run` | Show what would happen, change nothing |
| `--uninstall` | Remove the CLI |

## Quick install — Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.ps1 | iex
```

Same checks and options (`-Version`, `-Channel`, `-DryRun`, `-Uninstall`), per-user, no elevation.

## npx — no global install

```bash
npx @furlpay/cli --help
```

## Other package managers

```bash
pnpm add -g @furlpay/cli     # or: yarn global add @furlpay/cli / bun install -g @furlpay/cli
```

## Offline install from the release tarball

Each GitHub release publishes the exact npm tarball plus `checksums.txt`, a CycloneDX SBOM, and sigstore build-provenance attestations:

```bash
sha256sum -c checksums.txt --ignore-missing   # verify first
npm install -g ./furlpay-cli-<version>.tgz
```

Release provenance can be checked independently:

```bash
gh attestation verify --repo FurlPay/furlpay-cli furlpay-cli-<version>.tgz
```

::: info Standalone binaries
Standalone binaries (no Node.js required) are **not yet available** — npm is the supported installation channel. The README will list binaries, with checksums and attestations, only once they actually ship.
:::

## Keep it current

```bash
furlpay update --check        # read-only check against npm
furlpay update                # self-update (npm installs), with confirmation
furlpay doctor                # install method, registry, config, connectivity
```

Updates are installation-method aware, transmit no credentials, never touch `~/.furlpay` (config, wallets, escrow ledger), and can be rolled back with:

```bash
npm install -g @furlpay/cli@<previous>
```

## Verify your install

```bash
# Machine-readable diagnostics; exits non-zero when the API liveness check fails
furlpay doctor --output json

# Validate local config structure: canonical passphrases, https endpoints,
# risk bounds, agent-trust cap consistency
furlpay config validate --output json
```

## Uninstall

```bash
npm uninstall -g @furlpay/cli
# Data remains at ~/.furlpay — delete it manually if you want a full wipe
rm -rf ~/.furlpay
```

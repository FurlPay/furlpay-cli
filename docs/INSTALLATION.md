# Installing FurlPay CLI

System requirements: **Node.js ≥ 22.19.0** (npm ships with it), on Linux,
macOS, or Windows. No administrator/root privileges are needed by any install
path, and `~/.furlpay` (config, keystores, escrow ledger) is never touched
during installation.

## npm (recommended)

```bash
npm install -g @furlpay/cli
furlpay --version
```

This is the primary distribution channel. Tarball integrity is enforced by
npm itself: every install is checked against the registry's sha512 digest
and registry signatures before anything is executed.

## Quick install — macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.sh | sh
```

The script is deliberately short and readable — inspect it before running it
(that is the point of `curl | sh`). It verifies Node/npm, warns on
non-official registry mirrors, refuses to use sudo, installs, and then
**verifies** `furlpay --version` matches the target version.

Options (non-piped use):

```bash
sh install.sh --help
sh install.sh --dry-run                      # plan without changing anything
sh install.sh --version 0.4.0                # pin an exact version
sh install.sh --uninstall                    # remove the global package
```

## Quick install — Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.ps1 | iex
```

Works in Windows PowerShell 5.1+ and PowerShell 7, per-user, no elevation.
Same flags as the shell script: `-Version`, `-Channel stable|beta`,
`-Uninstall`, `-DryRun`.

## npx (no global install)

```bash
npx @furlpay/cli --help
npx @furlpay/cli@0.4.0 doctor
```

npx caches per run; for repeated use prefer the global install.

## pnpm / yarn / bun

```bash
pnpm add -g @furlpay/cli
yarn global add @furlpay/cli
bun install -g @furlpay/cli
```

Any npm-compatible global installer works; the package is plain CommonJS
JavaScript with no postinstall scripts.

## Offline install from the release tarball

Every release publishes the exact npm tarball as a GitHub Release asset:

```bash
# from https://github.com/FurlPay/furlpay-cli/releases
sha256sum -c checksums.txt --ignore-missing   # verify first
npm install -g ./furlpay-cli-<version>.tgz
```

## Standalone binaries (no Node.js required)

Not yet available — planned as a follow-up distribution channel. npm is the
only supported installation method today; this page and the README will say
so explicitly the moment binaries ship, with checksums and attestations.

## Verifying the installation

```bash
furlpay --version      # prints the semantic version
furlpay doctor         # install method, registry, config, connectivity
furlpay --help
```

`furlpay doctor` shows the detected install method (npm global / npx /
Homebrew), the npm registry in use, the latest version on npm, config-file
permissions, and API connectivity. It never prints secrets.

## Uninstalling

```bash
npm uninstall -g @furlpay/cli     # or: sh install.sh --uninstall
```

User state under `~/.furlpay` (config, wallets, keystores, escrow ledger) is
left in place; delete the directory manually if you want a full wipe.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EBADENGINE` / unsupported engine on install | Node < 22.19.0. Upgrade Node (`nvm install --lts` or https://nodejs.org). |
| `EACCES` during global install | npm prefix not user-writable. `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to PATH — never use sudo. |
| `furlpay: command not found` after install | The npm global `bin` directory is not on PATH. `npm prefix -g` shows it; add its `bin` to PATH. |
| Windows `furlpay` not recognized | Reopen the terminal after install so PATH changes are picked up. |
| Install worked but CLI crashes on import | A non-official registry mirror served stale/mutated metadata. `npm config get registry` and switch back to `https://registry.npmjs.org/`. |
| Update check fails offline | `furlpay update --check` needs registry access; it fails closed with a message and changes nothing. |

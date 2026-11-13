# Releasing @furlpay/cli

Everything below the version bump is automated by
`.github/workflows/release.yml` (tag-triggered) and
`.github/workflows/publish-mcp.yml` (MCP Registry metadata).

## Release flow

```
Developer changes
      |
      v
Pull request → CI (3 OSes × Node 22/24: typecheck, build, tests, npm pack)
      |
      v
Merge to main
      |
      v
Bump version (package.json + server.json — scripts/build.js enforces the match)
      |
      v
git tag vX.Y.Z && git push origin vX.Y.Z
      |
      v
Release workflow
      ├── verify:   version gate · typecheck · build · tests · pack · tarball check · SBOM
      ├── smoke:    tarball install on ubuntu/macos/windows · CLI boot · MCP handshake
      ├── release:  GitHub Release (tarball, checksums.txt, SBOM, attestations)
      └── publish-npm: npm publish with provenance → registry availability check
```

A failed gate anywhere prevents both the GitHub Release and the npm publish.
`publish-mcp.yml` pushes `server.json` to the MCP Registry using GitHub OIDC;
`scripts/build.js` version-locks `server.json` to `package.json`, so the two
registries can never diverge.

## One-time setup (maintainer, external)

**npm trusted publishing (preferred, no long-lived tokens):**

1. On npmjs.com → package `@furlpay/cli` → *Package settings → Trusted
   Publisher*, add: repository `FurlPay/furlpay-cli`, workflow `release.yml`,
   environment `npm`. (Until the package settings UI allows it pre-publish,
   run the first publish with a token — see below.)
2. On GitHub → repo → *Settings → Environments* → create `npm`
   (optionally protect it with required reviewers).

**Alternative — granular publish token:**

1. npmjs.com → *Access Tokens → Generate new token → Granular*, scoped to
   `@furlpay/cli`, packages: read-and-write.
2. GitHub → repo → *Settings → Secrets and variables → Actions*:
   secret `NPM_PUBLISH_TOKEN` = the token; variable `NPM_PUBLISH_MODE` = `token`.

## Cutting a release

```bash
# 1. Update CHANGELOG.md (top section = the new version).
# 2. Bump the version in BOTH package.json and server.json (must match):
npm version 0.4.1 --no-git-tag-version
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('server.json'));j.version='0.4.1';j.packages[0].version='0.4.1';fs.writeFileSync('server.json',JSON.stringify(j,null,2)+'\n')"
# 3. Commit the bump, then tag EXACTLY the package version:
git commit -am "chore(release): v0.4.1"
git push origin main
git tag v0.4.1
git push origin v0.4.1
# 4. Watch: https://github.com/FurlPay/furlpay-cli/actions
```

Never re-tag: if the pipeline fails, fix forward with a new version. A tag
whose `vX.Y.Z` does not match `package.json` fails at the version gate.

## What the pipeline publishes

| Asset | Where | Verification |
|---|---|---|
| `furlpay-cli-X.Y.Z.tgz` | GitHub Release + npm | sha512 enforced by npm on every install |
| `checksums.txt` | GitHub Release | SHA-256 of tarball + SBOM |
| `sbom.cdx.json` | GitHub Release | CycloneDX SBOM from the lockfile |
| Build provenance | GitHub attestations tab + npm provenance | sigstore; `gh attestation verify` |
| MCP Registry entry | registry.modelcontextprotocol.io | OIDC-bound to this repo |

## Post-release verification

```bash
npm view @furlpay/cli version                 # matches the tag
npm view @furlpay/cli@X.Y.Z dist.integrity    # provenance present
gh attestation verify --repo FurlPay/furlpay-cli <asset-file>
furlpay update --check                        # CLI sees the new version
```

## Manual fallback (incidents only)

If Actions is down, publish from a clean, pushed, CI-green commit:

```bash
npm run verify && npm test && npm pack && npm publish --access public --provenance
```

and upload the same tarball + fresh checksums to a GitHub Release manually.
Record the deviation in the release notes.

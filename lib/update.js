"use strict";
// furlpay update — installation-aware self-update.
//
// Design invariants (see docs/UPDATING.md):
//   * ZERO credential transmission: the registry check is an anonymous,
//     unauthenticated GET to registry.npmjs.org — no tokens, no session
//     cookies, no machine identifiers.
//   * ~/.furlpay (config, keystores, escrow ledger, sessions) is NEVER read
//     or written by an update. Package files and user state are disjoint.
//   * Updates only ever run through npm, which verifies the registry's
//     sha512 tarball integrity and manifest signatures before installing.
//     Nothing is downloaded or executed outside npm's verified path.
//   * No silent downgrades: pinning to an older version requires --yes.
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { c, loadConfig, confirm } = require("./util");

const PKG = require("../package.json");
const REGISTRY_URL = "https://registry.npmjs.org/@furlpay%2fcli";
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
const RELEASES_URL = "https://github.com/FurlPay/furlpay-cli/releases";

// ---------------------------------------------------------------------------
// npm plumbing
// ---------------------------------------------------------------------------

// Resolve npm without relying on PATH shims: the npm that ships with the
// running Node is <execDir>/node_modules/npm/bin/npm-cli.js on every
// supported platform. Falls back to "npm" on PATH for exotic installs.
function npmArgs() {
  const bundled = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  try {
    fs.accessSync(bundled);
    return [process.execPath, bundled];
  } catch {
    return process.platform === "win32" ? ["npm.cmd"] : ["npm"];
  }
}

function npmRun(args, { capture = false } = {}) {
  const [cmd, ...pre] = npmArgs();
  return spawnSync(cmd, [...pre, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function npmGlobalPrefix() {
  const res = npmRun(["prefix", "-g"], { capture: true });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.trim();
}

function npmConfigRegistry() {
  const res = npmRun(["config", "get", "registry"], { capture: true });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.trim();
}

// ---------------------------------------------------------------------------
// Install-method detection
// ---------------------------------------------------------------------------

function detectInstallMethod() {
  let binPath = null;
  try {
    binPath = fs.realpathSync(process.argv[1] || "");
  } catch {
    binPath = process.argv[1] || null;
  }
  const prefix = npmGlobalPrefix();
  if (prefix) {
    let prefixReal = prefix;
    try {
      prefixReal = fs.realpathSync(prefix);
    } catch {
      /* keep as-is */
    }
    if (binPath && prefixReal && binPath.startsWith(prefixReal + path.sep)) {
      return { method: "npm-global", binPath, prefix: prefixReal };
    }
  }
  if (binPath && binPath.includes(`${path.sep}_npx${path.sep}`)) {
    return { method: "npx", binPath, prefix: null };
  }
  if (binPath && /homebrew|Cellar/.test(binPath)) {
    return { method: "homebrew", binPath, prefix: null };
  }
  return { method: "unknown", binPath, prefix };
}

// ---------------------------------------------------------------------------
// Registry metadata (anonymous, no credentials)
// ---------------------------------------------------------------------------

async function fetchDistTags() {
  const res = await fetch(REGISTRY_URL, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`registry responded HTTP ${res.status}`);
  const doc = await res.json();
  const tags = (doc && doc["dist-tags"]) || {};
  if (!tags.latest) throw new Error("registry metadata missing dist-tags.latest");
  return tags;
}

// The abbreviated registry document also carries per-version `engines`, which
// lets us warn BEFORE npm installs a version the current runtime can't run.
async function fetchVersionEngines(version) {
  try {
    const res = await fetch(`${REGISTRY_URL}/${version}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const meta = await res.json();
    return (meta && meta.engines && meta.engines.node) || null;
  } catch {
    return null; // advisory only — npm enforces engines authoritatively
  }
}

// ---------------------------------------------------------------------------
// Minimal semver (no new dependency): compare dotted numeric + prerelease.
// ---------------------------------------------------------------------------

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0; // unparseable → treat as equal; caller decides
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  const ra = pa.prerelease;
  const rb = pb.prerelease;
  if (ra.length === 0 && rb.length === 0) return 0;
  if (ra.length === 0) return 1; // release > prerelease
  if (rb.length === 0) return -1;
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== null) return -1; // numeric < alphanumeric
    else if (ny !== null) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Engine floor from a version's `engines.node` (handles ">=22.19.0"-style).
function nodeFloor(range) {
  if (!range) return null;
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(range));
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3] || 0}`;
}

function runtimeSatisfies(floor) {
  const pf = parseSemver(floor);
  const pr = parseSemver(process.version);
  if (!pf || !pr) return true;
  return compareSemver(`${pr.major}.${pr.minor}.${pr.patch}`, `${pf.major}.${pf.minor}.${pf.patch}`) >= 0;
}

// ---------------------------------------------------------------------------
// Command entry: furlpay update [--check] [--latest] [--version X]
//                          [--channel stable|beta] [--yes]
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(c.red("✗ " + msg));
  process.exit(1);
}

// `furlpay config set update.check false` stores the FLAT key "update.check"
// (generic config set has no nested-key support), so read both spellings.
function setting(cfg, key, dflt) {
  if (cfg[`update.${key}`] !== undefined) return String(cfg[`update.${key}`]);
  if (cfg.update && typeof cfg.update === "object" && cfg.update[key] !== undefined) {
    return String(cfg.update[key]);
  }
  return dflt;
}

async function run(flags) {
  const cfg = loadConfig();
  const current = PKG.version;

  let tags;
  try {
    tags = await fetchDistTags();
  } catch (e) {
    return fail(`Could not reach the npm registry (${e.message}). Check connectivity and retry.`);
  }

  const channel = String(flags.channel || setting(cfg, "channel", "stable")).toLowerCase();
  if (channel !== "stable" && channel !== "beta") {
    return fail("Invalid channel — use --channel stable or --channel beta (or `furlpay config set update.channel beta`).");
  }

  let target;
  if (flags.version) {
    target = String(flags.version).replace(/^v/, "");
  } else if (flags.latest) {
    target = tags.latest;
  } else {
    target = channel === "beta" ? tags.beta || tags.latest : tags.latest;
    if (channel === "beta" && !tags.beta) {
      console.log(c.yellow("! No `beta` dist-tag exists — falling back to stable latest."));
    }
  }
  if (!parseSemver(target)) return fail(`\`${target}\` is not a valid semantic version.`);

  const latestStable = tags.latest;
  const cmp = compareSemver(target, current);

  // --check: report only, never mutate.
  if (flags.check) {
    console.log(c.bold("FurlPay CLI Update Check"));
    console.log(`  Installed version:  ${c.cyan(current)}`);
    console.log(`  Latest stable:      ${c.cyan(latestStable)}`);
    if (tags.beta) console.log(`  Beta channel:       ${c.dim(tags.beta)}`);
    console.log(`  Channel:            ${channel}`);
    if (cmp > 0) {
      console.log(`\n  ${c.green("A new version is available.")}`);
      console.log(`  Run:  ${c.bold("furlpay update")}${channel === "beta" ? " --channel beta" : ""}`);
    } else if (cmp === 0) {
      console.log(`\n  ${c.green("✓ Up to date.")}`);
    } else {
      console.log(`\n  ${c.yellow(`! Installed ${current} is newer than channel target ${target}.`)}`);
    }
    console.log(c.dim(`\n  Release notes: ${RELEASES_URL}`));
    return;
  }

  if (cmp === 0) {
    console.log(`${c.green("✓")} Already running ${c.bold("v" + target)} — nothing to do.`);
    console.log(c.dim("  Config, wallets and the escrow ledger under ~/.furlpay are never touched by updates."));
    return;
  }

  const install = detectInstallMethod();

  // Pre-flight: does the target version's engines.node accept this runtime?
  // (Advisory — npm enforces engines authoritatively at install time.)
  const enginesRange = await fetchVersionEngines(target);
  const floor = nodeFloor(enginesRange);
  if (floor && !runtimeSatisfies(floor)) {
    console.log(c.yellow(`! v${target} requires Node ${enginesRange} — this machine runs ${process.version}.`));
    console.log(c.yellow("  npm will refuse (EBADENGINE) or the CLI will misbehave. Upgrade Node first:"));
    console.log(c.dim("    https://nodejs.org/en/download  (or use nvm/fnm/volta)"));
    return process.exit(1);
  }

  if (install.method !== "npm-global") {
    console.error(c.yellow(`! Update is only supported for npm global installs (detected: ${install.method || "unknown"}).`));
    if (install.method === "npx") {
      console.log(`  npx caches per-run — just keep using ${c.bold("npx @furlpay/cli@latest")}, or install globally:`);
    } else {
      console.log("  To update manually:");
    }
    console.log(`    ${c.bold("npm install -g @furlpay/cli@" + target)}`);
    if (install.method === "homebrew") console.log(`    ${c.dim("# or: brew upgrade furlpay")}`);
    return process.exit(1);
  }

  if (cmp < 0) {
    console.log(c.yellow(`! ${target} is OLDER than the installed ${current} — this is a downgrade/pin.`));
    const ok = await confirm(`  Pin @furlpay/cli to v${target}?`, flags);
    if (!ok) return console.log("Aborted — no changes made.");
  } else {
    const ok = await confirm(`Update @furlpay/cli v${current} → v${target}? (config & wallets preserved)`, flags);
    if (!ok) return console.log("Aborted — no changes made.");
  }

  const registry = npmConfigRegistry();
  if (registry && registry.replace(/\/$/, "") !== OFFICIAL_REGISTRY.replace(/\/$/, "")) {
    console.log(c.yellow(`! npm registry is ${registry} (not the official ${OFFICIAL_REGISTRY}).`));
    console.log(c.dim("  npm still verifies each tarball's sha512 integrity against the manifest it fetches from that registry."));
  }

  console.log(`${c.bold("npm install -g @furlpay/cli@" + target)} …\n`);
  const res = npmRun(["install", "-g", `@furlpay/cli@${target}`]);
  if (res.status !== 0) {
    console.error(c.red(`✗ npm exited with status ${res.status}. The previous install is unchanged.`));
    console.error(c.dim(`  If npm reported a partial state, restore with:  npm install -g @furlpay/cli@${current}`));
    return process.exit(1);
  }

  // Post-install verification: confirm what npm actually laid down.
  const ls = npmRun(["ls", "-g", "@furlpay/cli", "--depth=0", "--json"], { capture: true });
  let installed = null;
  try {
    installed = JSON.parse(ls.stdout).dependencies["@furlpay/cli"].version;
  } catch {
    /* fall through to warning */
  }
  if (installed !== target) {
    console.error(c.red(`✗ Verification failed: npm reports @furlpay/cli@${installed ?? "unknown"}, expected ${target}.`));
    console.error(c.dim(`  Rollback:  npm install -g @furlpay/cli@${current}`));
    return process.exit(1);
  }

  console.log(`\n${c.green("✓")} Updated ${c.dim("v" + current)} → ${c.bold("v" + installed)}`);
  console.log(c.dim("  ~/.furlpay (config, keystores, escrow ledger) was not touched."));
  console.log(`  Rollback, if ever needed:  ${c.dim(`npm install -g @furlpay/cli@${current}`)}`);
  console.log(c.dim(`  Release notes: ${RELEASES_URL}`));
}

module.exports = { run, detectInstallMethod, fetchDistTags, compareSemver, npmGlobalPrefix, npmConfigRegistry, setting };

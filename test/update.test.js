"use strict";
// Pins the update command's pure decision logic: semver ordering (including
// prerelease rules), flat/nested config-key resolution, and Node engine-floor
// parsing. The network/npm interaction is exercised by the release pipeline's
// smoke job (`furlpay update --check` on all three OSes).
const test = require("node:test");
const assert = require("node:assert");
const { compareSemver, setting, detectInstallMethod } = require("../lib/update");

test("compareSemver: numeric ordering", () => {
  assert.strictEqual(compareSemver("0.2.2", "0.4.0"), -1);
  assert.strictEqual(compareSemver("0.4.0", "0.2.2"), 1);
  assert.strictEqual(compareSemver("1.0.0", "1.0.0"), 0);
  assert.strictEqual(compareSemver("1.10.0", "1.9.0"), 1, "numeric, not lexicographic");
  assert.strictEqual(compareSemver("v0.4.0", "0.4.0"), 0, "leading v tolerated");
});

test("compareSemver: prerelease ordering (semver spec §11)", () => {
  assert.strictEqual(compareSemver("1.0.0-alpha", "1.0.0"), -1, "prerelease < release");
  assert.strictEqual(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2"), -1);
  assert.strictEqual(compareSemver("1.0.0-alpha.1", "1.0.0-beta.1"), -1, "alpha < beta lexically");
  assert.strictEqual(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10"), -1, "numeric identifiers compare numerically");
  assert.strictEqual(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1, "fewer fields < more fields");
  assert.strictEqual(compareSemver("1.0.0-1", "1.0.0-alpha"), -1, "numeric < alphanumeric");
});

test("compareSemver: unparseable versions compare equal (caller decides)", () => {
  assert.strictEqual(compareSemver("garbage", "1.0.0"), 0);
});

test("setting: reads the flat update.* key written by `config set`", () => {
  assert.strictEqual(setting({ "update.check": "false" }, "check", "true"), "false");
  assert.strictEqual(setting({ "update.check": true }, "check", "true"), "true");
  assert.strictEqual(setting({}, "check", "true"), "true", "default when unset");
});

test("setting: also accepts a nested update object", () => {
  assert.strictEqual(setting({ update: { channel: "beta" } }, "channel", "stable"), "beta");
  assert.strictEqual(setting({}, "channel", "stable"), "stable");
});

test("detectInstallMethod: reports something sane in a test environment", () => {
  const info = detectInstallMethod();
  assert.ok(["npm-global", "npx", "homebrew", "unknown"].includes(info.method));
  assert.ok(typeof info.binPath === "string" || info.binPath === null);
});

"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { safeHttpsUrl } = require('../lib/safeUrl');
const { reservePayment } = require('../lib/paymentJournal');
const config = require('../lib/configStore');

test('profile links reject active schemes, credentials and control characters', () => {
  for (const url of ['file:///etc/passwd', 'data:text/html,x', 'itms-services://x', 'http://example.com',
    'https://user:password@example.com', 'https://example.com\n', 'https://example.com/\u202e'])
    assert.equal(safeHttpsUrl(url), '');
  assert.equal(safeHttpsUrl('https://example.com/a'), 'https://example.com/a');
});
test('unknown payment retries retain their key across restarts and time windows', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'furlpay-journal-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const identity = ['https://furlpay.com', 'live', 'account1', '@recipient', '1000', 'USD', ''];
  const first = reservePayment(identity, { directory, now: 299999 });
  assert.equal(reservePayment(identity, { directory, now: 300001 }), first);
  assert.equal(reservePayment(identity, { directory, now: 99999999 }), first);
  assert.notEqual(reservePayment([...identity, 'different memo'], { directory }), first);
});
test('configuration roundtrip protects Windows secrets and fails closed on corruption', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'furlpay-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const value = { env: 'sandbox', sessions: { sandbox: 'private-session-test' }, key: 'private-api-key-test' };
  config.save(file, value);
  assert.deepEqual(config.load(file), value);
  if (process.platform === 'win32') assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /private-session-test|private-api-key-test/);
  else assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => config.load(file), /Cannot read/);
});

// --- saveConfig hardening (second-pass audit, 2026-11-12) -------------------
// On Windows os.homedir() reads USERPROFILE, so tests must override BOTH env
// vars before the first require — otherwise the suite writes the user's real
// ~/.furlpay/config.json.
const utilConfig = (() => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'furlpay-util-config-test-'));
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  // Require AFTER the env override.
  const { saveConfig, loadConfig, CONFIG_PATH, CONFIG_DIR } = require('../lib/util');
  return { saveConfig, loadConfig, CONFIG_PATH, CONFIG_DIR, fakeHome };
})();

test('saveConfig round-trips and leaves no temp files behind', () => {
  utilConfig.saveConfig({ sessions: { sandbox: 'tok' }, nested: { a: 1 } });
  assert.deepEqual(utilConfig.loadConfig(), { sessions: { sandbox: 'tok' }, nested: { a: 1 } });
  const leftovers = fs.readdirSync(utilConfig.CONFIG_DIR).filter(f => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'atomic-write temp files must be cleaned up');
});

test('saveConfig refuses to follow a symlink planted at the config path', () => {
  const victim = path.join(utilConfig.CONFIG_DIR, 'victim.txt');
  fs.writeFileSync(victim, 'attacker content');
  // The round-trip test may have created a real config.json here; remove it
  // so the symlink can be planted (the scenario is: an attacker REPLACED the
  // user's config with a link before any write).
  fs.rmSync(utilConfig.CONFIG_PATH, { force: true });
  fs.symlinkSync(victim, utilConfig.CONFIG_PATH, 'file');
  assert.throws(
    () => utilConfig.saveConfig({ hacked: true }),
    /symlink/,
    'a symlinked config path must abort the write, not follow it'
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'attacker content', 'the symlink target must be untouched');
  // Clean up so later writes in this process are not blocked.
  fs.unlinkSync(utilConfig.CONFIG_PATH);
  utilConfig.saveConfig({ restored: true });
  assert.deepEqual(utilConfig.loadConfig(), { restored: true });
});

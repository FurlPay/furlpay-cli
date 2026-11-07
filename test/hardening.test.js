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

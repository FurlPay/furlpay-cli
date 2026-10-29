"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { demoQuote } = require('../lib/payDemo');
const { rawRequest } = require('../lib/api');
const cli = path.join(__dirname, '../bin/furlpay.js');
const launch = (args, env) => new Promise(resolve => execFile(process.execPath, [cli, ...args], {
  env: { ...process.env, ...env }, timeout: 10000, windowsHide: true,
}, (error, stdout, stderr) => resolve({ code: error?.code || 0, stdout, stderr })));

test('CLI integration: quote, execute, JSON, origin credentials, and API failures', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'furlpay-test-'));
  const env = { HOME: home, USERPROFILE: home, NO_COLOR: '' };
  const requests = [];
  let behavior = 'success';
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    requests.push({ path: req.url, body: JSON.parse(data || '{}'), cookie: req.headers.cookie });
    res.setHeader('Content-Type', 'application/json');
    if (behavior === 'unauthorized') { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (behavior === 'malformed') { res.writeHead(200); return res.end('not json'); }
    if (behavior === 'oversized') return res.end(JSON.stringify({ data: 'x'.repeat(1100000) }));
    if (req.url.endsWith('/quote')) {
      const q = demoQuote(); q.recipient.handle = '@recipient';
      q.quoteId = 'quote_test'; q.expiresAt = new Date(Date.now() + 60000).toISOString();
      q.sourceAccount.id = 'account_real'; q.sourceAccount.isAuthoritative = true;
      q.settlement.mode = 'sandbox'; return res.end(JSON.stringify(q));
    }
    if (behavior === 'disconnect') { req.socket.destroy(); return; }
    if (behavior === 'server_error') { res.writeHead(500); return res.end('{"error":"unavailable"}'); }
    res.end(JSON.stringify({ status: 'completed', transferId: 'tr_http_real', ledgerTxId: 'ledger_real', settledAt: new Date().toISOString(), amount: 10, currency: 'USD', totpSecret: 'NEVER_PRINT' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  await fs.mkdir(path.join(home, '.furlpay'));
  await fs.writeFile(path.join(home, '.furlpay/config.json'), JSON.stringify({
    env: 'sandbox', sandboxUrl: base, sessions: { sandbox: 'test_session_only' },
  }));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    // The deletion target is the exact directory created by mkdtemp above.
    assert.ok(path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(home, { recursive: true, force: true });
  });
  await t.test('headless payment requires consent before any request', async () => {
    const result = await launch(['pay', '@recipient', '10', '--json'], env);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error, 'confirmation_required');
    assert.equal(requests.length, 0);
  });
  await t.test('real HTTP request carries the reviewed quote and stable key', async () => {
    const result = await launch(['pay', '--yes', '@recipient', '10', 'usd', '--json', '--idempotency-key', 'integration_key'], env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).transferId, 'tr_http_real');
    assert.doesNotMatch(result.stdout, /NEVER_PRINT|\x1b/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].cookie, 'furlpay_session=test_session_only');
    assert.equal(requests[1].body.quoteId, 'quote_test');
    assert.equal(requests[1].body.idempotencyKey, 'integration_key');
  });
  await t.test('dry-run never calls execute', async () => {
    requests.length = 0;
    const result = await launch(['pay', '--dry-run', '@recipient', '10', '--json'], env);
    assert.equal(JSON.parse(result.stdout).status, 'quoted');
    assert.equal(requests.length, 1); assert.match(requests[0].path, /quote$/);
  });
  for (const value of ['unauthorized', 'malformed', 'oversized', 'disconnect', 'server_error']) {
    await t.test('fail closed on ' + value, async () => {
      behavior = value; requests.length = 0;
      const result = await launch(['pay', '@recipient', '10', '--yes', '--json'], env);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      const body = JSON.parse(result.stdout);
      assert.equal(body.transferId, undefined);
      assert.notEqual(body.status, 'completed');
      assert.ok(requests.length <= 2);
    });
  }
  await t.test('demo remains offline with a configured session', async () => {
    requests.length = 0;
    const result = await launch(['pay', '--demo'], env);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /SAMPLE DATA/);
    assert.doesNotMatch(result.stdout, /\x1b/);
    assert.equal(requests.length, 0);
  });
});
test('transport rejects cleartext remote origins, cross-origin paths, and URL credentials', () => {
  for (const [target, base, env] of [
    ['/api/test', 'http://example.com', 'sandbox'],
    ['https://attacker.example/api/test', 'https://furlpay.com', 'live'],
    ['/api/test', 'https://user:password@example.com', 'live'],
    ['/api/test', 'http://localhost:8787', 'live'],
  ]) assert.throws(() => rawRequest('GET', target, { flags: { 'api-base': base, env } }));
});

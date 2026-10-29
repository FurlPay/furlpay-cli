"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseAmount, validateInput, validateQuote, quoteExpiry, receipt, executeA2APay, confirmPayment } = require('../lib/payTui');
const { renderPayment } = require('../lib/payView');
const { demoQuote } = require('../lib/payDemo');
const { width, sanitize, colorLevel } = require('../lib/terminal');
const { parseFlags, positionals } = require('../lib/util');

function quote() {
  const q = demoQuote();
  q.quoteId = 'quote_test';
  q.recipient.handle = '@recipient';
  q.sourceAccount.id = 'account_test';
  q.sourceAccount.isAuthoritative = true;
  q.settlement.mode = 'sandbox';
  q.expiresAt = new Date(Date.now() + 60000).toISOString();
  return q;
}
const input = { recipient: '@recipient', amount: 10, currency: 'USD' };
async function flow({ flags = {}, q = quote(), response, confirm = async () => true, error, advance = false } = {}) {
  const calls = [], output = [], diagnostics = [];
  const before = process.exitCode;
  let tick = 0;
  try {
    const result = await executeA2APay(['@recipient', '10', 'USD'], flags, {
      call: async (method, path, options) => {
        calls.push({ method, path, ...options });
        if (path.endsWith('/quote')) return q;
        if (error) throw error;
        return response || { status: 'completed', transferId: 'tr_real', ledgerTxId: 'ledger_real', settledAt: new Date().toISOString(), amount: 10, currency: 'USD' };
      },
      now: () => Date.now() + (advance && tick++ ? 120000 : 0),
      write: s => output.push(s), diagnostic: s => diagnostics.push(s), confirm,
    });
    return { result, calls, output: output.join(''), diagnostics, exitCode: process.exitCode };
  } finally { process.exitCode = before; }
}
test('decimal parser accepts exact cents and boundaries', () => {
  assert.equal(parseAmount('0.01').cents, 1n);
  assert.equal(parseAmount('10.10').cents, 1010n);
  assert.equal(parseAmount('10000000').decimal, 10000000);
});
for (const value of ['0', '-1', '1e3', 'Infinity', 'NaN', '10usd', '01', '1.001', '10000000.01', '', '.1']) {
  test('reject invalid amount ' + JSON.stringify(value), () => assert.throws(() => parseAmount(value)));
}
test('boolean flags do not consume the recipient or amount', () => {
  for (const argv of [
    ['--yes', '@recipient', '10', 'USD'], ['@recipient', '--dry-run', '10', 'USD'],
    ['-y', '@recipient', '10', 'USD'], ['--json', '@recipient', '10', '--env', 'live', 'USD'],
  ]) assert.deepEqual(positionals(argv), ['@recipient', '10', 'USD']);
  assert.equal(parseFlags(['--yes', '@recipient']).yes, true);
  assert.equal(parseFlags(['--yes=false']).yes, 'false');
});
test('pay validation rejects automation ambiguity and shifted PowerShell input', () => {
  for (const [args, flags] of [
    [['10', 'USD'], {}], [['@r', '10'], {}], [['@recipient', '1', 'SOL'], {}],
    [['@recipient', '10'], { agent: true }], [['@recipient', '10'], { yes: 'false' }],
    [['@recipient', '10'], { 'idempotency-key': true }], [[], { demo: true, yes: true }],
    [['@recipient', '10'], { width: '10000' }], [['@recipient', '10'], { env: 'oops' }],
  ]) assert.throws(() => validateInput(args, flags));
});
test('quote binds recipient, amount, currency, authoritative account and compliance', () => {
  for (const edit of [
    q => q.amount.decimal++, q => q.amount.currency = 'SOL', q => q.amount.fee = -1,
    q => q.recipient.handle = '@attacker', q => q.recipient.kybStatus = 'pending',
    q => q.recipient.kybExpiresAt = 'invalid', q => q.recipient.sanctionsStatus = 'review',
    q => q.recipient.sanctionsStatus = undefined, q => q.sourceAccount.isAuthoritative = false,
    q => q.sourceAccount.balanceUsd = 1, q => q.isFixture = true,
    q => q.settlement.supportedChains = 'Base', q => q.expiresAt = 'invalid',
  ]) { const q = quote(); edit(q); assert.throws(() => validateQuote(q, input)); }
  assert.throws(() => validateQuote(quote(), input, Date.now(), 'live'));
  assert.ok(validateQuote(quote(), input));
});
test('older signed quote TTL takes precedence over advertised expiry', () => {
  const q = quote();
  q.quoteId = 'quo_furl_' + (Date.now() - 1) + '_signature';
  assert.ok(quoteExpiry(q) < Date.now());
  assert.throws(() => validateQuote(q, input), /expired/);
});
test('cancel and dry-run never execute', async () => {
  for (const options of [{ confirm: async () => false }, { flags: { 'dry-run': true, json: true } }]) {
    const f = await flow(options);
    assert.equal(f.calls.length, 1);
    assert.notEqual(f.result.status, 'completed');
  }
});
test('quote expiry during confirmation cannot send', async () => {
  const f = await flow({ advance: true });
  assert.equal(f.result.error, 'quote_expired');
  assert.equal(f.calls.length, 1);
});
test('execution preserves quote, source, idempotency and exact amount', async () => {
  const f = await flow({ flags: { yes: true, json: true, 'idempotency-key': 'stable_key_123', memo: 'Invoice 10' } });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].body.quoteId, 'quote_test');
  assert.equal(f.calls[1].body.sourceFinancialAccount, 'account_test');
  assert.equal(f.calls[1].body.idempotencyKey, 'stable_key_123');
  assert.equal(f.calls[1].headers['Idempotency-Key'], 'stable_key_123');
  assert.equal(f.calls[1].body.amount, 10);
  assert.equal(f.calls[1].body.memo, 'Invoice 10');
  assert.equal(JSON.parse(f.output).status, 'completed');
});
test('fresh payment keys are cryptographically generated UUIDs', async () => {
  const f = await flow();
  assert.match(f.result.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test('pending and approvals are never described as settled', async () => {
  for (const response of [{ status: 'pending', transferId: 'tr_pending' },
    { status: 'requires_approval', approvalId: 'appr_real', approvalUrl: '/dashboard/approvals/appr_real' }]) {
    const f = await flow({ response, flags: { json: true } });
    assert.equal(f.result.status, response.status);
    assert.doesNotMatch(f.output, /settled|completed/);
  }
});
test('malformed receipts and transport errors are unknown outcomes, never retried', async () => {
  for (const opts of [{ response: { status: 'completed' } }, { response: { status: 'success', transferId: 'x' } },
    { error: new Error('socket closed') }, { error: Object.assign(new Error('server failed'), { status: 500 }) },
    { response: { status: 'completed', transferId: 'tr_wrong', amount: 99 } }]) {
    const f = await flow(opts);
    assert.equal(f.result.status, 'unknown');
    assert.equal(f.exitCode, 1);
    assert.equal(f.calls.length, 2);
    assert.match(f.result.message, /Reconcile/);
    assert.ok(f.result.idempotencyKey);
  }
});
test('API rejections have a nonzero exit and no invented transfer', async () => {
  for (const status of [401, 403, 404, 422]) {
    const f = await flow({ error: Object.assign(new Error('denied'), { status }) });
    assert.equal(f.result.status, 'failed');
    assert.equal(f.exitCode, 1);
    assert.equal(f.result.transferId, undefined);
  }
});
test('receipt output excludes arbitrary secrets and false success states', () => {
  const r = receipt({ status: 'completed', transferId: 'tr_real', ledgerTxId: 'ledger_real', settledAt: new Date().toISOString(), totpSecret: 'DO_NOT_PRINT', session: 'secret' });
  assert.equal(r.totpSecret, undefined);
  assert.equal(r.session, undefined);
  assert.throws(() => receipt({ status: 'failed', transferId: 'tr_failed' }));
});
test('terminal sanitizer removes OSC, CSI, controls, newlines and direction overrides', () => {
  const value = 'A\x1b]52;c;clipboard\x07B\x1b[2JC\u202eD\nE\x9b31mF\x1bPpayload\x1b\\G';
  assert.equal(sanitize(value), 'ABCD EFG');
});
test('color detection honors NO_COLOR presence, dumb terminals and pipes', () => {
  for (const value of ['', '0', '1']) assert.equal(colorLevel({ NO_COLOR: value, COLORTERM: 'truecolor' }, true), 0);
  assert.equal(colorLevel({ COLORTERM: 'truecolor' }, false), 0);
  assert.equal(colorLevel({ TERM: 'dumb' }, true), 0);
  assert.equal(colorLevel({ COLORTERM: 'truecolor' }, true), 3);
  assert.equal(colorLevel({ TERM: 'xterm-256color' }, true), 2);
  assert.equal(colorLevel({ TERM: 'xterm' }, true), 1);
});
for (const columns of [12, 24, 37, 38, 40, 60, 74, 75, 80, 109, 110, 120, 160, 180]) {
  test('layout fits ' + columns + ' columns with long multilingual content', () => {
    const q = quote();
    q.recipient.displayName = '株式会社 Acme café ' + 'long '.repeat(20);
    q.recipient.bio = '界'.repeat(80) + '\x1b[2J\u202E';
    q.recipient.handle = '@abcdefghijklmnopqrstuvwxyz1234';
    q.sourceAccount.name = 'A very long business account that must remain readable';
    const view = renderPayment(q, { columns, colorLevel: 3 });
    assert.ok(view.split('\n').every(line => width(line) <= columns),
      view.split('\n').filter(line => width(line) > columns).join('\n'));
    assert.doesNotMatch(view, /\x1b\[2J|\u202E/);
    assert.match(view, /10.00 USD/);
  });
}
test('unverified status is never upgraded by renderer', () => {
  const q = quote(); q.recipient.kybStatus = 'pending'; q.recipient.sanctionsStatus = 'review';
  const view = renderPayment(q, { columns: 120, colorLevel: 0 });
  assert.doesNotMatch(view, /Verified business|KYB verified|Sanctions checked/);
  assert.match(view, /pending/);
  assert.match(view, /review/);
});
test('preview cannot make API calls or execute', async () => {
  let calls = 0; let text = '';
  await executeA2APay([], { demo: true }, { call: async () => calls++, write: s => text += s });
  assert.equal(calls, 0);
  assert.match(text, /SAMPLE DATA/);
  assert.match(text, /no funds will move/);
});
function keyboard() {
  const input = new EventEmitter();
  input.isTTY = true; input.isRaw = false; input.paused = true;
  input.isPaused = () => input.paused;
  input.pause = () => { input.paused = true; };
  input.resume = () => { input.paused = false; };
  input.setRawMode = value => { input.isRaw = value; };
  return input;
}
test('single key confirmation restores input and removes listeners', async () => {
  for (const key of ['y', 'n', '\r', '\x1b', '\x03']) {
    const input = keyboard();
    const promise = confirmPayment({ input, expiresAt: Date.now() + 1000 });
    input.emit('data', Buffer.from(key));
    assert.equal(await promise, key === 'y');
    assert.equal(input.isRaw, false); assert.equal(input.paused, true);
    assert.equal(input.listenerCount('data'), 0);
  }
});
test('pasted confirmation is ignored; EOF and expiry cancel safely', async () => {
  const input = keyboard();
  const promise = confirmPayment({ input, expiresAt: Date.now() + 1000 });
  input.emit('data', Buffer.from('yes\n'));
  assert.equal(input.isRaw, true);
  input.emit('end');
  assert.equal(await promise, false);
  assert.equal(await confirmPayment({ input: keyboard(), expiresAt: Date.now() + 5 }), false);
});

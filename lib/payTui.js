"use strict";
const { reservePayment } = require('./paymentJournal');
const api = require('./api');
const { loadConfig } = require('./util');
const { sanitize } = require('./terminal');
const { renderPayment } = require('./payView');

const HELP = [
  'Usage: furlpay pay <@recipient> <amount> [USD] [options]',
  '       furlpay pay --demo [--width 120]',
  '       furlpay pay <order-id>  (legacy order payment)',
  '',
  '  --dry-run          Fetch and display a real quote without executing',
  '  --yes              Explicitly confirm without a keyboard prompt',
  '  --output json      Machine-readable result (also --json)',
  '  --idempotency-key  Reuse a key when reconciling the same payment',
  '  --memo <text>      Payment memo, up to 500 characters',
  '  --env sandbox|live --api-base <url> --ascii --width <24..180>',
  '',
  "PowerShell: furlpay pay '@recipient' 10.00 USD",
  'Only USD A2A amounts are enabled until the backend supports token-specific units.',
  'Preview mode is offline, visibly labeled, and cannot execute payments.',
].join('\n');
function fail(message, code = 'payment_error') {
  const e = new Error(message); e.code = code; return e;
}
function parseAmount(value) {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(String(value)))
    throw fail('Use a positive decimal amount with at most two decimal places.', 'invalid_amount');
  const [whole, fraction = ''] = String(value).split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > 1000000000n)
    throw fail('Amount must be greater than zero and at most 10,000,000 USD.', 'invalid_amount');
  return { cents, decimal: Number(cents) / 100 };
}
function validateInput(args, flags) {
  const allowed = new Set(['yes', 'y', 'json', 'output', 'dry-run', 'memo', 'idempotency-key',
    'env', 'api-base', 'demo', 'ascii', 'width', 'help', 'h']);
  for (const key of Object.keys(flags)) if (!allowed.has(key))
    throw fail('Unsupported payment option: --' + sanitize(key), 'invalid_option');
  for (const key of ['yes', 'y', 'json', 'dry-run', 'demo', 'ascii', 'help', 'h'])
    if (flags[key] !== undefined && flags[key] !== true) throw fail('--' + key + ' is a boolean flag.', 'invalid_option');
  if (flags.output && !['json', 'table'].includes(flags.output)) throw fail('Payment output must be json or table.', 'invalid_option');
  if (flags.env && !['sandbox', 'live'].includes(flags.env)) throw fail('Environment must be sandbox or live.', 'invalid_option');
  if (flags.width !== undefined && (!/^\d+$/.test(String(flags.width)) || Number(flags.width) < 24 || Number(flags.width) > 180))
    throw fail('--width must be between 24 and 180.', 'invalid_option');
  if (flags.demo) {
    if (args.length || flags.yes || flags.y || flags.memo || flags['idempotency-key'] || flags['api-base'] || flags.env)
      throw fail('Run preview separately: furlpay pay --demo. It cannot be combined with payment arguments.', 'invalid_option');
    return null;
  }
  if (args.length < 2 || args.length > 3 || !/^@[a-zA-Z0-9_][a-zA-Z0-9_-]{1,29}$/.test(args[0]))
    throw fail("Use: furlpay pay '@recipient' 10.00 USD. Quote @handles in PowerShell to prevent splatting.", 'invalid_recipient');
  const currency = (args[2] || 'USD').toUpperCase();
  if (currency !== 'USD') throw fail('This A2A client currently supports USD only; token-specific settlement units are not verified.', 'unsupported_currency');
  if (flags.memo !== undefined && (typeof flags.memo !== 'string' || flags.memo.length > 500))
    throw fail('--memo must be text of at most 500 characters.', 'invalid_option');
  if (flags['idempotency-key'] !== undefined &&
      (typeof flags['idempotency-key'] !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(flags['idempotency-key'])))
    throw fail('--idempotency-key must contain 8–200 letters, digits, underscores or hyphens.', 'invalid_option');
  return { recipient: args[0].toLowerCase(), amount: parseAmount(args[1]).decimal, currency };
}
function quoteExpiry(q) {
  const explicit = Date.parse(q.expiresAt);
  // Older API versions advertise a longer expiresAt than the signed token TTL.
  const embedded = /^quo_furl_(\d+)_/.exec(q.quoteId || '');
  return Math.min(Number.isFinite(explicit) ? explicit : 0, embedded ? Number(embedded[1]) : Infinity);
}
function validateQuote(q, input, now = Date.now(), env = 'sandbox') {
  if (!q || typeof q !== 'object' || typeof q.quoteId !== 'string' || !q.quoteId || q.quoteId.length > 100 ||
      q.amount?.decimal !== input.amount || q.amount?.currency !== input.currency ||
      q.recipient?.handle !== input.recipient || !Number.isFinite(q.amount?.fee) || q.amount.fee < 0 ||
      q.amount.fee > 10000000)
    throw fail('API quote is incomplete or does not match the requested payment.', 'invalid_quote');
  if (quoteExpiry(q) <= now) throw fail('Payment quote expired. Request a new quote and review it again.', 'quote_expired');
  const p = q.recipient;
  if (typeof p.displayName !== 'string' || !p.displayName || p.displayName.length > 300 ||
      p.kybStatus !== 'verified' || p.sanctionsStatus !== 'clear' ||
      p.kybExpiresAt && !(Date.parse(p.kybExpiresAt) > now))
    throw fail('Recipient business verification or sanctions screening is not clear.', 'recipient_restricted');
  if (q.isFixture || p.isFixture || q.sourceAccount?.isAuthoritative !== true ||
      typeof q.sourceAccount.id !== 'string' || !q.sourceAccount.id || q.sourceAccount.id.length > 100 ||
      typeof q.sourceAccount.name !== 'string' || !Number.isFinite(q.sourceAccount.balanceUsd) ||
      q.sourceAccount.balanceUsd < 0)
    throw fail('An authenticated, authoritative source account is required. Run furlpay login.', 'account_required');
  if (!['live', 'sandbox'].includes(q.settlement?.mode) || env === 'live' && q.settlement.mode !== 'live')
    throw fail('Quote environment does not match live payment mode.', 'environment_mismatch');
  for (const value of [q.recipient.bio, q.recipient.url, q.recipient.legalName, q.sourceAccount.name,
    q.sourceAccount.type, q.settlement.rail, q.settlement.latency, q.settlement.frequency])
    if (value !== undefined && (typeof value !== 'string' || value.length > 2000))
      throw fail('API returned an invalid display field.', 'invalid_quote');
  if (q.settlement.supportedChains !== undefined &&
      (!Array.isArray(q.settlement.supportedChains) || q.settlement.supportedChains.length > 20 ||
       q.settlement.supportedChains.some(v => typeof v !== 'string' || v.length > 50)))
    throw fail('API returned invalid network metadata.', 'invalid_quote');
  if (q.sourceAccount.balanceUsd < input.amount + q.amount.fee)
    throw fail('The quoted account balance is insufficient for this payment and fee.', 'insufficient_funds');
  return q;
}
function confirmPayment({ input = process.stdin, expiresAt, onResize, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function')
    return Promise.reject(fail('Interactive confirmation requires a terminal. Use --dry-run or explicitly pass --yes.', 'confirmation_required'));
  return new Promise(resolve => {
    const wasRaw = !!input.isRaw;
    const wasPaused = input.isPaused();
    let timer;
    const finish = result => {
      clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onInterrupt);
      if (onResize) output.removeListener('resize', onResize);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      resolve(result);
    };
    const onData = data => {
      const key = data.toString();
      if (key === 'y' || key === 'Y') finish(true);
      else if (/^[nN\r\n\x1b\x03\x04]$/.test(key)) finish(false);
      // Pasted strings never authorize a payment.
    };
    const onEnd = () => finish(false);
    const onInterrupt = () => finish(false);
    input.setRawMode(true);
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    if (onResize) output.on('resize', onResize);
    timer = setTimeout(() => finish(false), Math.max(1, expiresAt - Date.now()));
    input.resume();
  });
}
function receipt(body) {
  if (!body || typeof body !== 'object') throw fail('Execution response is not a payment receipt.', 'unknown_outcome');
  if (['failed', 'rejected', 'cancelled'].includes(body.status))
    throw fail('Server reported payment ' + body.status + '.', 'payment_rejected');
  if (!['completed', 'settled', 'pending', 'processing', 'requires_approval'].includes(body.status))
    throw fail('Server did not confirm a recognized payment state.', 'unknown_outcome');
  const id = body.status === 'requires_approval' ? body.approvalId : body.transferId;
  if (typeof id !== 'string' || !id || id.length > 200)
    throw fail('Server returned no durable identifier for the payment state.', 'unknown_outcome');
  if (['completed', 'settled'].includes(body.status) &&
      (typeof body.ledgerTxId !== 'string' || !body.ledgerTxId || !Number.isFinite(Date.parse(body.settledAt))))
    throw fail('Settlement response has no ledger identifier and timestamp evidence.', 'unknown_outcome');
  // Only receipt fields are emitted; never dump an arbitrary response object.
  const result = { status: body.status };
  for (const key of ['transferId', 'approvalId', 'ledgerTxId', 'settledAt', 'rail', 'currency'])
    if (typeof body[key] === 'string') result[key] = sanitize(body[key]).slice(0, 200);
  if (typeof body.approvalUrl === 'string' && /^\/(?!\/)|^https:\/\//.test(body.approvalUrl))
    result.approvalUrl = sanitize(body.approvalUrl).slice(0, 1000);
  for (const key of ['amount', 'fee']) if (Number.isFinite(body[key])) result[key] = body[key];
  return result;
}
async function executeA2APay(args, flags = {}, dependencies = {}) {
  const request = dependencies.call || api.call;
  const write = dependencies.write || (text => process.stdout.write(text));
  const diagnostic = dependencies.diagnostic || (text => process.stderr.write(text));
  const now = dependencies.now || Date.now;
  const machine = flags.json === true || flags.output === 'json';
  let idempotencyKey, attempted = false;
  try {
    if (flags.help || flags.h) { write(HELP + '\n'); return; }
    const input = validateInput(args, flags);
    if (flags.demo) {
      const q = require('./payDemo').demoQuote();
      if (machine) write(JSON.stringify({ status: 'preview', sampleData: true, executable: false }) + '\n');
      else write(renderPayment(q, { demo: true, columns: Number(flags.width) || undefined, ascii: flags.ascii }));
      return { status: 'preview' };
    }
    if (!flags['dry-run'] && !flags.yes && !flags.y &&
        (machine || !process.stdin.isTTY || !process.stdout.isTTY) && !dependencies.confirm)
      throw fail('Payment needs explicit confirmation. Use --dry-run to review, or --yes to send.', 'confirmation_required');
    const env = api.currentEnv(loadConfig(), flags);
    if (!['sandbox', 'live'].includes(env)) throw fail('Invalid configured payment environment.', 'invalid_environment');
    const quote = validateQuote(await request('POST', '/api/v1/pay/quote', {
      flags, body: { ...input, dryRun: Boolean(flags['dry-run']) },
    }), input, now(), env);
    const view = () => renderPayment(quote, {
      columns: Number(flags.width) || undefined, ascii: flags.ascii,
      env, reviewOnly: !!flags['dry-run'],
    });
    if (!machine) write(view());
    if (flags['dry-run']) {
      const result = { status: 'quoted', recipient: input.recipient, amount: input.amount,
        currency: input.currency, fee: quote.amount.fee, expiresAt: new Date(quoteExpiry(quote)).toISOString() };
      if (machine) write(JSON.stringify(result) + '\n');
      return result;
    }
    const confirmed = flags.yes || flags.y || await (dependencies.confirm || confirmPayment)({
      expiresAt: quoteExpiry(quote), onResize: () => write(view()),
    });
    if (!confirmed) {
      const result = { status: 'cancelled' };
      write(machine ? JSON.stringify(result) + '\n' : 'Payment cancelled. No execution request sent.\n');
      return result;
    }
    validateQuote(quote, input, now(), env);
    idempotencyKey = flags['idempotency-key'] || (dependencies.reservePayment || reservePayment)([
      api.apiBase(loadConfig(), flags), env, quote.sourceAccount.id, input.recipient,
      parseAmount(String(input.amount)).cents.toString(), input.currency, flags.memo || '',
    ]);
    diagnostic('Payment request key: ' + idempotencyKey + '\n');
    attempted = true;
    const body = await request('POST', '/api/v1/pay/execute', {
      flags, headers: { 'Idempotency-Key': idempotencyKey },
      body: { ...input, quoteId: quote.quoteId, sourceFinancialAccount: quote.sourceAccount.id,
        idempotencyKey, ...(flags.memo !== undefined ? { memo: flags.memo } : {}) },
    });
    const result = { ...receipt(body), idempotencyKey };
    if (result.amount !== undefined && result.amount !== input.amount ||
        result.currency !== undefined && result.currency !== input.currency)
      throw fail('Receipt does not match the requested payment.', 'unknown_outcome');
    write(machine ? JSON.stringify(result) + '\n' :
      'Payment ' + result.status + '.\n' +
      (result.transferId ? 'Transfer: ' + result.transferId + '\n' : '') +
      (result.approvalId ? 'Approval: ' + result.approvalId + '\n' : '') +
      (result.approvalUrl ? 'Review: ' + result.approvalUrl + '\n' : ''));
    return result;
  } catch (error) {
    const uncertain = attempted && (!error.status || error.status >= 500) && error.code !== 'payment_rejected';
    const result = { status: uncertain ? 'unknown' : 'failed',
      error: sanitize(error.code || 'payment_error'), message: sanitize(error.message),
      ...(idempotencyKey ? { idempotencyKey } : {}) };
    if (uncertain) result.message += ' Do not start a new payment. Reconcile this request key with FurlPay before retrying.';
    write(machine ? JSON.stringify(result) + '\n' : 'Payment ' + result.status + ': ' + result.message + '\n');
    process.exitCode = 1;
    return result;
  }
}
module.exports = { HELP, parseAmount, validateInput, quoteExpiry, validateQuote, confirmPayment, receipt, executeA2APay };

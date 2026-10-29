"use strict";
const { sanitize, width, fit, wrap, palette, colorLevel, box, joinColumns } = require('./terminal');
const VERSION = require('../package.json').version;

function renderPayment(quote, options = {}) {
  const columns = Math.max(12, Math.min(180, options.columns || process.stdout.columns || 120));
  const size = columns - (columns >= 60 ? 2 : 0);
  const ascii = options.ascii ?? process.env.TERM === 'dumb';
  const t = palette(options.colorLevel ?? colorLevel());
  const check = ascii ? '+' : '✓';
  const sep = ascii ? '|' : '│';
  const p = quote.recipient;
  const a = quote.sourceAccount;
  const s = quote.settlement;
  const verified = p.kybStatus === 'verified' &&
    (!p.kybExpiresAt || Date.parse(p.kybExpiresAt) > (options.now || Date.now()));
  const safe = value => sanitize(value);
  const amount = quote.amount.decimal.toFixed(2) + ' ' + quote.amount.currency;
  const fee = quote.amount.fee === 0 ? 'Free' : quote.amount.fee.toFixed(2) + ' ' + quote.amount.currency;
  const balance = a.isAuthoritative && Number.isFinite(a.balanceUsd) || options.demo
    ? '$' + a.balanceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : 'Unavailable';
  const mode = options.demo ? 'Preview transfer' : s.mode === 'live' ? 'Live mode transfer' : 'Sandbox transfer';
  const network = options.demo ? 'Offline preview' : 'Quote received / ' + (options.env === 'live' ? 'Live' : 'Sandbox');
  const state = options.demo ? 'REFERENCE PREVIEW / SAMPLE DATA / NO PAYMENT' : check + ' Recipient found';
  const security = verified ? 'KYB verified' : 'KYB ' + safe(p.kybStatus || 'unknown');
  const sanctions = p.sanctionsStatus === 'clear' ? 'Sanctions checked' : 'Sanctions: ' + safe(p.sanctionsStatus || 'unknown');
  const pairs = [
    ['Amount', amount, t.teal], ['Fee', fee, t.mint],
    ['Timing', safe(s.latency || 'Not provided'), t.text],
    ['Frequency', safe(s.frequency || 'One-time'), t.text],
    ['From', safe(a.name), t.violet],
  ];
  const details = [
    ['From account', safe(a.name), safe(a.type || 'Business account')],
    ['Balance', balance, options.demo ? 'USD / sample balance' : 'USD / available'],
    ['Network', safe(s.rail || 'Not provided'), (s.supportedChains || []).map(safe).join(' / ')],
    ['Security', security, sanctions],
  ];
  const plain = [
    'FurlPay / v' + VERSION, 'A2A payments for the AI economy', network, state,
    ...pairs.map(([key, val]) => key + ': ' + val),
    'Recipient: ' + safe(p.displayName), safe(p.handle),
    verified ? '[Verified business]' : '[Business not verified]',
    safe(p.bio), safe(p.url),
    ...details.map(d => d.join(' / ')),
    options.demo ? 'Preview only. No funds move.' : options.reviewOnly ? 'Quote only. No funds moved.' : 'Confirm payment? y send / n cancel',
  ];
  if (size < 38) return plain.flatMap(line => wrap(line, size)).join('\n') + '\n';

  function panel(lines, panelSize, paint = t.border) { return box(lines, panelSize, paint, ascii); }
  function twoEnds(left, right, w) {
    if (width(left) + width(right) + 2 > w) return [left, right];
    return [left + ' '.repeat(w - width(left) - width(right)) + right];
  }
  function transfer(w) {
    const rows = [t.violet(t.bold(mode)), ''];
    for (const [label, value, paint] of pairs) {
      const labelSize = w >= 40 ? 13 : 10;
      rows.push(...wrap(value, w - labelSize).map((v, i) =>
        t.muted(fit(i ? '' : label, labelSize)) + paint(v)));
    }
    return rows;
  }
  function recipient(w) {
    const badge = verified ? '[' + check + ' Verified business]' : '[Not verified]';
    const nameLines = wrap(p.displayName, w);
    const heading = nameLines.length === 1
      ? twoEnds(t.bold(t.text(nameLines[0])), (verified ? t.mint : t.amber)(badge), w)
      : [...nameLines.map(v => t.bold(t.text(v))), (verified ? t.mint : t.amber)(badge)];
    return [
      ...heading,
      ...wrap(p.handle, w).map(t.muted), '',
      ...wrap(p.bio || p.legalName || 'Business directory profile', w).map(t.muted),
      ...wrap(p.url || 'Website not provided', w).map(t.blue),
    ];
  }
  let header;
  if (size >= 75) {
    const left = [
      t.mint(ascii ? ' [ F ] ' : ' ▗▄▄▄▖ ') + '  ' + t.bold(t.text('FurlPay')),
      t.mint(ascii ? ' [   ] ' : ' ▐▛▀   ') + '  ' + t.muted('A2A payments for the AI economy'),
      t.mint(ascii ? ' [___] ' : ' ▝▘    '),
    ];
    header = [twoEnds(left[0], t.muted('v' + VERSION), size)[0],
      ...twoEnds(left[1], t.muted(network), size), left[2]];
  } else header = [t.bold(t.text('FurlPay')) + t.muted(' / v' + VERSION),
    t.muted('A2A payments for the AI economy'), t.muted(network)];

  const inside = size - 4;
  let main;
  if (size >= 108) {
    const leftSize = Math.floor((inside - 3) / 2);
    const rightSize = inside - leftSize - 3;
    const right = [t.violet(t.bold('Recipient')), ...panel(recipient(rightSize - 4), rightSize)];
    main = joinColumns([transfer(leftSize), right], [leftSize, rightSize], ' ' + t.border(sep) + ' ');
  } else {
    main = [...transfer(inside), '', t.violet(t.bold('Recipient')),
      ...panel(recipient(inside - 4), inside)];
  }
  const count = size >= 108 ? 4 : size >= 73 ? 2 : 1;
  const detailWidth = inside - 4;
  const cardSize = Math.floor((detailWidth - (count - 1)) / count);
  const detailRows = [t.muted('Payment details')];
  for (let i = 0; i < details.length; i += count) {
    const group = details.slice(i, i + count);
    const sizes = group.map((_, n) => n === count - 1 ? detailWidth - (cardSize + 1) * n : cardSize);
    const bodies = group.map((d, n) => [
      ...wrap(d[0], sizes[n] - 4).map(t.muted),
      ...wrap(d[1], sizes[n] - 4).map(v => t.bold(t.text(v))),
      ...wrap(d[2], sizes[n] - 4).map(t.muted),
    ]);
    const height = Math.max(...bodies.map(b => b.length));
    const cards = bodies.map((b, n) => panel([...b, ...Array(height - b.length).fill('')], sizes[n]));
    detailRows.push(...joinColumns(cards, sizes));
  }
  main.push('', ...panel(detailRows, inside));
  const left = t.teal(t.bold(options.demo ? 'Reference preview / no funds will move' :
    options.reviewOnly ? 'Quote only / no funds moved' : 'Confirm and send this payment?'));
  const right = options.demo ? t.muted('Read-only') : options.reviewOnly ? t.muted('Review only') :
    t.muted('Press ') + t.teal('y') + t.muted(' to send / ') + t.red('n') + t.muted(' to cancel');
  const result = [
    '', ...header,
    ...panel(wrap(state, size - 4).map(t.mint), size, t.mint), '',
    ...panel(main, size, t.violet), '',
    ...panel(twoEnds(left, right, size - 4), size, t.mint), '',
  ];
  return result.join('\n') + '\n';
}
module.exports = { renderPayment };

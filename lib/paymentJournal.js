"use strict";
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Pending requests survive time windows and process restarts. Never store cookies.
function reservePayment(identity, options = {}) {
  const directory = options.directory || path.join(os.homedir(), '.furlpay', 'payment-requests');
  const now = options.now ?? Date.now();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const file = path.join(directory, fingerprint + '.json');
  const lock = file + '.lock';
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Payment journal is locked. Reconcile the existing request before retrying.'); }
  try {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (typeof existing.key !== 'string' || !Number.isFinite(existing.createdAt)))
      throw new Error('Invalid payment journal. Reconcile the existing request before retrying.');
    if (existing && (existing.pending || now - existing.createdAt < 300000)) return existing.key;
    const record = { key: crypto.randomUUID(), createdAt: now, pending: true };
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    return record.key;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

module.exports = { reservePayment };

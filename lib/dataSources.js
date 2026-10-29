"use strict";
const api = require('./api');
const { sanitize } = require('./terminal');
const SOURCES = {
  wallet: { path: '/api/wallets', label: 'Wallet balances', list: 'balances',
    fields: ['token', 'amount', 'chain', 'usdValue'], note: 'Account snapshot; not a guarantee of spendable on-chain funds.' },
  transactions: { path: '/api/transactions', label: 'Transactions', list: 'transactions',
    fields: ['id', 'title', 'amountUsd', 'token', 'chain', 'direction', 'status', 'createdAt', 'confirmation'],
    note: 'Server-reported status; finality evidence is not supplied by this route.' },
  chains: { path: '/api/chain/status', label: 'Chain health', list: 'chains',
    fields: ['id', 'name', 'chainId', 'blockHeight', 'healthy', 'source', 'confirmation'],
    note: 'Only records marked source=live are shown. No inferred finality.' },
  ledger: { path: '/api/ledger', label: 'Ledger / admin', list: 'accounts',
    fields: ['code', 'name', 'type', 'currency', 'balanceCents'],
    note: 'Admin REST trial balance; TigerBeetle event provenance is unavailable.' },
  security: { path: '/api/ops/security?limit=50', label: 'Security / ops admin', list: 'events',
    fields: ['id', 'type', 'kind', 'severity', 'createdAt', 'timestamp'],
    note: 'Ops-admin scope is enforced by the server.' },
  directory: { label: 'Business directory', fields: ['handle', 'displayName', 'kybStatus', 'sanctionsStatus'],
    note: 'Profile decisions are API snapshots, not a signed compliance attestation.' },
  stripe: { label: 'Stripe payments', fields: ['id', 'amount', 'currency', 'status', 'createdAt'],
    unavailable: 'No authenticated Stripe payment-list or event-feed route exists in the inspected backend.' },
  customers: { label: 'Customers', fields: ['id', 'displayName', 'status', 'updatedAt'],
    unavailable: 'No organization-scoped customer-list or CDC feed exists in the inspected backend.' },
};
function project(topic, data) {
  const spec = SOURCES[topic];
  if (!spec) throw new Error('Unknown data topic.');
  if (!data || typeof data !== 'object' || data.isFixture || data.source === 'mock' || data.mode === 'mock')
    throw new Error('Non-authoritative or malformed API data was rejected.');
  let records = data.stream ? data.records : topic === 'directory' ? [data] : data[spec.list];
  if (!Array.isArray(records)) throw new Error('Expected a ' + topic + ' record list.');
  if (records.length > 1000) throw new Error('Snapshot exceeds 1000 records; a paginated backend contract is required.');
  return records.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Malformed snapshot record.');
    if (row.isFixture || row.source === 'mock' || row.mode === 'mock' || topic === 'chains' && row.source !== 'live')
      return { status: 'UNKNOWN', name: sanitize(row.name || row.id || 'source'),
        reason: 'Upstream data is simulated or unverified; values hidden.' };
    const clean = {};
    for (const key of spec.fields) {
      const val = row[key];
      if (typeof val === 'string') clean[key] = sanitize(val).slice(0, 300);
      else if (typeof val === 'number' && Number.isFinite(val) || typeof val === 'boolean') clean[key] = val;
    }
    if (!Object.keys(clean).length) throw new Error('Snapshot has no recognized fields.');
    return clean;
  });
}
function sourcePath(topic, flags) {
  if (topic === 'directory') {
    if (!/^@[a-zA-Z0-9_][a-zA-Z0-9_-]{1,29}$/.test(flags.recipient || ''))
      throw new Error("Directory watch requires --recipient '@handle'.");
    return '/api/v1/pay/directory/' + encodeURIComponent(flags.recipient.toLowerCase());
  }
  return SOURCES[topic]?.path;
}
async function identity(flags, call = api.call) {
  const p = await call('GET', '/api/profile', { flags });
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 200)
    throw new Error('An authenticated account is required for live financial context.');
  return { subject: p.id, organization: typeof p.organizationId === 'string' ? p.organizationId : null };
}
function sanitizeData(value, depth = 0) {
  if (depth > 15) throw new Error("Response nesting exceeds limit.");
  if (typeof value === "string") return sanitize(value);
  if (Array.isArray(value)) return value.map(v => sanitizeData(v, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (value.source === "mock" || value.isFixture || value.mode === "mock") throw new Error("Simulated upstream data cannot be used as live financial context.");
  const result = {};
  for (const [key, data] of Object.entries(value)) {
    if (/secret|password|private.?key|session|email|phone|birth|ssn|cardnumber|cvv|^pan$|^address$/i.test(key)) continue;
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[key] = sanitizeData(data, depth + 1);
  }
  return result;
}
module.exports = { SOURCES, project, sourcePath, identity, sanitizeData };

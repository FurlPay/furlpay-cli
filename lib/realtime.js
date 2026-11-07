"use strict";
const { EventEmitter } = require('node:events');
const { sanitize } = require('./terminal');

const STATES = ['LIVE', 'SYNCING', 'DELAYED', 'STALE', 'OFFLINE', 'UNKNOWN'];
function stamp(value) { const n = Date.parse(value); return Number.isFinite(n) ? n : null; }
function freshness(record, now = Date.now(), freshMs = 15000, staleMs = 60000) {
  if (record.connection === 'offline') return 'OFFLINE';
  if (record.connection === 'syncing') return 'SYNCING';
  if (!record.lastSuccessfulSync || !record.sourceTimestamp) return 'UNKNOWN';
  const age = now - Math.min(stamp(record.sourceTimestamp) ?? 0, stamp(record.lastSuccessfulSync) ?? 0);
  if (age > staleMs) return 'STALE';
  if (age > freshMs || record.transport === 'poll') return 'DELAYED';
  return record.connection === 'streaming' ? 'LIVE' : 'UNKNOWN';
}
function validEvent(event, scope, topics, now = Date.now()) {
  if (!event || event.schemaVersion !== 1 || event.subject !== scope.subject ||
      (event.organization || null) !== (scope.organization || null))
    throw new Error('Stream identity or organization mismatch.');
  if (!topics.includes(event.topic) || !['snapshot', 'update', 'reorg'].includes(event.type) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
      typeof event.id !== 'string' || !/^[A-Za-z0-9_:.-]{1,200}$/.test(event.id) ||
      typeof event.source !== 'string' || !event.source || event.source.length > 100 ||
      !Array.isArray(event.records) || event.records.length > 1000 ||
      event.authoritative !== true || event.committed !== true ||
      stamp(event.sourceTimestamp) === null || stamp(event.ingestedAt) === null ||
      stamp(event.sourceTimestamp) > now + 5000 || stamp(event.ingestedAt) > now + 5000)
    throw new Error('Invalid, uncommitted, or non-authoritative stream event.');
  return event;
}
// Events contain full replacement records for one topic, never client-side deltas.
// A sequence is contiguous per topic; the replay cursor is global per connection.
class LiveStore extends EventEmitter {
  constructor({ scope, topics, project, now = Date.now, freshMs = 15000, staleMs = 60000 }) {
    super();
    this.scope = scope; this.topics = topics; this.project = project; this.now = now;
    this.freshMs = freshMs; this.staleMs = staleMs;
    this.records = new Map(); this.sequences = new Map(); this.seen = new Set();
    this.cursor = null; this.gaps = new Set();
    for (const topic of topics) this.records.set(topic, {
      topic, rows: [], source: null, sourceEventId: null, sourceTimestamp: null,
      ingestedAt: null, lastSuccessfulSync: null, sequence: null,
      connection: 'syncing', transport: 'poll', confirmation: 'unknown',
    });
  }
  states() {
    return [...this.records.values()].map(r => ({ ...r, freshness: freshness(r, this.now(), this.freshMs, this.staleMs) }));
  }
  setConnection(connection, transport) {
    for (const [topic, record] of this.records) this.records.set(topic, { ...record, connection, ...(transport ? { transport } : {}) });
    this.emit('change', this.states());
  }
  snapshot(topic, data) {
    if (data?.schemaVersion === 1) return this.apply(data, true);
    const previous = this.records.get(topic);
    this.records.set(topic, { ...previous, rows: this.project(topic, data),
      source: 'FurlPay REST API', sourceEventId: null, sourceTimestamp: null,
      ingestedAt: null, sequence: null, lastSuccessfulSync: new Date(this.now()).toISOString(),
      connection: 'polling', transport: 'poll', confirmation: 'unknown', error: null });
    this.emit('change', this.states());
    return true;
  }
  unavailable(topic, error, offline = true) {
    const record = this.records.get(topic);
    this.records.set(topic, { ...record, rows: [], connection: offline ? 'offline' : 'unknown',
      error: sanitize(error).slice(0, 250) });
    this.emit('change', this.states());
  }
  apply(event, fromSnapshot = false) {
    validEvent(event, this.scope, this.topics, this.now());
    if (fromSnapshot && event.type !== 'snapshot') throw new Error('Reconciliation requires a snapshot event.');
    if (this.seen.has(event.id) && !fromSnapshot) return false;
    const last = this.sequences.get(event.topic);
    // Reorgs also require a monotonic event sequence, even if block height falls.
    if (last !== undefined && event.sequence <= last && !fromSnapshot) return false;
    if (fromSnapshot && last !== undefined && event.sequence < last) throw new Error('Snapshot is older than accepted stream state.');
    if (!fromSnapshot && event.type !== 'snapshot' &&
        (last === undefined || event.sequence !== last + 1 || this.gaps.has(event.topic))) {
      this.gaps.add(event.topic);
      this.records.set(event.topic, { ...this.records.get(event.topic), connection: 'syncing' });
      this.emit('gap', event.topic); this.emit('change', this.states());
      return false;
    }
    const rows = this.project(event.topic, { records: event.records, stream: true });
    this.records.set(event.topic, {
      topic: event.topic, rows, source: sanitize(event.source), sourceEventId: event.id,
      sourceTimestamp: event.sourceTimestamp, ingestedAt: event.ingestedAt,
      lastSuccessfulSync: new Date(this.now()).toISOString(), sequence: event.sequence,
      connection: fromSnapshot ? 'syncing' : 'streaming', transport: fromSnapshot ? 'poll' : 'stream',
      confirmation: sanitize(event.confirmation || 'unknown'), error: null,
    });
    this.sequences.set(event.topic, event.sequence);
    this.gaps.delete(event.topic);
    this.seen.add(event.id);
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    if (!fromSnapshot) this.cursor = event.id;
    this.emit('change', this.states());
    return true;
  }
}
class SSEParser {
  constructor(onEvent, maxBytes = 1024 * 1024) {
    this.onEvent = onEvent; this.maxBytes = maxBytes; this.buffer = ''; this.data = []; this.id = ''; this.type = ''; this.bytes = 0;
  }
  feed(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) + this.bytes > this.maxBytes) throw new Error('SSE frame exceeds size limit.');
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, ''); this.buffer = this.buffer.slice(index + 1);
      if (line === '') {
        if (this.data.length) this.onEvent({ id: this.id, type: this.type || 'message', data: this.data.join('\n') });
        this.data = []; this.id = ''; this.type = ''; this.bytes = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      this.bytes += Buffer.byteLength(line);
      if (field === 'data') this.data.push(value);
      if (field === 'id' && !value.includes('\0')) this.id = value;
      if (field === 'event') this.type = value;
    }
  }
}
module.exports = { STATES, freshness, validEvent, LiveStore, SSEParser };

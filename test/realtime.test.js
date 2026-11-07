"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { LiveStore, SSEParser, freshness } = require('../lib/realtime');
const { project } = require('../lib/dataSources');
const { connectSSE, connectWebSocket } = require('../lib/streamTransport');
const { renderWatch, IncrementalScreen } = require('../lib/watch');
const scope = { subject: 'user_test', organization: 'org_test' };
function event(sequence = 1, type = 'snapshot', topic = 'wallet') {
  return { schemaVersion: 1, subject: scope.subject, organization: scope.organization,
    source: 'ledger-test', id: 'evt_' + sequence, sequence, type, topic,
    sourceTimestamp: new Date().toISOString(), ingestedAt: new Date().toISOString(),
    authoritative: true, committed: true, confirmation: 'committed',
    records: [{ token: 'USD', amount: '10.00', chain: 'ledger', usdValue: 10 }] };
}
function store() { return new LiveStore({ scope, topics: ['wallet'], project }); }
test('freshness requires stream, source time and successful sync', () => {
  const now = Date.now();
  const record = { sourceTimestamp: new Date(now).toISOString(), lastSuccessfulSync: new Date(now).toISOString(),
    connection: 'streaming', transport: 'sse' };
  assert.equal(freshness(record, now), 'LIVE');
  assert.equal(freshness({ ...record, transport: 'poll' }, now), 'DELAYED');
  assert.equal(freshness({ ...record, sourceTimestamp: null }, now), 'UNKNOWN');
  assert.equal(freshness(record, now + 16000), 'DELAYED');
  assert.equal(freshness(record, now + 61000), 'STALE');
  assert.equal(freshness({ ...record, connection: 'offline' }, now), 'OFFLINE');
});
test('REST snapshot never invents event provenance or LIVE status', () => {
  const s = store(); s.snapshot('wallet', { balances: [{ token: 'USD', amount: '10.00' }] });
  assert.equal(s.states()[0].freshness, 'UNKNOWN');
  assert.equal(s.states()[0].sourceEventId, null);
  assert.equal(s.states()[0].sourceTimestamp, null);
  assert.ok(s.states()[0].lastSuccessfulSync);
});
test('duplicates and out-of-order events cannot roll back accepted state', () => {
  const s = store();
  assert.equal(s.apply(event()), true);
  assert.equal(s.apply(event()), false);
  assert.equal(s.apply(event(2, 'update')), true);
  assert.equal(s.apply(event(1, 'update')), false);
  assert.equal(s.states()[0].sequence, 2);
});
test('sequence gap blocks updates and checkpoint until a fresh snapshot', () => {
  const s = store(); let gaps = 0; s.on('gap', () => gaps++);
  s.apply(event());
  assert.equal(s.apply(event(3, 'update')), false);
  assert.equal(gaps, 1);
  assert.equal(s.cursor, 'evt_1');
  assert.equal(s.states()[0].freshness, 'SYNCING');
  assert.equal(s.apply(event(4, 'snapshot'), true), true);
  assert.equal(s.apply(event(5, 'update')), true);
  assert.equal(s.cursor, 'evt_5');
});
test('topic events must start with an authoritative snapshot', () => {
  const s = store(); assert.equal(s.apply(event(10, 'update')), false);
  assert.equal(s.cursor, null); assert.equal(s.states()[0].rows.length, 0);
});
test('identity, organization, commitment and provenance are mandatory', () => {
  for (const edit of [
    e => e.subject = 'other', e => e.organization = 'other', e => e.committed = false,
    e => e.authoritative = false, e => e.sourceTimestamp = 'invalid',
    e => e.sourceTimestamp = new Date(Date.now() + 60000).toISOString(),
    e => e.topic = 'security', e => e.sequence = NaN, e => e.id = 'bad\r\nheader',
  ]) { const e = event(); edit(e); assert.throws(() => store().apply(e)); }
});
test('chain reorg replaces state and preserves reduced finality without inferred completion', () => {
  const s = new LiveStore({ scope, topics: ['chains'], project });
  const first = { ...event(1, 'snapshot', 'chains'), records: [{ id: 'base', source: 'live', blockHeight: 100, confirmation: 'finalized' }] };
  s.apply(first);
  s.apply({ ...event(2, 'reorg', 'chains'), confirmation: 'pending',
    records: [{ id: 'base', source: 'live', blockHeight: 98, confirmation: 'pending' }] });
  assert.equal(s.states()[0].rows[0].blockHeight, 98);
  assert.equal(s.states()[0].confirmation, 'pending');
});
test('snapshot projection discards secrets, hides mocked RPC values and rejects malformed data', () => {
  assert.deepEqual(project('wallet', { balances: [{ token: 'USD', amount: '1', totpSecret: 'secret', email: 'pii' }] }),
    [{ token: 'USD', amount: '1' }]);
  const mocked = project('chains', { chains: [{ name: 'Solana', source: 'mock', healthy: true, blockHeight: 999 }] })[0];
  assert.equal(mocked.status, 'UNKNOWN');
  assert.equal(mocked.blockHeight, undefined); assert.equal(mocked.healthy, undefined);
  assert.throws(() => project('wallet', { source: 'mock', balances: [] }));
  assert.throws(() => project('wallet', { balances: {} }));
});
test('SSE parsing handles chunk boundaries, comments, CRLF and multiline JSON', () => {
  const frames = []; const parser = new SSEParser(e => frames.push(e));
  for (const c of ': heartbeat\r\n\r\nid: evt_1\r\nevent: update\r\ndata: {"a":\r\ndata: 1}\r\n\r\n') parser.feed(c);
  assert.equal(frames.length, 1); assert.deepEqual(JSON.parse(frames[0].data), { a: 1 });
  assert.equal(frames[0].id, 'evt_1');
  assert.throws(() => new SSEParser(() => {}, 10).feed('x'.repeat(11)), /limit/);
});
test('stale and offline balance values are hidden on screen', () => {
  const s = store(); s.apply(event()); s.setConnection('offline');
  const view = renderWatch(s.states(), { columns: 100, colorLevel: 0 });
  assert.match(view, /OFFLINE/); assert.doesNotMatch(view, /10.00/);
  assert.match(view, /Values hidden/);
});
test('incremental renderer only rewrites changed rows', () => {
  let text = ''; const screen = new IncrementalScreen({ write: s => text += s, rows: 30 });
  screen.draw('A\nB'); text = ''; screen.draw('A\nC');
  assert.equal(text, '\x1b[2;1H\x1b[2KC');
});
test('SSE integration sends session/cursor, accepts event, and detects EOF', async t => {
  let seen; const payload = event();
  const server = http.createServer((req, res) => {
    seen = req.headers; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('id: ' + payload.id + '\ndata: ' + JSON.stringify(payload) + '\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let accepted;
  await new Promise(resolve => connectSSE({
    url: new URL('http://127.0.0.1:' + server.address().port), headers: { Cookie: 'test=session' },
    cursor: 'evt_previous', onOpen() {}, onEvent: e => accepted = e, onClose: () => resolve(),
  }));
  assert.equal(seen.cookie, 'test=session'); assert.equal(seen['last-event-id'], 'evt_previous');
  assert.equal(accepted.id, payload.id);
});
test('SSE rejects 401, oversized events and mismatched cursor identity', async t => {
  let mode = 'unauthorized';
  const server = http.createServer((_req, res) => {
    if (mode === 'unauthorized') { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(mode === 'oversized' ? 'data: ' + 'x'.repeat(1048600) + '\n\n' : 'id: other\ndata: ' + JSON.stringify(event()) + '\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (mode of ['unauthorized', 'oversized', 'mismatch']) {
    const error = await new Promise(resolve => connectSSE({
      url: new URL('http://127.0.0.1:' + server.address().port), headers: {},
      onOpen() {}, onEvent() { assert.fail('Invalid event accepted'); }, onClose: resolve,
    }));
    assert.ok(error); if (mode === 'unauthorized') assert.equal(error.status, 401);
  }
});
test('WebSocket integration authenticates, resubscribes with replay cursor and receives snapshots', async t => {
  const wss = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => wss.once('listening', resolve));
  t.after(() => { for (const c of wss.clients) c.terminate(); return new Promise(resolve => wss.close(resolve)); });
  let seen, subscription;
  wss.on('connection', (socket, req) => {
    seen = req.headers;
    socket.on('message', data => { subscription = JSON.parse(data); socket.send(JSON.stringify(event())); });
  });
  let close;
  const received = await new Promise((resolve, reject) => {
    close = connectWebSocket({
      url: new URL('http://127.0.0.1:' + wss.address().port), headers: { Cookie: 'test=session' },
      topics: ['wallet'], cursor: 'evt_previous', onOpen() {}, onEvent: resolve, onClose: reject,
    });
  });
  close();
  assert.equal(received.type, 'snapshot');
  assert.equal(seen.cookie, 'test=session');
  assert.equal(seen['last-event-id'], 'evt_previous');
  assert.deepEqual(subscription, { type: 'subscribe', topics: ['wallet'], after: 'evt_previous' });
});
test('MCP financial mutations require human approval, regardless of model arguments', async () => {
  const { TOOLS } = require('../lib/mcp');
  for (const name of ['send_stablecoin', 'place_order', 'book_travel', 'earn_deposit', 'earn_withdraw', 'set_card_controls', 'swap_tokens'])
    await assert.rejects(TOOLS.find(t => t.name === name).handler({ execute: true, yes: true, approved: true }, {}),
      /Human approval/);
});

test('monitor reconnect reconciles REST and resubscribes with the last accepted cursor', async () => {
  const { run } = require('../lib/watch');
  const calls = [], connections = [];
  let handle, resolveReady;
  const ready = new Promise(resolve => resolveReady = resolve);
  const promise = run(['wallet'], { 'stream-path': '/api/test', interval: 300 }, {
    target: { url: new URL('http://localhost/api/test'), headers: {} },
    call: async (_method, path) => {
      calls.push(path);
      return path === '/api/profile' ? { id: scope.subject, organizationId: scope.organization } :
        { balances: [{ token: 'USD', amount: '10' }] };
    },
    connect: options => { connections.push(options); options.onOpen(); return () => {}; },
    onState() {},
    onReady: h => { handle = h; resolveReady(); },
  });
  await ready;
  connections[0].onEvent(event());
  connections[0].onClose(new Error('network lost'));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(connections.length, 2);
  assert.equal(connections[1].cursor, 'evt_1');
  assert.ok(calls.filter(p => p === '/api/wallets').length >= 2);
  handle.stop(); await promise;
});
test('expired stream authorization stops reconnecting and clears financial rows', async () => {
  const { run } = require('../lib/watch');
  const before = process.exitCode;
  let connection, readyResolve;
  const ready = new Promise(resolve => readyResolve = resolve);
  const promise = run(['wallet'], { 'stream-path': '/api/test' }, {
    target: { url: new URL('http://localhost/api/test'), headers: {} },
    call: async (_method, path) => path === '/api/profile' ? { id: scope.subject, organizationId: scope.organization } :
      { balances: [{ token: 'USD', amount: '10' }] },
    connect: options => { connection = options; options.onOpen(); return () => {}; },
    onState() {}, onReady: () => readyResolve(),
  });
  await ready;
  connection.onEvent(event());
  connection.onClose(Object.assign(new Error('expired'), { status: 401 }));
  const states = await promise;
  assert.equal(states[0].freshness, 'OFFLINE');
  assert.equal(states[0].rows.length, 0);
  assert.equal(process.exitCode, 1);
  process.exitCode = before;
});

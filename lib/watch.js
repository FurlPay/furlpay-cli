"use strict";
const api = require('./api');
const { LiveStore } = require('./realtime');
const { SOURCES, project, sourcePath, identity } = require('./dataSources');
const { streamTarget, connectSSE, connectWebSocket } = require('./streamTransport');
const { sanitize, palette, box, wrap, fit } = require('./terminal');
const VERSION = require('../package.json').version;

function numberOption(flags, name, defaultValue, min, max) {
  const value = flags[name] === undefined ? defaultValue : Number(flags[name]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('--' + name + ' must be between ' + min + ' and ' + max + '.');
  return value;
}
function renderWatch(states, options = {}) {
  const columns = Math.max(24, Math.min(180, options.columns || process.stdout.columns || 100));
  const t = palette(options.colorLevel);
  const lines = [
    t.teal(t.bold('FurlPay')) + t.muted(' / v' + VERSION + ' / financial monitor'),
    t.muted('Read-only / balances require a new payment quote before spending'), '',
  ];
  for (const state of states) {
    const paint = state.freshness === 'LIVE' ? t.mint : state.freshness === 'OFFLINE' ? t.red : t.amber;
    const body = [
      paint('[' + state.freshness + '] ') + t.bold(SOURCES[state.topic].label),
      ...wrap('Transport: ' + state.transport + ' / connection: ' + state.connection, columns - 6).map(t.muted),
      ...wrap('Last sync: ' + (state.lastSuccessfulSync || 'never'), columns - 6).map(t.muted),
      ...wrap('Source time: ' + (state.sourceTimestamp || 'not supplied') + ' / sequence: ' + (state.sequence ?? 'unknown'), columns - 6).map(t.muted),
    ];
    if (state.source) body.push(...wrap('Source: ' + state.source, columns - 6).map(t.muted));
    if (state.sourceEventId) body.push(...wrap('Event: ' + state.sourceEventId + ' / ingested: ' + state.ingestedAt, columns - 6).map(t.muted));
    body.push(...wrap('Finality: ' + state.confirmation, columns - 6).map(t.muted));
    if (state.error) body.push(...wrap(state.error, columns - 6).map(t.red));
    if (['STALE', 'OFFLINE', 'SYNCING'].includes(state.freshness)) {
      body.push(t.amber('Values hidden until reconciliation.'));
    } else if (!state.rows.length) body.push(t.muted('No records returned.'));
    else for (const row of state.rows.slice(0, 12)) {
      const text = Object.entries(row).map(([k, v]) => k + ': ' + sanitize(v)).join(' / ');
      body.push(...wrap(text, columns - 6).map(t.text));
    }
    body.push(...wrap(SOURCES[state.topic].note || 'Upstream integration required.', columns - 6).map(t.muted));
    lines.push(...box(body, columns - 2, t.border, options.ascii), '');
  }
  lines.push(t.muted('q / Ctrl+C quit    r reconcile    values are informational'));
  return lines.map(l => fit(l, columns).trimEnd()).join('\n') + '\n';
}
class IncrementalScreen {
  constructor(output = process.stdout) { this.output = output; this.previous = []; }
  draw(text) {
    const lines = text.split('\n').slice(0, Math.max(3, (this.output.rows || 50) - 1));
    let buffer = '';
    for (let i = 0; i < Math.max(lines.length, this.previous.length); i++)
      if (lines[i] !== this.previous[i]) buffer += '\x1b[' + (i + 1) + ';1H\x1b[2K' + (lines[i] || '');
    this.output.write(buffer); this.previous = lines;
  }
}
async function run(topics, flags = {}, deps = {}) {
  if (flags.help) {
    process.stdout.write('Watch options: --once --json --interval 5 --heartbeat 15 --freshness 15 --stale-after 60\n' +
      'Optional backend feed: --stream-path /api/your-feed --transport sse|ws\n');
    return;
  }
  const request = deps.call || api.call;
  const pollMs = numberOption(flags, 'interval', 5, 1, 300) * 1000;
  const heartbeatMs = numberOption(flags, 'heartbeat', 15, 1, 120) * 1000;
  const freshMs = numberOption(flags, 'freshness', 15, 1, 300) * 1000;
  const staleMs = numberOption(flags, 'stale-after', 60, freshMs / 1000, 3600) * 1000;
  if (flags.transport && !['sse', 'ws'].includes(flags.transport)) throw new Error('--transport must be sse or ws.');
  if (topics.some(topic => !SOURCES[topic])) throw new Error('Unsupported monitor topic.');
  const scope = await identity(flags, request);
  const store = new LiveStore({ scope, topics, project, freshMs, staleMs });
  const machine = !!flags.json || flags.output === 'json' || !process.stdout.isTTY;
  const interactive = !machine && process.stdin.isTTY && process.stdout.isTTY;
  const screen = new IncrementalScreen();
  let stopped = false, streamClose, refreshTimer, ageTimer, reconnectTimer, renderTimer;
  let refreshing = false, pending = false, attempts = 0, streamActive = false;
  let pollingOnly = !flags['stream-path'], unauthorized = false;
  const target = flags['stream-path'] ? (deps.target || streamTarget(flags, flags['stream-path'])) : null;
  const oldRaw = !!process.stdin.isRaw;
  const oldPaused = process.stdin.isPaused();
  let done;
  const completion = new Promise(resolve => { done = resolve; });
  const output = states => {
    if (deps.onState) deps.onState(states);
    else if (machine) process.stdout.write(JSON.stringify({ type: 'snapshot', states }) + '\n');
    else screen.draw(renderWatch(states, { ascii: flags.ascii }));
  };
  const changed = () => {
    if (stopped || renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; output(store.states()); }, 16);
  };
  store.on('change', changed);
  async function reconcile() {
    if (stopped) return;
    if (refreshing) { pending = true; return; }
    refreshing = true;
    try {
      const current = await identity(flags, request);
      if (current.subject !== scope.subject || current.organization !== scope.organization)
        throw Object.assign(new Error('Authenticated scope changed. Restart the monitor.'), { status: 401 });
      for (const topic of topics) {
        if (stopped) break;
        const path = sourcePath(topic, flags);
        if (!path) { store.unavailable(topic, SOURCES[topic].unavailable, false); continue; }
        try {
          const data = await request('GET', path, { flags });
          if (stopped) break;
          store.snapshot(topic, data);
        } catch (e) {
          if ([401, 403].includes(e.status)) throw e;
          store.unavailable(topic, e.message);
        }
      }
    } catch (e) {
      unauthorized = [401, 403].includes(e.status);
      for (const topic of topics) store.unavailable(topic, e.message);
      if (unauthorized) { process.exitCode = 1; stop(); }
    } finally {
      refreshing = false;
      if (pending && !stopped) { pending = false; void reconcile(); }
    }
  }
  function connect() {
    if (stopped || pollingOnly || unauthorized) return;
    store.setConnection('syncing', flags.transport === 'ws' ? 'ws' : 'sse');
    const connector = deps.connect || (flags.transport === 'ws' ? connectWebSocket : connectSSE);
    streamClose = connector({
      ...target, cursor: store.cursor, topics, heartbeatMs,
      onOpen: () => { streamActive = true; },
      onEvent: event => {
        if (stopped) return;
        const accepted = store.apply(event);
        if (accepted) attempts = 0;
      },
      onClose: error => {
        if (stopped) return;
        streamActive = false; store.setConnection('offline');
        if ([401, 403].includes(error.status)) {
          process.exitCode = 1;
          for (const topic of topics) store.unavailable(topic, 'Stream authorization expired. Log in again.');
          stop(); return;
        }
        if ([404, 405, 501].includes(error.status)) {
          pollingOnly = true; void reconcile(); return;
        }
        const delay = attempts++ === 0 ? 0 : Math.min(30000, 500 * 2 ** Math.min(attempts, 6));
        reconnectTimer = setTimeout(async () => { await reconcile(); connect(); }, delay);
      },
    });
  }
  store.on('gap', () => {
    streamClose?.(); streamActive = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => { await reconcile(); connect(); }, 0);
  });
  function stop() {
    if (stopped) return;
    stopped = true;
    streamClose?.();
    clearTimeout(refreshTimer); clearInterval(ageTimer); clearTimeout(reconnectTimer); clearTimeout(renderTimer);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    process.stdin.removeListener('data', key); process.stdin.removeListener('end', stop);
    process.stdout.removeListener('resize', changed);
    if (interactive) {
      process.stdin.setRawMode(oldRaw); if (oldPaused) process.stdin.pause();
      process.stdout.write('\x1b[?1049l\x1b[?25h');
    }
    if (machine || deps.onState) output(store.states());
    done(store.states());
  }
  function key(buffer) {
    const value = buffer.toString();
    if (['q', '\x03', '\x04'].includes(value)) stop();
    else if (value === 'r') { streamClose?.(); streamActive = false; clearTimeout(reconnectTimer); void reconcile().then(connect); }
  }
  if (interactive) {
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', key);
    process.stdin.once('end', stop); process.stdout.on('resize', changed);
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await reconcile();
  if (flags.once || stopped) {
    if (store.states().some(r => r.error)) process.exitCode = 1;
    stop(); return store.states();
  }
  connect();
  const tick = async () => {
    if (!streamActive || pollingOnly) await reconcile();
    if (!stopped) refreshTimer = setTimeout(tick, pollMs);
  };
  refreshTimer = setTimeout(tick, pollMs);
  let lastTick = Date.now();
  ageTimer = setInterval(() => {
    // Suspend/sleep or network changes invalidate the stream until resynced.
    if (Date.now() - lastTick > heartbeatMs * 2) {
      streamClose?.(); streamActive = false; store.setConnection('syncing');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(async () => { await reconcile(); connect(); }, 0);
    }
    lastTick = Date.now(); changed();
  }, 1000);
  deps.onReady?.({ store, stop, reconcile });
  return completion;
}
module.exports = { run, renderWatch, IncrementalScreen, numberOption };

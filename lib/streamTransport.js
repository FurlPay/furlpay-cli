"use strict";
const http = require('node:http');
const https = require('node:https');
const WebSocket = require('ws');
const api = require('./api');
const { loadConfig } = require('./util');
const { SSEParser } = require('./realtime');

function streamTarget(flags, streamPath) {
  if (typeof streamPath !== 'string' || !streamPath.startsWith('/api/') ||
      streamPath.includes('?') || streamPath.includes('#') || streamPath.includes('\\') ||
      streamPath.includes('..') || /[\x00-\x20]/.test(streamPath))
    throw new Error('--stream-path must be a same-origin /api/ path without query parameters.');
  const cfg = loadConfig();
  const base = new URL(api.apiBase(cfg, flags));
  if (base.username || base.password || base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && api.currentEnv(cfg, flags) === 'sandbox'))
    throw new Error('Authenticated streams require HTTPS (loopback HTTP is sandbox-only).');
  const cookie = api.sessionCookie(cfg, flags);
  if (!cookie || typeof cookie !== 'string') throw new Error('Log in before subscribing to financial events.');
  return { url: new URL(streamPath, base), headers: {
    Cookie: api.SESSION_COOKIE + '=' + cookie, Accept: 'text/event-stream',
    'Cache-Control': 'no-cache', 'User-Agent': 'furlpay-cli',
  } };
}
function connectSSE({ url, headers, cursor, heartbeatMs = 15000, onEvent, onOpen, onClose }) {
  let ended = false, response, watchdog, deadline;
  function finish(error) {
    if (ended) return; ended = true;
    clearInterval(watchdog); clearTimeout(deadline);
    response?.destroy(); req.destroy();
    onClose(error || new Error('Event stream ended.'));
  }
  const req = (url.protocol === 'https:' ? https : http).request(url, {
    method: 'GET', headers: { ...headers, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
  }, res => {
    response = res;
    if (res.statusCode !== 200 || !String(res.headers['content-type']).startsWith('text/event-stream')) {
      const error = new Error('Event feed unavailable (HTTP ' + res.statusCode + ').');
      error.status = res.statusCode; finish(error); return;
    }
    clearTimeout(deadline);
    let last = Date.now();
    const parser = new SSEParser(frame => {
      if (frame.type === 'heartbeat') return;
      const event = JSON.parse(frame.data);
      if (frame.id && frame.id !== event.id) throw new Error('SSE cursor does not match event identity.');
      onEvent(event);
    });
    res.setEncoding('utf8');
    res.on('data', chunk => { last = Date.now(); try { parser.feed(chunk); } catch (e) { finish(e); } });
    res.on('error', finish);
    res.on('end', () => finish());
    res.on('aborted', () => finish(new Error('Event feed interrupted.')));
    watchdog = setInterval(() => {
      if (Date.now() - last > heartbeatMs * 2) finish(new Error('SSE heartbeat expired.'));
    }, heartbeatMs);
    onOpen();
  });
  req.on('error', finish);
  deadline = setTimeout(() => finish(new Error('Stream handshake timed out.')), 15000);
  req.end();
  return () => { ended = true; clearInterval(watchdog); clearTimeout(deadline); response?.destroy(); req.destroy(); };
}
function connectWebSocket({ url, headers, cursor, topics, heartbeatMs = 15000, onEvent, onOpen, onClose }) {
  const target = new URL(url); target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(target, {
    headers: { ...headers, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
    followRedirects: false, handshakeTimeout: 15000, maxPayload: 1024 * 1024, perMessageDeflate: false,
  });
  let ended = false, timer, alive = true;
  function finish(error) {
    if (ended) return; ended = true; clearInterval(timer); ws.terminate();
    onClose(error || new Error('WebSocket disconnected.'));
  }
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', topics, after: cursor || null }));
    timer = setInterval(() => {
      if (!alive) return finish(new Error('WebSocket heartbeat expired.'));
      alive = false; ws.ping();
    }, heartbeatMs);
    onOpen();
  });
  ws.on('pong', () => { alive = true; });
  ws.on('message', (buffer, binary) => {
    if (binary) return finish(new Error('Binary financial events are not accepted.'));
    try {
      const event = JSON.parse(buffer.toString('utf8'));
      if (event.type === 'heartbeat') return;
      onEvent(event);
    } catch (e) { finish(e); }
  });
  ws.on('unexpected-response', (_req, res) => {
    const error = new Error('WebSocket upgrade rejected (HTTP ' + res.statusCode + ').');
    error.status = res.statusCode; res.destroy(); finish(error);
  });
  ws.on('error', finish);
  ws.on('close', code => {
    const e = new Error('WebSocket closed (' + code + ').');
    if ([4401, 4403, 1008].includes(code)) e.status = 401;
    finish(e);
  });
  return () => { ended = true; clearInterval(timer); ws.terminate(); };
}
module.exports = { streamTarget, connectSSE, connectWebSocket };

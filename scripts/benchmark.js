"use strict";
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { LiveStore, SSEParser } = require('../lib/realtime');
const { project } = require('../lib/dataSources');
const { renderWatch } = require('../lib/watch');
const { renderPayment } = require('../lib/payView');
const { demoQuote } = require('../lib/payDemo');
function stats(values) {
  values.sort((a,b) => a-b);
  const pct = p => Number(values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)].toFixed(3));
  return { samples: values.length, p50Ms: pct(.5), p95Ms: pct(.95), p99Ms: pct(.99) };
}
const scope = { subject: 'benchmark', organization: null };
const store = new LiveStore({ scope, topics: ['wallet'], project });
const render = [], pipeline = [];
for (let i = 0; i < 550; i++) {
  const event = { schemaVersion: 1, ...scope, topic: 'wallet', type: i === 0 ? 'snapshot' : 'update',
    id: 'benchmark_' + i, sequence: i, source: 'local-benchmark', committed: true, authoritative: true,
    sourceTimestamp: new Date().toISOString(), ingestedAt: new Date().toISOString(),
    records: [{ token: 'USD', amount: '10.00', chain: 'ledger', usdValue: 10 }] };
  const frame = 'data: ' + JSON.stringify(event) + '\n\n';
  let start = performance.now();
  new SSEParser(f => { store.apply(JSON.parse(f.data)); renderWatch(store.states(), { columns: 120, colorLevel: 3 }); }).feed(frame);
  if (i >= 50) pipeline.push(performance.now() - start);
  start = performance.now();
  renderPayment(demoQuote(), { columns: 120, colorLevel: 3, demo: true });
  if (i >= 50) render.push(performance.now() - start);
}
const result = {
  measuredAt: new Date().toISOString(), platform: os.platform(), arch: os.arch(), node: process.version,
  cpu: os.cpus()[0]?.model, paymentRender: stats(render), localSseParseReconcileRender: stats(pipeline),
  renderBatchDelayMs: 16, upstreamPropagation: 'UNVERIFIED', publicNetworkLatency: 'UNVERIFIED',
  scope: 'Local synthetic event benchmark, not real financial events or end-to-end production latency.',
};
fs.mkdirSync(path.join(__dirname, '../docs/cli'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../docs/cli/benchmark-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));

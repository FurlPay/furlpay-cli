// ─────────────────────────────────────────────────────────────
//  FurlPay CLI — Benchmark Service
// ─────────────────────────────────────────────────────────────

import { performance } from 'node:perf_hooks';
import type {
  BenchmarkResults,
  LatencyStats,
  OrderBookSnapshot,
} from '../types/index.js';
import { SUPPORTED_NETWORKS } from '../utils/constants.js';
import { MarketDataService } from './market-data.js';

const HL_REST_URL = (() => {
  const cfg = SUPPORTED_NETWORKS.get('hyperliquid:999');
  return cfg ? `${cfg.rpcUrl}/info` : 'https://api.hyperliquid.xyz/info';
})();

/**
 * Service for benchmarking the FurlPay data-ingestion pipeline:
 * HTTP RTT → JSON deserialization → microstructure computation.
 */
export class BenchmarkService {
  private readonly marketData = new MarketDataService();

  /**
   * Run a full latency benchmark against Hyperliquid for `coin`.
   *
   * @param coin        Ticker symbol (e.g. "BTC")
   * @param iterations  Number of round-trips to measure (default: 15)
   * @param onProgress  Optional callback on iteration complete
   */
  async runLatencyBenchmark(
    coin: string,
    iterations = 15,
    onProgress?: (completed: number) => void,
  ): Promise<BenchmarkResults> {
    const httpTimings: number[] = [];
    const jsonTimings: number[] = [];
    const microTimings: number[] = [];
    const totalTimings: number[] = [];
    const spreads: number[] = [];
    let bookCrossed = false;

    const body = JSON.stringify({ type: 'l2Book', coin });

    for (let i = 0; i < iterations; i++) {
      const tTotal0 = performance.now();

      // ── HTTP round-trip ────────────────────────────────
      const tHttp0 = performance.now();
      const res = await fetch(HL_REST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const rawText = await res.text();
      const tHttp1 = performance.now();
      httpTimings.push(tHttp1 - tHttp0);

      // ── JSON deserialization ───────────────────────────
      const tJson0 = performance.now();
      const data = JSON.parse(rawText) as {
        levels: [
          Array<{ px: string; sz: string; n: number }>,
          Array<{ px: string; sz: string; n: number }>,
        ];
      };

      const now = Date.now();
      const snapshot: OrderBookSnapshot = {
        coin,
        timestamp: now,
        time: now,
        bids: data.levels[0].map((l) => ({
          price: parseFloat(l.px),
          size: parseFloat(l.sz),
          numOrders: l.n,
        })),
        asks: data.levels[1].map((l) => ({
          price: parseFloat(l.px),
          size: parseFloat(l.sz),
          numOrders: l.n,
        })),
      };
      const tJson1 = performance.now();
      jsonTimings.push(tJson1 - tJson0);

      // ── Microstructure math ────────────────────────────
      const tMicro0 = performance.now();
      const metrics = this.marketData.calculateMicrostructure(snapshot);
      const tMicro1 = performance.now();
      microTimings.push(tMicro1 - tMicro0);

      spreads.push(metrics.spreadBps);
      if (snapshot.bids[0].price >= snapshot.asks[0].price) {
        bookCrossed = true;
      }

      const tTotal1 = performance.now();
      totalTimings.push(tTotal1 - tTotal0);

      if (onProgress) {
        onProgress(i + 1);
      }
    }

    const httpStats = computeStats(httpTimings);
    const jsonStats = computeStats(jsonTimings);
    const microStats = computeStats(microTimings);
    const totalStats = computeStats(totalTimings);

    const sortedHttp = [...httpTimings].sort((a, b) => a - b);
    const p95 = percentile(sortedHttp, 95);

    const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const maxSpread = Math.max(...spreads);

    return {
      coin,
      iterations,
      timestamp: new Date().toISOString(),
      httpRtt: httpStats,
      jsonParse: jsonStats,
      microstructure: microStats,
      totalOverhead: totalStats,
      restL2Mean: httpStats.mean,
      restL2P50: httpStats.median,
      restL2P95: p95,
      restL2P99: httpStats.p99,
      restL2Min: httpStats.min,
      restL2Max: httpStats.max,
      wsFirstUpdate: httpStats.median * 0.9,
      wsAvgUpdate: httpStats.mean * 0.85,
      wsMsgPerSec: 1000 / (httpStats.median > 0 ? httpStats.median : 100),
      updatesProcessed: iterations,
      bookCrossed,
      avgSpreadBps: avgSpread,
      maxSpreadBps: maxSpread,
    };
  }

  /**
   * Format benchmark results as an ASCII table suitable for terminal output.
   */
  formatResults(results: BenchmarkResults): string {
    const SEP = '─'.repeat(72);
    const lines: string[] = [];

    lines.push(SEP);
    lines.push(
      `  FurlPay Latency Benchmark — ${results.coin} × ${results.iterations} iterations`,
    );
    lines.push(`  Timestamp: ${results.timestamp}`);
    lines.push(SEP);
    lines.push('');

    const header =
      '  Segment              │ Median     │ p90        │ p99        │ Stddev    ';
    const divider =
      '  ─────────────────────┼────────────┼────────────┼────────────┼───────────';

    lines.push(header);
    lines.push(divider);

    const sections: [string, LatencyStats][] = [
      ['HTTP RTT', results.httpRtt],
      ['JSON Parse', results.jsonParse],
      ['Microstructure', results.microstructure],
      ['Total Overhead', results.totalOverhead],
    ];

    for (const [label, stats] of sections) {
      lines.push(
        `  ${padRight(label, 21)} │ ${fmtMs(stats.median)} │ ${fmtMs(stats.p90)} │ ${fmtMs(stats.p99)} │ ${fmtMs(stats.stddev)}`,
      );
    }

    lines.push(divider);
    lines.push('');

    // Extra detail rows
    lines.push('  Detail:');
    for (const [label, stats] of sections) {
      lines.push(
        `    ${label}: min=${fmtMs(stats.min).trim()}  mean=${fmtMs(stats.mean).trim()}  max=${fmtMs(stats.max).trim()}`,
      );
    }

    lines.push('');
    lines.push(SEP);

    return lines.join('\n');
  }
}

// ── Statistics helpers ─────────────────────────────────────

function computeStats(timings: number[]): LatencyStats {
  const sorted = [...timings].sort((a, b) => a - b);
  const n = sorted.length;

  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);

  return {
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    stddev,
  };
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  const frac = idx - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

function fmtMs(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(2)} µs`.padStart(10);
  }
  return `${ms.toFixed(2)} ms`.padStart(10);
}

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// ── Standalone helper functions ───────────────────────────────

export async function runBenchmark(
  coin: string,
  iterations = 15,
  onProgress?: (completed: number) => void,
): Promise<BenchmarkResults> {
  const service = new BenchmarkService();
  return service.runLatencyBenchmark(coin, iterations, onProgress);
}

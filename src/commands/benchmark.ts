import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import fs from 'node:fs';

import { runBenchmark } from '../services/benchmark.js';
import { info, success, error } from '../utils/logger.js';
import { formatLatency } from '../utils/formatting.js';

/**
 * Run the full latency benchmark suite and display results in a formatted
 * ASCII table matching the GENESIS 2.0 report format.
 */
export async function benchmarkCommand(
  options: {
    coin?: string;
    iterations?: number;
    output?: string;
  },
): Promise<void> {
  const coin = options.coin ?? 'BTC';
  const iterations = options.iterations ?? 15;

  console.log();
  info(`Starting benchmark: ${chalk.bold(coin)} — ${iterations} iterations`);
  console.log();

  const spinner = ora({
    text: `Running benchmark (0/${iterations})…`,
    spinner: 'dots12',
  }).start();

  try {
    const results = await runBenchmark(coin, iterations, (completed: number) => {
      spinner.text = `Running benchmark (${completed}/${iterations})…`;
    });

    spinner.succeed('Benchmark complete');
    console.log();

    // ── Results table (GENESIS 2.0 format) ─────────────────────────────
    const table = new Table({
      head: [
        chalk.cyan('Metric'),
        chalk.cyan('Value'),
      ].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [35, 25],
    });

    table.push(
      [chalk.bold('Instrument'), coin],
      [chalk.bold('Iterations'), iterations.toString()],
      ['', ''],
      [chalk.bold.underline('Latency'), ''],
      ['  REST L2 Snapshot (mean)', formatLatency(results.restL2Mean)],
      ['  REST L2 Snapshot (p50)', formatLatency(results.restL2P50)],
      ['  REST L2 Snapshot (p95)', formatLatency(results.restL2P95)],
      ['  REST L2 Snapshot (p99)', formatLatency(results.restL2P99)],
      ['  REST L2 Snapshot (min)', formatLatency(results.restL2Min)],
      ['  REST L2 Snapshot (max)', formatLatency(results.restL2Max)],
      ['', ''],
      ['  WebSocket First Update', formatLatency(results.wsFirstUpdate)],
      ['  WebSocket Avg Update', formatLatency(results.wsAvgUpdate)],
      ['', ''],
      [chalk.bold.underline('Throughput'), ''],
      ['  Messages/sec (WS)', results.wsMsgPerSec.toFixed(1)],
      ['  Updates processed', results.updatesProcessed.toString()],
      ['', ''],
      [chalk.bold.underline('Market Data Quality'), ''],
      ['  Book crossed', results.bookCrossed ? chalk.red('YES') : chalk.green('NO')],
      ['  Avg spread (bps)', results.avgSpreadBps.toFixed(2)],
      ['  Max spread (bps)', results.maxSpreadBps.toFixed(2)],
    );

    console.log(chalk.bold.cyan('  ⚡  GENESIS 2.0 — Latency Benchmark Report'));
    console.log(table.toString());
    console.log();

    // ── Optional JSON output ─────────────────────────────────────────────
    if (options.output) {
      const outputData = {
        coin,
        iterations,
        timestamp: new Date().toISOString(),
        results,
      };
      fs.writeFileSync(options.output, JSON.stringify(outputData, null, 2), 'utf-8');
      success(`Results saved to ${chalk.underline(options.output)}`);
    }
  } catch (err) {
    spinner.fail('Benchmark failed');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

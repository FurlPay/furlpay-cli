import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

import { fetchOrderBook, streamOrderBook } from '../services/market-data.js';
import { info, success, error, warn } from '../utils/logger.js';
import { formatBPS } from '../utils/formatting.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a visual depth bar using block characters.
 * Scales size relative to `maxSize` across `barWidth` columns.
 */
function depthBar(size: number, maxSize: number, barWidth = 20): string {
  if (maxSize <= 0) return '';
  const filled = Math.round((size / maxSize) * barWidth);
  return '█'.repeat(filled) + '░'.repeat(barWidth - filled);
}

/**
 * Render a formatted order book table and metrics panel to the console.
 */
function renderOrderBook(
  coin: string,
  bids: { price: number; size: number }[],
  asks: { price: number; size: number }[],
  metrics: {
    midPrice: number;
    microPrice: number;
    spreadBps: number;
    imbalanceRatio: number;
    ofi: number;
    topBidVolume: number;
    topAskVolume: number;
  },
): void {
  const allSizes = [...bids, ...asks].map((l) => l.size);
  const maxSize = Math.max(...allSizes, 0);

  // ── Order book table ───────────────────────────────────────────────────
  const table = new Table({
    head: [
      chalk.green('Bid Size'),
      chalk.green('Bid Depth'),
      chalk.green('Bid Price'),
      chalk.red('Ask Price'),
      chalk.red('Ask Depth'),
      chalk.red('Ask Size'),
    ].map((h) => chalk.bold(h)),
    style: { head: [], border: [] },
    colAligns: ['right', 'left', 'right', 'left', 'left', 'left'],
  });

  const levels = Math.max(bids.length, asks.length);
  for (let i = 0; i < levels; i++) {
    const bid = bids[i];
    const ask = asks[i];
    table.push([
      bid ? bid.size.toFixed(4) : '',
      bid ? chalk.green(depthBar(bid.size, maxSize)) : '',
      bid ? chalk.green(bid.price.toFixed(2)) : '',
      ask ? chalk.red(ask.price.toFixed(2)) : '',
      ask ? chalk.red(depthBar(ask.size, maxSize)) : '',
      ask ? ask.size.toFixed(4) : '',
    ]);
  }

  console.log();
  console.log(chalk.bold.cyan(`  📊  ${coin} Order Book`));
  console.log(table.toString());

  // ── Metrics panel ──────────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.cyan('  📐  Microstructure Metrics'));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log(`  ${chalk.cyan('Best Bid:')}        ${chalk.green(metrics.midPrice > 0 ? bids[0]?.price.toFixed(2) ?? '—' : '—')}`);
  console.log(`  ${chalk.cyan('Best Ask:')}        ${chalk.red(asks[0]?.price.toFixed(2) ?? '—')}`);
  console.log(`  ${chalk.cyan('Mid Price:')}       ${metrics.midPrice.toFixed(4)}`);
  console.log(`  ${chalk.cyan('Micro-Price:')}     ${metrics.microPrice.toFixed(4)}`);
  console.log(`  ${chalk.cyan('Spread:')}          ${formatBPS(metrics.spreadBps)}`);
  console.log(`  ${chalk.cyan('Top-5 Imbalance:')} ${(metrics.imbalanceRatio * 100).toFixed(2)}%`);
  console.log(`  ${chalk.cyan('OFI:')}             ${metrics.ofi >= 0 ? chalk.green('+' + metrics.ofi.toFixed(4)) : chalk.red(metrics.ofi.toFixed(4))}`);
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log();
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and display a point-in-time L2 order book snapshot for the given coin.
 */
export async function marketOrderbookCommand(
  coin: string,
  options: Record<string, unknown>,
): Promise<void> {
  const depth = typeof options.depth === 'number' ? options.depth : 10;
  const spinner = ora(`Fetching ${coin} order book…`).start();

  try {
    const { bids, asks, metrics } = await fetchOrderBook(coin, depth);
    spinner.succeed(`${coin} order book loaded`);

    renderOrderBook(coin, bids, asks, metrics);
  } catch (err) {
    spinner.fail(`Failed to fetch ${coin} order book`);
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Open a live WebSocket stream and continuously update the terminal with
 * the latest order book for the given coin.
 */
export async function marketStreamCommand(
  coin: string,
  options: Record<string, unknown>,
): Promise<void> {
  const depth = typeof options.depth === 'number' ? options.depth : 10;
  const spinner = ora(`Connecting to ${coin} live stream…`).start();

  let isShuttingDown = false;

  // Graceful shutdown handler
  const shutdown = (): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log();
    warn('Shutting down stream…');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await streamOrderBook(coin, depth, (data: any) => {
      if (isShuttingDown) return false; // signal the stream to stop

      if (spinner.isSpinning) {
        spinner.succeed(`Connected to ${coin} live stream`);
      }

      // Clear terminal and re-render
      process.stdout.write('\x1B[2J\x1B[H');
      console.log(chalk.gray(`  Live stream — ${new Date().toISOString()}  |  Press Ctrl+C to exit`));

      renderOrderBook(coin, data.bids, data.asks, data.metrics);

      return !isShuttingDown;
    });
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(`Failed to connect to ${coin} stream`);
    }
    if (!isShuttingDown) {
      error((err as Error).message);
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
    if (isShuttingDown) {
      success('Stream closed.');
    }
  }
}

/**
 * Execute a quantitative backtest comparing 4 microstructure strategies:
 *   1. Naive Micro-Price Momentum
 *   2. Top-5 Depth Imbalance
 *   3. Cont-Kukanov-Stoikov Event OFI (2014)
 *   4. FurlPay Hawkes Hybrid (2026)
 */
export async function marketBacktestCommand(
  coin: string,
  options: Record<string, unknown>,
): Promise<void> {
  const spinner = ora(`Running quantitative backtest for ${coin}…`).start();
  const fs = await import('fs');
  const path = await import('path');
  const { RobustBacktestEngine } = await import('../services/backtest.js');
  type MarketFeedEvent = import('../services/backtest.js').MarketFeedEvent;

  try {
    const filePath = typeof options.file === 'string' ? options.file : null;
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(
        `A valid historical JSONL recording file must be specified with --file <path> (e.g. --file session_audit_v2.jsonl). Synthetic data generation is disabled in research backtest mode.`,
      );
    }

    const events: MarketFeedEvent[] = [];
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const lines = rawContent.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const t = rec.exchange_event_time_ms || rec.data?.time || rec.local_receive_time_ns ? Math.floor(rec.local_receive_time_ns / 1_000_000) : Date.now();

        if (rec.type === 'l2Book' && rec.data?.levels) {
          const bids = rec.data.levels[0];
          const asks = rec.data.levels[1];
          if (bids.length > 0 && asks.length > 0) {
            const bPx = parseFloat(bids[0].px);
            const aPx = parseFloat(asks[0].px);
            const bSz = parseFloat(bids[0].sz);
            const aSz = parseFloat(asks[0].sz);

            if (bPx > 0 && aPx > bPx && bSz > 0 && aSz > 0) {
              events.push({
                kind: 'book',
                timestampMs: t,
                bidPrice: bPx,
                askPrice: aPx,
                bidSize: bSz,
                askSize: aSz,
              });
            }
          }
        } else if (rec.type === 'trade' && rec.data) {
          const rawSide = String(rec.data.side || '').toUpperCase();
          if (rawSide === 'B' || rawSide === 'A') {
            events.push({
              kind: 'trade',
              timestampMs: t,
              side: rawSide as 'B' | 'A',
              price: parseFloat(rec.data.px),
              size: parseFloat(rec.data.sz),
              tid: rec.data.tid ? Number(rec.data.tid) : undefined,
            });
          }
        }
      } catch {}
    }

    if (events.length < 5) {
      throw new Error(`Parsed only ${events.length} valid events from ${filePath}. At least 5 events required.`);
    }

    const engine = new RobustBacktestEngine(events, 1.0, 0.5, 1);
    const report = engine.evaluateAll(coin);
    spinner.succeed(
      `Backtest evaluated (${report.totalEventsProcessed} events: ${report.bookSnapshotsCount} books, ${report.tradesIngestedCount} trades over ${report.sessionDurationSec.toFixed(1)}s)`,
    );

    console.log();
    console.log(chalk.bold.cyan(`  🧪  Quantitative Microstructure Backtest: ${coin}/USD (Turnover-Based Execution)`));
    console.log(chalk.gray(`  Perimeter: 1.0 bps fee + 0.5 bps slippage per side (charged strictly on position transitions)`));
    console.log(chalk.gray(`  Execution Delay: 1 event | Look-Ahead Bias: Strictly Zero`));
    console.log();

    const table = new Table({
      head: [
        chalk.bold.white('Strategy Model'),
        chalk.bold.white('Net PnL'),
        chalk.bold.white('Gross PnL'),
        chalk.bold.white('Costs'),
        chalk.bold.white('Trades'),
        chalk.bold.white('Win Rate'),
        chalk.bold.white('Profit Fac'),
        chalk.bold.white('Max DD'),
        chalk.bold.white('Sharpe (1s)'),
      ],
      style: { head: [], border: [] },
      colAligns: ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    });

    for (const s of report.strategies) {
      const netColor = s.totalNetReturnPct >= 0 ? chalk.green : chalk.red;
      const netStr = (s.totalNetReturnPct >= 0 ? '+' : '') + s.totalNetReturnPct.toFixed(3) + '%';
      const grossStr = (s.grossReturnPct >= 0 ? '+' : '') + s.grossReturnPct.toFixed(3) + '%';

      table.push([
        chalk.bold(s.strategyName),
        netColor(netStr),
        grossStr,
        s.totalFrictionCostPct.toFixed(3) + '%',
        s.completedTradesCount.toString(),
        s.tradeWinRatePct.toFixed(1) + '%',
        s.profitFactor.toFixed(2),
        s.maxDrawdownPct.toFixed(2) + '%',
        s.timeNormalizedSharpe.toFixed(2),
      ]);
    }

    console.log(table.toString());
    console.log();
    console.log(chalk.bold.yellow('  ⚠️  Methodological Notice:'));
    console.log(chalk.gray('    Short session durations (< 30 min) provide indicative microstructure dynamics only.'));
    console.log(chalk.gray('    Full statistical validation requires walk-forward out-of-sample datasets over multiple volatility regimes.'));
    console.log();
  } catch (err) {
    spinner.fail(`Failed to execute backtest for ${coin}`);
    error((err as Error).message);
    process.exitCode = 1;
  }
}

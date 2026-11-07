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

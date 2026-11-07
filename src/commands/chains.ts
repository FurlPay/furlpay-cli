/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Multi-Chain Commands (Arc, Base, Arbitrum, Solana)
 * ─────────────────────────────────────────────────────────────
 */

import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { MultiChainRegistry } from '../services/chain-adapters.js';
import { info, success, error } from '../utils/logger.js';

export async function chainsStatusCommand(): Promise<void> {
  const spinner = ora('Pinging multi-chain consensus RPC gateways (Arc, Base, Arbitrum, Solana)…').start();
  const registry = new MultiChainRegistry();

  try {
    const statuses = await registry.checkAllChains();
    spinner.succeed('Multi-chain network status retrieved');

    console.log();
    console.log(chalk.bold.cyan('  🌐  Multi-Chain Network Connectivity Radar (2026)'));
    console.log(chalk.gray('  Status verified via live JSON-RPC block/slot inquiries'));
    console.log();

    const table = new Table({
      head: [
        chalk.bold.white('Network'),
        chalk.bold.white('Chain ID'),
        chalk.bold.white('Type'),
        chalk.bold.white('Block / Slot'),
        chalk.bold.white('Latency'),
        chalk.bold.white('RPC Gateway Status'),
      ],
      style: { head: [], border: [] },
      colAligns: ['left', 'center', 'center', 'right', 'right', 'center'],
    });

    for (const s of statuses) {
      const statusBadge =
        s.status === 'ONLINE'
          ? chalk.bold.green('● ONLINE')
          : s.status === 'DEGRADED'
          ? chalk.bold.yellow('▲ DEGRADED')
          : chalk.bold.red('✖ OFFLINE');

      table.push([
        chalk.bold(s.name),
        s.chainId,
        s.type.toUpperCase(),
        s.blockHeight > 0n ? s.blockHeight.toLocaleString() : '—',
        `${s.latencyMs} ms`,
        statusBadge,
      ]);
    }

    console.log(table.toString());
    console.log();
    console.log(chalk.bold.white('  Perimeter Rule:'));
    console.log(chalk.gray('  Live network connectivity is read-only. Fund transfers require signed policy authorization.'));
    console.log();
  } catch (err) {
    spinner.fail('Failed to query multi-chain network status');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

export async function chainsBalancesCommand(
  address: string,
  options: Record<string, unknown>,
): Promise<void> {
  const spinner = ora(`Inspecting multi-chain balances for ${address}…`).start();
  const registry = new MultiChainRegistry();

  try {
    const adapters = registry.getAllAdapters();
    spinner.succeed('Multi-chain balances retrieved');

    console.log();
    console.log(chalk.bold.cyan(`  💼  Multi-Chain Portfolio Balances: ${chalk.white(address)}`));
    console.log();

    const table = new Table({
      head: [
        chalk.bold.white('Network'),
        chalk.bold.white('Chain ID'),
        chalk.bold.white('Native Balance'),
        chalk.bold.white('Verification'),
      ],
      style: { head: [], border: [] },
      colAligns: ['left', 'center', 'right', 'center'],
    });

    for (const a of adapters) {
      let bal = '0.0000';
      let status = chalk.green('✓ Confirmed');
      try {
        bal = await a.getNativeBalance(address);
      } catch {
        status = chalk.dim('Address inactive');
      }

      table.push([
        chalk.bold(a.network),
        a.chainId,
        `${bal} ${a.chainId.startsWith('solana') ? 'SOL' : 'ETH/ARC'}`,
        status,
      ]);
    }

    console.log(table.toString());
    console.log();
  } catch (err) {
    spinner.fail('Failed to fetch multi-chain balances');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

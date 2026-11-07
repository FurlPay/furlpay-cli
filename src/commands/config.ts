import chalk from 'chalk';
import Table from 'cli-table3';

import {
  loadConfig,
  setConfig,
  resetConfig,
  type FurlPayConfig,
} from '../utils/config.js';
import { info, success, error, warn } from '../utils/logger.js';
import { formatNetworkName, shortenAddress } from '../utils/formatting.js';

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Display the current FurlPay configuration.
 */
export async function configShowCommand(): Promise<void> {
  const config = loadConfig();

  const table = new Table({
    head: [chalk.bold.cyan('Key'), chalk.bold.cyan('Value')],
    style: { head: [], border: [] },
    colWidths: [20, 50],
  });

  table.push(
    ['network', `${formatNetworkName(config.network)} (${config.network})`],
    ['rpcUrl', config.rpcUrl ?? chalk.gray('(default)')],
    ['facilitatorUrl', config.facilitatorUrl],
    [
      'privateKey',
      config.privateKey
        ? chalk.yellow(shortenAddress(config.privateKey))
        : chalk.gray('(not set)'),
    ],
    ['takeRateBps', config.takeRateBps?.toString() ?? chalk.gray('(default)')],
    ['maxPerTx', config.maxPerTx?.toString() ?? chalk.gray('(default)')],
    ['maxPerDay', config.maxPerDay?.toString() ?? chalk.gray('(default)')],
  );

  console.log();
  console.log(chalk.bold.cyan('  ⚙️   FurlPay Configuration'));
  console.log(table.toString());
  console.log();
  info(`Config file: ${chalk.underline('~/.furlpay/config.json')}`);
  console.log();
}

/**
 * Set a single configuration value.
 */
export async function configSetCommand(
  key: string,
  value: string,
): Promise<void> {
  const validKeys: (keyof FurlPayConfig)[] = [
    'privateKey',
    'network',
    'rpcUrl',
    'facilitatorUrl',
    'takeRateBps',
    'maxPerTx',
    'maxPerDay',
  ];

  if (!validKeys.includes(key as keyof FurlPayConfig)) {
    error(`Unknown config key: ${chalk.bold(key)}`);
    info(`Valid keys: ${validKeys.map((k) => chalk.cyan(k)).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Coerce numeric values
  const numericKeys: (keyof FurlPayConfig)[] = ['takeRateBps', 'maxPerTx', 'maxPerDay'];
  let coercedValue: string | number | null = value;

  if (numericKeys.includes(key as keyof FurlPayConfig)) {
    const num = parseFloat(value);
    if (isNaN(num)) {
      error(`Value for ${chalk.bold(key)} must be a number.`);
      process.exitCode = 1;
      return;
    }
    coercedValue = num;
  }

  // Allow clearing a value with "null" or empty string
  if (value === 'null' || value === '') {
    coercedValue = null;
  }

  try {
    setConfig(key as keyof FurlPayConfig, coercedValue as never);
    success(`${chalk.cyan(key)} set to ${chalk.bold(String(coercedValue))}`);
  } catch (err) {
    error(`Failed to set ${key}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/**
 * Reset configuration to defaults.
 */
export async function configResetCommand(): Promise<void> {
  warn('This will reset all configuration to defaults.');

  try {
    resetConfig();
    success('Configuration reset to defaults.');
    console.log();
    info('Run `furlpay init` to set up your wallet and network again.');
  } catch (err) {
    error(`Failed to reset configuration: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

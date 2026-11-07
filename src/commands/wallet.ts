import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';

import { generateWallet, loadWallet, getBalances } from '../services/wallet.js';
import { info, success, error, warn } from '../utils/logger.js';
import { loadConfig, saveConfig } from '../utils/config.js';
import { shortenAddress, formatNetworkName, formatUSD } from '../utils/formatting.js';

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new Ethereum wallet and optionally save it to the config.
 */
export async function walletGenerateCommand(
  options: Record<string, unknown>,
): Promise<void> {
  const spinner = ora('Generating new wallet…').start();

  try {
    const wallet = generateWallet();
    spinner.succeed('Wallet generated');

    console.log();
    console.log(chalk.bold.cyan('  🔑  New Wallet'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(`  ${chalk.cyan('Address:')}     ${wallet.address}`);
    console.log(`  ${chalk.cyan('Public Key:')}  ${wallet.publicKey}`);
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log();

    warn(
      chalk.bold('IMPORTANT: ') +
        'Save your private key securely. It will NOT be shown again unless you use --save.',
    );
    console.log(`  ${chalk.yellow('Private Key:')} ${wallet.privateKey}`);
    console.log();

    if (options.save) {
      saveConfig({ privateKey: wallet.privateKey });
      success('Wallet saved to configuration.');
      info(`Address: ${wallet.address}`);
    } else {
      info(
        `Use ${chalk.bold('furlpay wallet generate --save')} to save to config, ` +
          `or ${chalk.bold('furlpay init')} to set up interactively.`,
      );
    }
  } catch (err) {
    spinner.fail('Failed to generate wallet');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Display the native and USDC balance for the configured wallet on the
 * currently selected network.
 */
export async function walletBalanceCommand(
  options: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig();

  if (!config.privateKey) {
    error('No wallet configured. Run `furlpay init` or set FURLPAY_PRIVATE_KEY.');
    process.exitCode = 1;
    return;
  }

  const network = (options.network as string) ?? config.network;
  const wallet = loadWallet(config.privateKey);
  const spinner = ora(`Fetching balances on ${formatNetworkName(network)}…`).start();

  try {
    const balances = await getBalances(wallet.address, network);
    spinner.succeed('Balances loaded');

    const table = new Table({
      head: [
        chalk.cyan('Asset'),
        chalk.cyan('Balance'),
        chalk.cyan('Network'),
      ].map((h) => chalk.bold(h)),
      style: { head: [], border: [] },
      colAligns: ['left', 'right', 'left'],
    });

    table.push(
      [
        balances.nativeCurrency,
        balances.nativeBalance,
        formatNetworkName(network),
      ],
      [
        'USDC',
        balances.usdcBalance,
        formatNetworkName(network),
      ],
    );

    console.log();
    console.log(chalk.bold.cyan(`  💰  Wallet Balances — ${shortenAddress(wallet.address)}`));
    console.log(table.toString());
    console.log();
  } catch (err) {
    spinner.fail('Failed to fetch balances');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Display the currently configured wallet address.
 */
export async function walletAddressCommand(): Promise<void> {
  const config = loadConfig();

  if (!config.privateKey) {
    error('No wallet configured. Run `furlpay init` or set FURLPAY_PRIVATE_KEY.');
    process.exitCode = 1;
    return;
  }

  try {
    const wallet = loadWallet(config.privateKey);
    console.log();
    console.log(chalk.bold.cyan('  📇  Configured Wallet'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(`  ${chalk.cyan('Address:')} ${wallet.address}`);
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log();
  } catch (err) {
    error(`Failed to load wallet: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

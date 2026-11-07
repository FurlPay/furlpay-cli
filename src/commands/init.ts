import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';

import { saveConfig, loadConfig } from '../utils/config.js';
import { banner, info, success, warn, error } from '../utils/logger.js';
import {
  SUPPORTED_NETWORKS,
  DEFAULT_NETWORK,
  FACILITATOR_DEFAULT_URL,
} from '../utils/constants.js';
import { generateWallet, loadWallet } from '../services/wallet.js';

/**
 * Interactive initialization command.
 *
 * Walks the user through network selection, wallet setup, and facilitator
 * configuration, then persists the result to `~/.furlpay/config.json`.
 */
export async function initCommand(options: Record<string, unknown>): Promise<void> {
  banner();
  info('Welcome to FurlPay — Institutional x402 Payment Infrastructure');
  console.log();

  // ── Network selection ────────────────────────────────────────────────────
  const networkChoices = Array.from(SUPPORTED_NETWORKS.entries()).map(
    ([id, net]) => ({
      name: `${net.name} (${id})`,
      value: id,
    }),
  );

  const { network } = await inquirer.prompt<{ network: string }>([
    {
      type: 'list',
      name: 'network',
      message: 'Select settlement network:',
      choices: networkChoices,
      default: DEFAULT_NETWORK,
    },
  ]);

  // ── Wallet setup ─────────────────────────────────────────────────────────
  const { walletAction } = await inquirer.prompt<{ walletAction: string }>([
    {
      type: 'list',
      name: 'walletAction',
      message: 'Wallet setup:',
      choices: [
        { name: 'Generate a new wallet', value: 'generate' },
        { name: 'Import an existing private key', value: 'import' },
      ],
    },
  ]);

  let privateKey: string;
  let address: string;

  if (walletAction === 'import') {
    const { importedKey } = await inquirer.prompt<{ importedKey: string }>([
      {
        type: 'password',
        name: 'importedKey',
        message: 'Enter your private key:',
        mask: '*',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (!trimmed) return 'Private key is required.';
          if (!/^(0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
            return 'Invalid private key format. Expected 64 hex characters (optionally 0x-prefixed).';
          }
          return true;
        },
      },
    ]);

    const spinner = ora('Loading wallet…').start();
    try {
      const wallet = loadWallet(importedKey.trim());
      privateKey = importedKey.trim();
      address = wallet.address;
      spinner.succeed('Wallet loaded successfully');
    } catch (err) {
      spinner.fail('Failed to load wallet');
      error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  } else {
    const spinner = ora('Generating new wallet…').start();
    try {
      const wallet = generateWallet();
      privateKey = wallet.privateKey;
      address = wallet.address;
      spinner.succeed('New wallet generated');
    } catch (err) {
      spinner.fail('Failed to generate wallet');
      error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  }

  // ── Facilitator URL ──────────────────────────────────────────────────────
  const { facilitatorUrl } = await inquirer.prompt<{ facilitatorUrl: string }>([
    {
      type: 'input',
      name: 'facilitatorUrl',
      message: 'Facilitator URL:',
      default: FACILITATOR_DEFAULT_URL,
      validate: (input: string) => {
        try {
          new URL(input);
          return true;
        } catch {
          return 'Please enter a valid URL.';
        }
      },
    },
  ]);

  // ── Persist configuration ────────────────────────────────────────────────
  const spinner = ora('Saving configuration…').start();
  try {
    saveConfig({
      network,
      privateKey,
      facilitatorUrl,
    });
    spinner.succeed('Configuration saved');
  } catch (err) {
    spinner.fail('Failed to save configuration');
    error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const selectedNetwork = SUPPORTED_NETWORKS.get(network);
  console.log();
  success('FurlPay initialized successfully!');
  console.log();
  console.log(chalk.bold('  Configuration Summary'));
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log(`  ${chalk.cyan('Network:')}        ${selectedNetwork?.name ?? network}`);
  console.log(`  ${chalk.cyan('Wallet:')}         ${address}`);
  console.log(`  ${chalk.cyan('Facilitator:')}    ${facilitatorUrl}`);
  console.log(chalk.gray('  ─────────────────────────────────────'));
  console.log();

  if (walletAction === 'generate') {
    warn(
      'Your private key has been saved to the config file. ' +
        'Back it up securely and never share it.',
    );
  }

  info(`Run ${chalk.bold('furlpay wallet balance')} to check your wallet balance.`);
}

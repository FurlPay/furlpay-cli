import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import fs from 'node:fs';

import {
  createChallenge,
  signAuthorization,
  verifyAuthorization,
  lookupTransaction,
} from '../services/x402-facilitator.js';
import { loadWallet } from '../services/wallet.js';
import { info, success, error, warn } from '../utils/logger.js';
import { loadConfig } from '../utils/config.js';
import { formatUSD, shortenAddress, formatNetworkName } from '../utils/formatting.js';

import type { PaymentChallenge, PaymentAuthorization } from '../types/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a challenge JSON string — supports either raw JSON or a file path
 * prefixed with `@` (e.g. `@challenge.json`).
 */
function parseChallenge(input: string): PaymentChallenge {
  let raw = input.trim();
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    raw = fs.readFileSync(filePath, 'utf-8');
  }
  try {
    return JSON.parse(raw) as PaymentChallenge;
  } catch {
    throw new Error('Invalid JSON. Provide a valid payment challenge JSON string or @filepath.');
  }
}

/**
 * Parse an authorization JSON string — supports raw JSON or `@` file path.
 */
function parseAuthorization(input: string): PaymentAuthorization {
  let raw = input.trim();
  if (raw.startsWith('@')) {
    const filePath = raw.slice(1);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    raw = fs.readFileSync(filePath, 'utf-8');
  }
  try {
    return JSON.parse(raw) as PaymentAuthorization;
  } catch {
    throw new Error('Invalid JSON. Provide a valid payment authorization JSON string or @filepath.');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new x402 payment challenge.
 */
export async function payCreateCommand(
  options: {
    to: string;
    amount: string;
    asset?: string;
    network?: string;
    scheme?: string;
    json?: boolean;
  },
): Promise<void> {
  const config = loadConfig();
  const network = options.network ?? config.network;

  const spinner = ora('Creating payment challenge…').start();

  try {
    const challenge = await createChallenge({
      payTo: options.to,
      amount: options.amount,
      asset: options.asset,
      networkId: network,
      scheme: (options.scheme as 'exact' | 'upto' | 'batch') ?? 'exact',
    });

    spinner.succeed('Payment challenge created');

    if (options.json) {
      console.log(JSON.stringify(challenge, null, 2));
      return;
    }

    // ── Formatted display ──────────────────────────────────────────────
    console.log();
    console.log(chalk.bold.cyan('  💳  x402 Payment Challenge'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(`  ${chalk.cyan('Pay To:')}      ${challenge.payTo}`);
    console.log(`  ${chalk.cyan('Amount:')}      ${challenge.amount}`);
    console.log(`  ${chalk.cyan('Asset:')}       ${challenge.asset}`);
    console.log(`  ${chalk.cyan('Network:')}     ${formatNetworkName(challenge.networkId)}`);
    console.log(`  ${chalk.cyan('Scheme:')}      ${challenge.scheme}`);
    console.log(`  ${chalk.cyan('Nonce:')}       ${shortenAddress(challenge.nonce)}`);
    console.log(`  ${chalk.cyan('Expiry:')}      ${challenge.expiry}`);
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log();

    // ── HTTP 402 response headers ──────────────────────────────────────
    console.log(chalk.bold('  HTTP 402 Response Headers:'));
    console.log(chalk.gray(`    X-Payment-Version: x402-v2`));
    console.log(chalk.gray(`    X-Payment-Challenge: ${JSON.stringify(challenge)}`));
    console.log();
  } catch (err) {
    spinner.fail('Failed to create payment challenge');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Sign a payment challenge with the configured wallet to produce an
 * EIP-3009 authorization.
 */
export async function paySignCommand(
  challengeJson: string,
  options: Record<string, unknown>,
): Promise<void> {
  // ── Parse challenge ────────────────────────────────────────────────────
  let challenge: PaymentChallenge;
  try {
    challenge = parseChallenge(challengeJson);
  } catch (err) {
    error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  // ── Load wallet ────────────────────────────────────────────────────────
  const config = loadConfig();
  if (!config.privateKey) {
    error('No wallet configured. Run `furlpay init` or set FURLPAY_PRIVATE_KEY.');
    process.exitCode = 1;
    return;
  }

  const spinner = ora('Signing EIP-3009 authorization…').start();

  try {
    const wallet = loadWallet(config.privateKey);
    const authorization = await signAuthorization(challenge, wallet);
    spinner.succeed('Authorization signed');

    if (options.json) {
      console.log(JSON.stringify(authorization, null, 2));
      return;
    }

    // ── Display ──────────────────────────────────────────────────────────
    console.log();
    console.log(chalk.bold.cyan('  ✍️   Signed Authorization'));
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log(`  ${chalk.cyan('Payer:')}      ${authorization.payer}`);
    console.log(`  ${chalk.cyan('Nonce:')}      ${shortenAddress(authorization.nonce)}`);
    console.log(`  ${chalk.cyan('Signature:')} ${shortenAddress(authorization.signature)}`);
    console.log(chalk.gray('  ─────────────────────────────────────'));
    console.log();

    // ── Complete HTTP request headers ────────────────────────────────────
    console.log(chalk.bold('  HTTP Request Headers:'));
    console.log(chalk.gray(`    X-Payment-Version: x402-v2`));
    console.log(chalk.gray(`    X-Payment-Authorization: ${JSON.stringify(authorization)}`));
    console.log();
  } catch (err) {
    spinner.fail('Failed to sign authorization');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Verify a payment challenge + authorization pair.
 */
export async function payVerifyCommand(
  challengeJson: string,
  authJson: string,
): Promise<void> {
  // ── Parse inputs ───────────────────────────────────────────────────────
  let challenge: PaymentChallenge;
  let authorization: PaymentAuthorization;
  try {
    challenge = parseChallenge(challengeJson);
    authorization = parseAuthorization(authJson);
  } catch (err) {
    error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const spinner = ora('Verifying authorization…').start();

  try {
    const result = await verifyAuthorization(challenge, authorization);

    if (result.valid) {
      spinner.succeed('Verification passed');
      console.log();
      console.log(chalk.bold.green('  ✅  Authorization is VALID'));
      console.log(chalk.gray('  ─────────────────────────────────────'));
      console.log(`  ${chalk.cyan('Signer:')}  ${result.signer ?? authorization.payer}`);
      console.log(`  ${chalk.cyan('Nonce:')}   ${shortenAddress(authorization.nonce)}`);
      console.log(chalk.gray('  ─────────────────────────────────────'));
    } else {
      spinner.fail('Verification failed');
      console.log();
      console.log(chalk.bold.red('  ❌  Authorization is INVALID'));
      if (result.reason) {
        console.log(`  ${chalk.red('Reason:')} ${result.reason}`);
      }
    }
    console.log();
  } catch (err) {
    spinner.fail('Verification error');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * Look up the on-chain status of a payment settlement transaction.
 */
export async function payStatusCommand(
  txHash: string,
  options: Record<string, unknown>,
): Promise<void> {
  const config = loadConfig();
  const network = (options.network as string) ?? config.network;

  const spinner = ora(`Looking up transaction ${shortenAddress(txHash)}…`).start();

  try {
    const status = await lookupTransaction(txHash, network);

    if (!status) {
      spinner.warn('Transaction not found');
      warn('The transaction may still be pending or the hash may be incorrect.');
      return;
    }

    spinner.succeed('Transaction found');

    const table = new Table({
      style: { head: [], border: [] },
    });

    table.push(
      [chalk.cyan('Tx Hash'), status.txHash],
      [chalk.cyan('Network'), formatNetworkName(network)],
      [chalk.cyan('Block'), status.blockNumber?.toString() ?? 'pending'],
      [chalk.cyan('Status'), status.status === 'settled'
        ? chalk.green(status.status)
        : status.status === 'failed'
          ? chalk.red(status.status)
          : chalk.yellow(status.status)],
      [chalk.cyan('Amount'), status.amount ?? '—'],
      [chalk.cyan('Timestamp'), status.timestamp
        ? new Date(status.timestamp * 1000).toISOString()
        : '—'],
    );

    console.log();
    console.log(table.toString());
    console.log();
  } catch (err) {
    spinner.fail('Failed to look up transaction');
    error((err as Error).message);
    process.exitCode = 1;
  }
}

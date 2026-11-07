#!/usr/bin/env node

/**
 * FurlPay CLI — Institutional x402 Payment Infrastructure
 *
 * The developer-facing command-line interface for the FurlPay
 * financial orchestration network. Provides:
 *
 *   - x402 v2 payment challenge creation, signing, and verification
 *   - Live mainnet CLOB market data (Hyperliquid L1)
 *   - Microstructure analytics (micro-price, OFI, spread, imbalance)
 *   - Agent wallet generation and management
 *   - Empirical latency benchmarking suite
 *
 * @module @furlpay/cli
 * @version 0.1.0
 * @see https://github.com/FurlPay/furlpay-cli
 */

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import {
  marketOrderbookCommand,
  marketStreamCommand,
} from './commands/market.js';
import {
  payCreateCommand,
  paySignCommand,
  payVerifyCommand,
  payStatusCommand,
} from './commands/pay.js';
import {
  walletGenerateCommand,
  walletBalanceCommand,
  walletAddressCommand,
} from './commands/wallet.js';
import { benchmarkCommand } from './commands/benchmark.js';
import {
  configShowCommand,
  configSetCommand,
  configResetCommand,
} from './commands/config.js';
import { banner } from './utils/logger.js';

const program = new Command();

// ── Banner ──────────────────────────────────────────────────────────────
banner();

// ── Program Metadata ────────────────────────────────────────────────────
program
  .name('furlpay')
  .version('0.1.0')
  .description(
    'FurlPay CLI — Institutional x402 payment facilitation, mainnet CLOB market data, and autonomous agent settlement infrastructure'
  );

// ── furlpay init ────────────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize FurlPay configuration (wallet, network, facilitator)')
  .option('--network <networkId>', 'CAIP-2 network ID (e.g., eip155:8453)')
  .option('--key <privateKey>', 'Import existing private key')
  .action(initCommand);

// ── furlpay market ──────────────────────────────────────────────────────
const market = program
  .command('market')
  .description('Live mainnet CLOB market data and microstructure analytics');

market
  .command('orderbook <coin>')
  .description('Fetch L2 order book snapshot with microstructure metrics')
  .option('-d, --depth <levels>', 'Number of price levels to display', '10')
  .option('--json', 'Output as JSON')
  .action(marketOrderbookCommand);

market
  .command('stream <coin>')
  .description('Stream live L2 order book updates via WebSocket')
  .option('-d, --depth <levels>', 'Number of price levels', '10')
  .action(marketStreamCommand);

// ── furlpay pay ─────────────────────────────────────────────────────────
const pay = program
  .command('pay')
  .description('x402 v2 payment challenge creation, signing, and verification');

pay
  .command('create')
  .description('Create a new x402 payment challenge (402 response)')
  .requiredOption('--to <address>', 'Payee address (0x...)')
  .requiredOption('--amount <usdc>', 'Payment amount in USDC')
  .option('--asset <address>', 'ERC-20 token address (default: USDC)')
  .option('--network <networkId>', 'CAIP-2 network ID')
  .option('--scheme <scheme>', 'Payment scheme: exact | upto | batch', 'exact')
  .option('--expiry <seconds>', 'Challenge expiry in seconds', '300')
  .option('--json', 'Output as JSON')
  .action(payCreateCommand);

pay
  .command('sign <challenge>')
  .description('Sign an x402 payment authorization (EIP-3009)')
  .option('--key <privateKey>', 'Private key (overrides config)')
  .option('--json', 'Output as JSON')
  .action(paySignCommand);

pay
  .command('verify <challenge> <authorization>')
  .description('Verify an x402 payment authorization signature')
  .action(payVerifyCommand);

pay
  .command('status <txHash>')
  .description('Check payment transaction status on-chain')
  .option('--network <networkId>', 'CAIP-2 network ID')
  .action(payStatusCommand);

// ── furlpay wallet ──────────────────────────────────────────────────────
const wallet = program
  .command('wallet')
  .description('Agent wallet generation and management');

wallet
  .command('generate')
  .description('Generate a new Ethereum wallet for agent operations')
  .option('--save', 'Save generated wallet to config')
  .action(walletGenerateCommand);

wallet
  .command('balance')
  .description('Check wallet balance (native + USDC)')
  .option('--network <networkId>', 'CAIP-2 network ID')
  .action(walletBalanceCommand);

wallet
  .command('address')
  .description('Show current configured wallet address')
  .action(walletAddressCommand);

// ── furlpay benchmark ───────────────────────────────────────────────────
program
  .command('benchmark')
  .description(
    'Run empirical latency benchmarks against Layer 1 consensus engine'
  )
  .option('-c, --coin <coin>', 'Asset to benchmark', 'BTC')
  .option('-n, --iterations <n>', 'Number of benchmark iterations', '15')
  .option('-o, --output <path>', 'Save results to JSON file')
  .action(benchmarkCommand);

// ── furlpay config ──────────────────────────────────────────────────────
const config = program
  .command('config')
  .description('Manage FurlPay CLI configuration');

config
  .command('show')
  .description('Display current configuration')
  .action(configShowCommand);

config
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action(configSetCommand);

config
  .command('reset')
  .description('Reset configuration to defaults')
  .action(configResetCommand);

// ── Parse & Execute ─────────────────────────────────────────────────────
program.parse();

/**
 * FurlPay SDK — Programmatic API for x402 payment infrastructure
 *
 * This is the library entry point for using FurlPay as a dependency
 * in Node.js applications. For the CLI, use `furlpay` command.
 *
 * @example
 * ```ts
 * import { MarketDataService, X402Facilitator, WalletService } from '@furlpay/cli';
 *
 * // Fetch live order book from Hyperliquid L1
 * const market = new MarketDataService();
 * const snapshot = await market.getOrderBook('BTC');
 * const metrics = market.calculateMicrostructure(snapshot);
 * console.log(`Micro-Price: $${metrics.microPrice.toFixed(2)}`);
 *
 * // Create x402 payment challenge
 * const facilitator = new X402Facilitator({ networkId: 'eip155:8453' });
 * const challenge = facilitator.createChallenge({
 *   payTo: '0x9A4b...FurlPayOrchestrator',
 *   asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
 *   amount: '2500',
 *   scheme: 'exact',
 * });
 * ```
 *
 * @module @furlpay/cli
 */

// ── Types ───────────────────────────────────────────────────────────────
export type {
  PaymentScheme,
  NetworkId,
  PaymentChallenge,
  PaymentAuthorization,
  PaymentReceipt,
  PaymentStatus,
  OrderBookLevel,
  OrderBookSnapshot,
  MicrostructureMetrics,
  MarketDataConfig,
  AgentIdentity,
  SpendingPolicy,
  AgentSession,
  FurlPayConfig,
  CLIContext,
  EscrowState,
  SettlementRecord,
} from './types/index.js';

// ── Services ────────────────────────────────────────────────────────────
export { MarketDataService } from './services/market-data.js';
export { X402Facilitator } from './services/x402-facilitator.js';
export { WalletService } from './services/wallet.js';
export { BenchmarkService } from './services/benchmark.js';

// ── Utilities ───────────────────────────────────────────────────────────
export { SUPPORTED_NETWORKS, DEFAULT_NETWORK, X402_VERSION } from './utils/constants.js';
export { loadConfig, saveConfig } from './utils/config.js';
export {
  formatUSD,
  formatBPS,
  formatLatency,
  formatVolume,
  shortenAddress,
} from './utils/formatting.js';

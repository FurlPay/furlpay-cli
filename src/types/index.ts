/**
 * @module @furlpay/cli/types
 * @description Core TypeScript type definitions for the FurlPay CLI.
 *
 * Covers the full lifecycle of x402-compliant programmatic payments:
 * challenge → authorization → settlement, plus market-data ingestion,
 * autonomous-agent identity (MAS SAFR), escrow state management, and benchmarking.
 *
 * @see https://www.x402.org — x402 Payment Required Protocol (v2)
 * @see https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md — CAIP-2 Network IDs
 */

// ─────────────────────────────────────────────────────────────────────────────
// §1  x402 Payment Types
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentScheme = 'exact' | 'upto' | 'batch';
export type NetworkId = string;

export interface PaymentChallenge {
  payTo: string;
  asset: string;
  amount: string;
  networkId: NetworkId;
  nonce: string;
  scheme: PaymentScheme;
  expiry: string | number;
  extra?: Record<string, unknown>;
}

export interface PaymentAuthorization {
  signature: string;
  payer: string;
  nonce: string;
  from?: string;
  to?: string;
  value?: string;
  validAfter?: number | string;
  validBefore?: number | string;
}

export type PaymentStatus = 'pending' | 'authorized' | 'settled' | 'failed' | 'refunded';

export interface PaymentReceipt {
  txHash: string;
  blockNumber: number;
  timestamp: number;
  networkId: NetworkId;
  amount: string;
  status: PaymentStatus;
  challengeNonce?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2  Market Data Types — L2 CLOB Order Book
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;
  size: number;
  numOrders?: number;
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
  time?: number;
  coin: string;
}

export interface MicrostructureMetrics {
  midPrice: number;
  microPrice: number;
  spreadBps: number;
  ofi: number;
  topBidVolume: number;
  topAskVolume: number;
  imbalanceRatio: number;
}

export interface MarketDataConfig {
  coin: string;
  depth: number;
  refreshMs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  Agent Identity Types — MAS SAFR Alignment
// ─────────────────────────────────────────────────────────────────────────────

export type AttestationType = 'kyb' | 'tee' | 'self-declared';

export interface AgentIdentity {
  agentId: string;
  parentEntityId: string;
  attestationType: AttestationType;
  publicKey: string;
  registeredAt: string;
}

export interface SpendingPolicy {
  maxPerTx: string;
  maxPerDay: string;
  maxPerMinute: string;
  cooldownMs: number;
  requireHITL: boolean;
  hitlThreshold: string;
}

export interface AgentSession {
  sessionId: string;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  spentToday: string;
  txCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  Configuration Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FurlPayConfig {
  network: NetworkId;
  rpcUrl?: string;
  wsUrl?: string;
  privateKey?: string;
  agentId?: string;
  facilitatorUrl?: string;
}

export interface CLIContext {
  config: FurlPayConfig;
  verbose: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  Settlement & Escrow Types
// ─────────────────────────────────────────────────────────────────────────────

export type EscrowState = 'locked' | 'released' | 'refunded' | 'expired';

export interface SettlementRecord {
  escrowId: string;
  paymentHash: string;
  payer: string;
  payee: string;
  amount: string;
  asset: string;
  lockedAt: string;
  ttlMs: number;
  state: EscrowState;
  deliveryProofHash?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  Benchmarking Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LatencyStats {
  median: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
}

export interface BenchmarkResults {
  coin: string;
  iterations: number;
  timestamp: string;
  httpRtt: LatencyStats;
  jsonParse: LatencyStats;
  microstructure: LatencyStats;
  totalOverhead: LatencyStats;
  restL2Mean: number;
  restL2P50: number;
  restL2P95: number;
  restL2P99: number;
  restL2Min: number;
  restL2Max: number;
  wsFirstUpdate: number;
  wsAvgUpdate: number;
  wsMsgPerSec: number;
  updatesProcessed: number;
  bookCrossed: boolean;
  avgSpreadBps: number;
  maxSpreadBps: number;
}

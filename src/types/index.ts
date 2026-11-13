/**
 * FurlPay CLI — TypeScript Core Types & Interfaces
 * Stellar Tokenized Equities, RWAs, SDEX/Soroban Trading, x402 Micropayments & MCP.
 */

export type NetworkProfile = "mainnet" | "testnet";

export interface NetworkConfig {
  horizonUrl: string;
  sorobanRpcUrl: string;
  passphrase: string;
  furlpayGateway: string;
  sponsorshipEndpoint: string;
}

export interface TradingConfig {
  defaultSlippagePct: number;
  defaultPostOnly: boolean;
  maxPriceImpactPct: number;
  autoDetectSep8: boolean;
  autoSweepYield: boolean;
}

export interface AgentTrustConfig {
  maxSingleTxUsd: number;
  dailyVelocityCapUsd: number;
  enforceOfacSdn: boolean;
  anomalyThreshold: number;
}

export interface UIConfig {
  theme: "dark" | "light" | "terminal";
  orderbookDepth: number;
  refreshIntervalMs: number;
}

export interface WalletConfig {
  defaultAccount: string;
  keyringBackend: "os_keychain" | "encrypted_file" | "memory";
  autoLockMinutes: number;
}

export interface FurlPayConfig {
  network: {
    activeProfile: NetworkProfile;
    mainnet: NetworkConfig;
    testnet: NetworkConfig;
  };
  wallet: WalletConfig;
  trading: TradingConfig;
  agent_trust: AgentTrustConfig;
  ui: UIConfig;
}

export type OrderSide = "buy" | "sell";

export interface LimitOrderParams {
  side: OrderSide;
  asset: string;       // Format: CODE:ISSUER or CODE for native XLM
  against: string;     // Counter asset, e.g. USDC:GA5Z...
  amount: string;      // Amount of base asset
  price: string;       // Price in counter asset
  postOnly?: boolean;
  fok?: boolean;
  ioc?: boolean;
  sponsor?: boolean;
}

export interface MarketBuyParams {
  asset: string;       // Target asset to buy
  with: string;        // Source asset to spend
  spend: string;       // Exact amount of source asset
  slippage?: number;   // Max slippage percentage (e.g. 0.5%)
  sponsor?: boolean;
}

export interface SwapParams {
  poolId: string;      // Soroban AMM pool contract address
  sellAsset: string;
  sellAmount: string;
  minReceive: string;
  asset: string;
  sponsor?: boolean;
}

export interface OrderRecord {
  id: string;
  seller: string;
  selling: { code: string; issuer?: string };
  buying: { code: string; issuer?: string };
  amount: string;
  price: string;
  lastModifiedLedger?: number;
}

export type RwaCategory = "equities" | "treasuries" | "yield" | "all";

export interface RwaAsset {
  code: string;
  issuer: string;
  name: string;
  category: "equities" | "treasuries" | "yield";
  requiresSep8: boolean;
  // No `apy` and no `approvalServer` here, deliberately: hardcoded yields
  // and bundled compliance URLs would be fabrication. Resolve both from the
  // issuer's signed stellar.toml / live registry data at display time.
  regime: string;      // e.g. "SEC Reg D / Reg S", "MiCA", "MAS"
  cik?: string;
  description: string;
}

export interface Sep8ComplianceResult {
  approved: boolean;
  status: "success" | "revised" | "pending" | "action_required" | "rejected";
  signedXdr?: string;
  actionUrl?: string;
  message?: string;
  tier?: string;
}

export interface X402Challenge {
  scheme: string;
  recipient: string;
  amount: string;
  token: string;
  nonce: string;
  memo?: string;
  maxCost?: number;
}

export interface X402PaymentResult {
  status: "SETTLED" | "REJECTED" | "HELD" | "SIMULATED";
  txId: string;
  settlementType: "TIGERBEETLE_NETTING" | "STELLAR_ONCHAIN" | "LOCAL_SIMULATION";
  amount: string;
  recipient: string;
  fee: string;
  authorizationHeader: string;
  timestamp: string;
}

export interface AgentPolicy {
  agentName: string;
  publicKey: string;
  dailyLimitUsd: number;
  spentTodayUsd: number;
  allowedAssets: string[];
  singleTxCapUsd: number;
  expiryTimestamp: number;
}

export interface McpToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface SignerInterface {
  getPublicKey(): Promise<string>;
  signTransaction(txXdr: string): Promise<string>;
  signChallenge?(challenge: string): Promise<string>;
  clearSignVerification?(details: {
    operation: string;
    buying?: string;
    selling?: string;
    amount?: string;
    price?: string;
    destination?: string;
  }): Promise<boolean>;
}

export interface HlpVaultInfo {
  vaultAddress: string;
  /** Live vault equity derived from portfolio account-value history; null when the validator returned no history. */
  totalEquityUsd: number | null;
  /** Not derivable from public vaultDetails — null unless a live source publishes it. Never a fabricated NAV. */
  sharePriceUsd: number | null;
  aprFraction?: number;
  aprPercent?: number;
  /** Live trailing APY from the vault's reported APR; null when the API returned none. */
  trailing30dApyPct: number | null;
  /** Live all-time PnL derived from portfolio pnl history; null when unavailable. */
  allTimePnlUsd: number | null;
  /** Not reported by public vaultDetails — always null. */
  activePositionsCount: number | null;
  lockingPeriodSeconds?: number;
  lockupNotice?: string;
}

export interface HlpDepositResult {
  status: "CONFIRMED";
  txHash: string;
  amountDepositedUsd: number;
  /** Shares are computed by the exchange at settlement; null when no live share price is available. */
  sharesMinted: number | null;
  effectiveSharePrice: number | null;
  currentApyPct: number | null;
  venue: "HYPERLIQUID_L1";
}

export interface PerpOrderParams {
  symbol: string;
  side: OrderSide;
  size: number;
  price?: number;
  orderType: "limit" | "market";
  leverage: number;
  reduceOnly?: boolean;
}

export interface PerpExecutionResult {
  status: "FILLED" | "RESTING";
  orderId: string;
  symbol: string;
  side: OrderSide;
  size: number;
  fillPrice: number;
  notionalUsd: number;
  marginRequirementUsd: number;
  liquidationPriceEstimated: number;
  txHash: string;
  venue: "HYPERLIQUID_L1";
}

export interface PerpPosition {
  symbol: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnlUsd: number;
  returnOnEquityPct: number;
  liquidationPrice: number;
  leverage: number;
}

import type { OrderBookLevel } from "../market/types";

export interface NormalizedMarketEvent {
  asset: string;
  bidLevels: OrderBookLevel[];
  askLevels: OrderBookLevel[];
  timestamp: string;
  provenance: string;
}

export interface LatencyTelemetry {
  exchangeTimestampMs: number;
  localReceiptTimestampMs: number;
  normalizationDurationMs: number;
  renderDiffDurationMs: number;
  totalDeliveryLatencyMs: number;
  clockDriftMs: number;
}

export interface RiskInvariants {
  maxLeverage: number;
  maxDrawdownBps: number;
  maxSlippageBps: number;
  quoteMaxAgeMs: number;
}

export interface TradeOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  amountUsd: number;
  quotePrice: number;
  quoteTimestampMs: number;
}

export interface CandleStick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}



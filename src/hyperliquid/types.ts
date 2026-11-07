/**
 * Hyperliquid L1 & Market Microstructure Type Definitions
 */

export type HyperliquidNetwork = "mainnet" | "testnet";

export interface HyperliquidAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  marginTableId?: number;
  onlyIsolated?: boolean;
}

export interface HyperliquidMeta {
  universe: HyperliquidAssetMeta[];
}

export interface HyperliquidAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium?: string;
  oraclePx: string;
  markPx: string;
  midPx: string;
  impactPxs?: string[];
  dayBaseVlm?: string;
}

export interface HyperliquidL2Level {
  px: string;
  sz: string;
  n: number;
}

export interface HyperliquidL2Book {
  coin: string;
  time: number;
  levels: [HyperliquidL2Level[], HyperliquidL2Level[]]; // [bids, asks]
  receivedAtMs?: number;
  ageMs?: number;
  isStale?: boolean;
  source?: "websocket" | "rest";
}

export interface HyperliquidClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
  crossMaintenanceMarginUsed?: string;
  withdrawable: string;
  assetPositions: Array<{
    type?: string;
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      liquidationPx: string;
      leverage: { type: "cross" | "isolated"; value: number; rawUsd?: string };
      maxLeverage?: number;
      cumFunding?: { allTime: string; sinceOpen: string; sinceChange: string };
    };
  }>;
  time: number;
}

export interface HyperliquidOpenOrder {
  coin: string;
  side: "B" | "A";
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string;
  orderType?: string;
}

export interface HyperliquidUserFill {
  closedPnl: string;
  coin: string;
  crossed: boolean;
  fee: string;
  oid: number;
  px: string;
  side: "B" | "A";
  startPosition: string;
  sz: string;
  time: number;
  txHash?: string;
  dir?: string;
  hash?: string;
}

export interface HyperliquidVaultDetails {
  name: string;
  leader: string;
  apr: number;
  allowDeposits: boolean;
  lockingPeriod?: number; // lockup seconds (typically 4 days = 345,600s)
  portfolio?: any;
}

// ---- Market Microstructure Types -------------------------------------------

export interface OrderFlowImbalanceTick {
  timestamp: number;
  ofiDelta: number;
  cumulativeOfi: number;
  bestBidPx: number;
  bestBidSz: number;
  bestAskPx: number;
  bestAskSz: number;
}

export interface MicrostructureAnalytics {
  coin: string;
  timestamp: number;
  midPrice: number;
  microPrice: number;
  volumeWeightedSpread: number;
  rollingOfi: number;
  liquidityHhi: number; // 0 to 1, higher = more concentrated
  bidDepthTotal: number;
  askDepthTotal: number;
  depth10BpsUsd?: number;
  depth25BpsUsd?: number;
  depth50BpsUsd?: number;
  exchangeTimestampMs?: number;
  receivedAtMs?: number;
  feedLatencyMs?: number;
  source?: "websocket" | "rest";
  isStale: boolean;
}

export interface BookValidationResult {
  valid: boolean;
  errors: string[];
  isCrossed: boolean;
  bestBid: number;
  bestAsk: number;
  spread: number;
  timestamp: number;
  levelsCount: { bids: number; asks: number };
}

export interface SlippageEstimate {
  targetSize: number;
  targetNotionalUsd: number;
  side: "buy" | "sell";
  expectedAvgPrice: number;
  priceImpactPct: number;
  slippageUsd: number;
  canFillFully: boolean;
}

// ---- Risk Engine Types ----------------------------------------------------

export interface TradingRiskLimits {
  maxSingleOrderUsd: number;
  maxPositionNotionalUsd: number;
  maxLeverage: number;
  dailyTurnoverCapUsd: number;
  maxFatFingerPct: number; // e.g. 15% deviation from mid
  minOrderNotionalUsd: number;
}

export interface RiskCheckResult {
  passed: boolean;
  reason?: string;
  marginRatio?: number;
  distanceToLiquidationPct?: number;
}

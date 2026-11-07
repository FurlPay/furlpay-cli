/**
 * FurlPay Universal Market Discovery Engine — Type Definitions
 * 
 * Strict architectural contracts for dynamic, zero-hardcoded market discovery,
 * provider-driven venue registration, capability discovery, and live data provenance.
 */

export type ChainId = 
  | "hyperliquid" 
  | "stellar" 
  | "ethereum" 
  | "solana" 
  | "arbitrum" 
  | "base" 
  | "polygon" 
  | "avalanche" 
  | "bnb" 
  | "optimism"
  | string;

export type MarketType = "perpetual" | "spot" | "amm" | "tokenized_equity" | "rwa";

/**
 * 5 Distinct Stages of Asset and Market Support
 * Crucial Rule: Discovering an asset or market does NOT imply trading support.
 */
export type SupportStatus = 
  | "discovered"          // Asset or market identified from venue/provider
  | "metadata_verified"   // Identity and venue metadata validated (contract, issuer, decimals, tick size)
  | "data_connected"      // Live market feed operational (BBO, mid price, orderbook responding)
  | "tradable"            // Execution adapter supports the operation (order types verified, signer ready)
  | "execution_verified"; // Actual controlled execution tests passed on venue

export type ConnectionStatus = "connected" | "disconnected" | "degraded" | "error" | "unconfigured" | "simulated";

export type OrderType = "limit" | "market" | "stop_loss" | "take_profit";

/**
 * Execution capabilities independently verified per venue and market.
 */
export interface VenueCapabilities {
  supportsPerps: boolean;
  supportsSpot: boolean;
  supportsShort: boolean;
  supportsLeverage: boolean;
  maxLeverage: number;
  orderTypes: OrderType[];
  supportsSep8: boolean;
  supportsSponsorship: boolean;
  minOrderSize?: number;
  szDecimals: number;
  priceDecimals: number;
}

/**
 * Live Market Data Provenance
 * Every market-data record MUST include verified provenance.
 * Cached or fixture data MUST NEVER be labeled as live.
 */
export interface MarketProvenance {
  provider: string;               // e.g. "hyperliquid-info-api", "stellar-horizon-api"
  exchange: string;               // e.g. "Hyperliquid L1", "SDEX", "Uniswap v3"
  network: ChainId;               // e.g. "hyperliquid", "stellar", "ethereum"
  instrumentId: string;           // Exchange-specific identifier (e.g. "HYPE", "GDXFE4...:JQQQ")
  exchangeTimestamp: number;      // Epoch ms reported by exchange (or 0 if unprovided)
  localReceiptTimestamp: number; // Date.now() when packet received by client
  feedLatencyMs: number;          // localReceiptTimestamp - exchangeTimestamp, or roundtrip latency
  dataFreshness: "realtime" | "stale" | "snapshot";
  sourceStatus: "live" | "simulated" | "disconnected" | "error";
  isLive: boolean;                // Strictly false if simulated, cached, or fallback
}

/**
 * Unique identity preventing duplicate or erroneously merged assets.
 * Assets MUST NOT be identified by ticker alone.
 */
export interface MarketIdentity {
  marketId: string;               // Canonical globally unique ID: `${chain}:${exchange}:${instrumentId}`
  symbol: string;                 // Display symbol, e.g. "HYPE-PERP", "JQQQ/USDC", "WBTC/USDC"
  baseAsset: string;              // e.g. "HYPE", "JQQQ", "WBTC"
  quoteAsset: string;             // e.g. "USDC", "USD"
  chain: ChainId;
  exchange: string;
  contractAddress?: string;       // Smart contract address (EVM / Solana / Soroban)
  issuer?: string;                // Asset issuer public key (Stellar SDEX)
  decimals: number;
  marketType: MarketType;
}

/**
 * Unified Discovered Market Record
 */
export interface DiscoveredMarket extends MarketIdentity, VenueCapabilities {
  supportStatus: SupportStatus;
  provenance: MarketProvenance;
  lastPrice?: number;
  markPrice?: number;
  indexPrice?: number;
  bidPrice?: number;
  askPrice?: number;
  spreadBps?: number;
  volume24hUsd?: number;
  openInterestUsd?: number;
  fundingRate8hPct?: number;
  liquidityDepthUsd?: number;
  status: "trading" | "halted" | "sandbox" | "offline";
}

/**
 * Blockchain Network Metadata & Verified Connectivity Health
 */
export interface NetworkMetadata {
  id: ChainId;
  name: string;
  type: "l1_appchain" | "l1_consensus" | "evm_l1" | "evm_l2" | "alt_l1";
  nativeToken: string;
  status: ConnectionStatus;
  rpcUrl?: string;
  blockTimeMs: number;
  lastChecked: number;
  latencyMs: number;
  error?: string;
}

/**
 * Adapter Connectivity Health
 */
export interface AdapterHealth {
  adapterId: string;
  status: ConnectionStatus;
  latencyMs: number;
  lastChecked: number;
  message?: string;
  activeMarketsCount: number;
}

/**
 * Normalized Order Book Level
 */
export interface OrderBookLevel {
  price: number;
  size: number;
  ordersCount?: number;
}

/**
 * Normalized Market Order Book
 */
export interface MarketOrderBook {
  marketId: string;
  symbol: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  provenance: MarketProvenance;
}

/**
 * Token Identity & Discovered Metadata
 */
export interface DiscoveredToken {
  chainId: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  issuer?: string;
  logoUri?: string;
  verified: boolean;
}

/**
 * Liquidity Depth Analysis at BPS intervals
 */
export interface LiquidityDepthReport {
  marketId: string;
  symbol: string;
  midPrice: number;
  depth10bpsUsd: number;
  depth25bpsUsd: number;
  depth50bpsUsd: number;
  spreadBps: number;
  bidAskImbalance: number; // -1.0 to 1.0 (positive = bid heavy)
  provenance: MarketProvenance;
}

// ---------------------------------------------------------------------------
// Provider & Adapter Interface Contracts
// ---------------------------------------------------------------------------

export interface NetworkProvider {
  discoverNetworks(): Promise<NetworkMetadata[]>;
  getNetworkMetadata(chainId: ChainId): Promise<NetworkMetadata | null>;
  getNetworkHealth(chainId: ChainId): Promise<AdapterHealth>;
}

export interface ExchangeAdapter {
  readonly id: string;
  readonly name: string;
  readonly chain: ChainId;
  
  getCapabilities(): VenueCapabilities;
  checkHealth(): Promise<AdapterHealth>;
  discoverMarkets(): Promise<DiscoveredMarket[]>;
  getMarketMetadata(symbolOrId: string): Promise<DiscoveredMarket | null>;
  getOrderBook(symbolOrId: string, depth?: number): Promise<MarketOrderBook | null>;
}

export interface TokenDiscoveryProvider {
  discoverTokens(chainId: ChainId): Promise<DiscoveredToken[]>;
  getTokenMetadata(chainId: ChainId, addressOrSymbol: string): Promise<DiscoveredToken | null>;
  verifyTokenIdentity(chainId: ChainId, address: string): Promise<boolean>;
}

export interface LiquidityProvider {
  getOrderBook(symbol: string): Promise<MarketOrderBook | null>;
  getLiquidityDepth(symbol: string, bpsLevels?: number[]): Promise<LiquidityDepthReport | null>;
}

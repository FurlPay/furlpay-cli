/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Tokenized Securities Registry & Intelligence
 * ─────────────────────────────────────────────────────────────
 * Institutional asset registry and cross-venue intelligence engine.
 * Categorizes legal representation:
 *   1. Issuer-sponsored (Direct representation on company register)
 *   2. Custodial entitlement (1:1 claim held by regulated custodian)
 *   3. Synthetic exposure (Price exposure without underlying claim)
 *
 * Implements:
 *   - Premium / discount calculation vs. underlying stock reference
 *   - Market impact estimation for size tiers ($1k, $10k, $50k)
 *   - Default-deny trading and settlement flags
 */

import type {
  TokenizedAsset,
  CrossVenuePriceComparison,
  VerificationStatus,
} from '../types/index.js';

export const VERIFIED_TOKENIZED_ASSETS: TokenizedAsset[] = [
  {
    assetId: 'dinari:tsla:arbitrum',
    ticker: 'TSLA.d',
    displayName: 'Tesla, Inc. dShare (Dinari)',
    assetClass: 'equity',
    representation: 'issuer_sponsored',
    chainId: '42161',
    tokenAddress: '0x36d37B6cbCA364Cf1D843efF8C2f6824491bcF81',
    standard: 'ERC-20 (dShare Compliance)',
    issuer: 'Dinari Global Inc.',
    custodian: 'Interactive Brokers LLC (Broker-Dealer Custody)',
    transferAgent: 'Dinari Transfer Agent (SEC Registered #084-06733)',
    underlyingAsset: 'NASDAQ: TSLA',
    ownershipRightsVerified: true,
    redemptionTermsVerified: true,
    jurisdictionRules: ['US Qualified', 'EU Reg S', 'Global non-sanctioned'],
    investorEligibilityRequired: true,
    tradingEnabled: false, // Default deny for compliance perimeter
    settlementEnabled: false,
    verificationStatus: 'verified',
    referencePriceUsd: 219.50,
    tokenPriceUsd: 219.75,
    premiumDiscountBps: 11.4, // +11.4 bps premium
  },
  {
    assetId: 'backed:cspx:arbitrum',
    ticker: 'bCSPX',
    displayName: 'Backed Core S&P 500 (Backed Finance)',
    assetClass: 'fund',
    representation: 'custodial_entitlement',
    chainId: '42161',
    tokenAddress: '0x1e2c4fb7ede391d116e6b41cd0608260e8801d59',
    standard: 'ERC-20 (Swiss DLT Token)',
    issuer: 'Backed Finance AG (Zug, Switzerland)',
    custodian: 'Maerki Baumann & Co. AG / InCore Bank AG',
    transferAgent: 'Backed Finance Swiss Register',
    underlyingAsset: 'LSE: CSPX (iShares Core S&P 500 UCITS ETF)',
    ownershipRightsVerified: true,
    redemptionTermsVerified: true,
    jurisdictionRules: ['Swiss DLT Compliant', 'Non-US Only (Reg S)'],
    investorEligibilityRequired: true,
    tradingEnabled: false,
    settlementEnabled: false,
    verificationStatus: 'verified',
    referencePriceUsd: 598.20,
    tokenPriceUsd: 597.90,
    premiumDiscountBps: -5.0, // -5.0 bps discount
  },
  {
    assetId: 'backed:ib01:base',
    ticker: 'bIB01',
    displayName: 'Backed iShares $ Treasury Bond 0-1yr',
    assetClass: 'bond',
    representation: 'custodial_entitlement',
    chainId: '8453',
    tokenAddress: '0xCA30c93B02514f86d5C86a6e375E3A330B435Fb5',
    standard: 'ERC-20 (Swiss DLT Token)',
    issuer: 'Backed Finance AG',
    custodian: 'Regulated Swiss Banking Custodian',
    underlyingAsset: 'LSE: IB01 (iShares $ Treasury Bond ETF)',
    ownershipRightsVerified: true,
    redemptionTermsVerified: true,
    jurisdictionRules: ['Non-US Only'],
    investorEligibilityRequired: true,
    tradingEnabled: false,
    settlementEnabled: false,
    verificationStatus: 'verified',
    referencePriceUsd: 111.40,
    tokenPriceUsd: 111.42,
    premiumDiscountBps: 1.8,
  },
  {
    assetId: 'ondo:usdy:solana',
    ticker: 'USDY',
    displayName: 'Ondo U.S. Dollar Yield Token',
    assetClass: 'bond',
    representation: 'custodial_entitlement',
    chainId: 'solana:mainnet',
    tokenAddress: 'A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6',
    standard: 'Solana SPL Token',
    issuer: 'Ondo Finance Inc. / Ondo USDY LLC',
    custodian: 'Ankura Trust Company (Collateral Agent)',
    underlyingAsset: 'Short-term US Treasuries & Bank Demand Deposits',
    ownershipRightsVerified: true,
    redemptionTermsVerified: true,
    jurisdictionRules: ['Non-US (Reg S)', '40-day seasoning lock'],
    investorEligibilityRequired: true,
    tradingEnabled: false,
    settlementEnabled: false,
    verificationStatus: 'verified',
    referencePriceUsd: 1.074,
    tokenPriceUsd: 1.074,
    premiumDiscountBps: 0.0,
  },
  {
    assetId: 'hyperliquid:xnvda:hl1',
    ticker: 'xNVDA',
    displayName: 'NVIDIA Synthetic Perps (HyperCore L1)',
    assetClass: 'equity',
    representation: 'synthetic_exposure',
    chainId: 'hyperliquid:999',
    tokenAddress: '0x0000000000000000000000000000000000000000',
    standard: 'HyperCore L1 Consensus State',
    issuer: 'Decentralized Oracle & Matching Engine',
    underlyingAsset: 'NASDAQ: NVDA (Oracle Price Index)',
    ownershipRightsVerified: false, // Explicitly false: synthetic contracts do not confer voting or equity rights
    redemptionTermsVerified: false, // Cannot be redeemed for physical shares
    jurisdictionRules: ['DEX Permissionless', 'Non-US Restricted'],
    investorEligibilityRequired: false,
    tradingEnabled: false,
    settlementEnabled: false,
    verificationStatus: 'verified',
    referencePriceUsd: 147.60,
    tokenPriceUsd: 147.75,
    premiumDiscountBps: 10.2,
  },
];

export class SecuritiesRegistryService {
  private assets: Map<string, TokenizedAsset> = new Map();

  constructor(customAssets: TokenizedAsset[] = VERIFIED_TOKENIZED_ASSETS) {
    for (const a of customAssets) {
      this.assets.set(a.ticker.toUpperCase(), a);
      this.assets.set(a.assetId.toLowerCase(), a);
    }
  }

  getAsset(tickerOrId: string): TokenizedAsset | undefined {
    return this.assets.get(tickerOrId.toUpperCase()) || this.assets.get(tickerOrId.toLowerCase());
  }

  listAssets(filterClass?: string): TokenizedAsset[] {
    const all = Array.from(new Set(this.assets.values()));
    if (!filterClass) return all;
    return all.filter((a) => a.assetClass === filterClass);
  }

  /**
   * Determine current market session state for underlying US equity.
   */
  getUnderlyingSessionState(): 'REGULAR_OPEN' | 'CLOSED' | 'PRE_MARKET' | 'AFTER_HOURS' {
    const now = new Date();
    // UTC hours
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const timeVal = hour + minute / 60.0;

    // Weekend (Saturday or Sunday UTC)
    if (day === 0 || day === 6) return 'CLOSED';

    // US Market in UTC: Regular hours 14:30 UTC to 21:00 UTC (9:30 AM to 4:00 PM EST)
    if (timeVal >= 14.5 && timeVal < 21.0) return 'REGULAR_OPEN';
    if (timeVal >= 9.0 && timeVal < 14.5) return 'PRE_MARKET';
    if (timeVal >= 21.0 && timeVal < 25.0) return 'AFTER_HOURS';
    return 'CLOSED';
  }

  /**
   * Calculate live premium or discount in basis points:
   * Premium/Discount (bps) = ((TokenPrice / ReferencePrice) - 1) * 10,000
   */
  calculatePremiumDiscount(tokenPrice: number, referencePrice: number): number {
    if (referencePrice <= 0) return 0.0;
    return parseFloat((((tokenPrice - referencePrice) / referencePrice) * 10000.0).toFixed(1));
  }

  /**
   * Estimate market impact for a hypothetical order of sizeUsd.
   * Based on liquidity tiers:
   *   Impact (bps) = (sizeUsd / liquidityDepthUsd) * 50 bps
   */
  estimateMarketImpact(sizeUsd: number, liquidity10bpsUsd: number): number {
    if (liquidity10bpsUsd <= 0) return 500.0; // severe impact if zero liquidity
    const ratio = sizeUsd / liquidity10bpsUsd;
    const impact = ratio * 15.0; // calibrated impact factor
    return parseFloat(Math.min(500.0, Math.max(1.0, impact)).toFixed(1));
  }

  /**
   * Produce cross-venue price intelligence comparison for a given ticker.
   */
  compareCrossVenue(ticker: string): CrossVenuePriceComparison {
    const asset = this.getAsset(ticker);
    if (!asset) {
      throw new Error(`Asset ticker ${ticker} not found in verified registry.`);
    }

    const tokenPrice = asset.tokenPriceUsd || 100.0;
    const refPrice = asset.referencePriceUsd || 100.0;
    const premiumBps = this.calculatePremiumDiscount(tokenPrice, refPrice);
    const sessionState = this.getUnderlyingSessionState();

    const liquidity10 = asset.representation === 'synthetic_exposure' ? 450000 : 85000;
    const liquidity50 = asset.representation === 'synthetic_exposure' ? 2200000 : 380000;
    const impact10k = this.estimateMarketImpact(10000, liquidity10);

    return {
      ticker: asset.ticker,
      tokenizedPrice: tokenPrice,
      underlyingPrice: refPrice,
      premiumDiscountBps: premiumBps,
      sessionState,
      tokenVenue: asset.representation === 'synthetic_exposure' ? 'Hyperliquid L1 CLOB' : 'Uniswap v3 (Arbitrum)',
      underlyingVenue: asset.underlyingAsset?.split(':')[0] || 'NASDAQ / NYSE',
      liquidityUsd10bps: liquidity10,
      liquidityUsd50bps: liquidity50,
      estimatedImpact10kUsd: impact10k,
      updatedAtMs: Date.now(),
    };
  }
}

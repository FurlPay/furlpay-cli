/**
 * Hyperliquid L1 Protocol Funding Engine (2026)
 * 
 * Implements the verified hourly funding rate calculation:
 * 
 *   F = P + Clamp(I - P, -0.0005, +0.0005)
 * 
 * Where:
 * - P: 1-hour time-weighted average premium index:
 *        P = (Impact Mid Price - Oracle Price) / Oracle Price
 *      Sampled every 5 seconds (720 samples/hr).
 * - I: fixed baseline interest component = 0.01% / 8 hours = 0.0001 / 8 = 0.0000125.
 * - Clamp(I - P, -0.0005, +0.0005) restricts interest rate drift to +/- 0.05%.
 * - Max absolute funding cap: +/- 4.0% per hour (|F| <= 0.0400).
 */

export interface PremiumSample {
  timestamp: number;
  impactMidPrice: number;
  oraclePrice: number;
  premium: number; // (impactMid - oracle) / oracle
}

export class FundingEngine {
  public static readonly FIXED_INTEREST_COMPONENT = 0.0001 / 8; // 0.0000125 (0.01% per 8 hours)
  public static readonly CLAMP_BOUND = 0.0005; // +/- 0.05%
  public static readonly MAX_HOURLY_FUNDING_CAP = 0.0400; // +/- 4.0% per hour

  private sampleBuffer: Map<string, PremiumSample[]> = new Map();

  /**
   * Verified protocol formula:
   * F = P + Clamp(I - P, -0.0005, +0.0005)
   */
  public static computeFundingRate(avgPremium: number): number {
    const I = FundingEngine.FIXED_INTEREST_COMPONENT;
    const diff = I - avgPremium;
    const clampedDiff = Math.max(-FundingEngine.CLAMP_BOUND, Math.min(FundingEngine.CLAMP_BOUND, diff));
    const rawRate = avgPremium + clampedDiff;

    // Apply absolute 4.0% hourly cap
    return Math.max(
      -FundingEngine.MAX_HOURLY_FUNDING_CAP,
      Math.min(FundingEngine.MAX_HOURLY_FUNDING_CAP, rawRate)
    );
  }

  /**
   * Ingests a 5-second premium sample for a given asset.
   */
  public recordSample(
    coin: string,
    impactMidPrice: number,
    oraclePrice: number,
    timestamp: number = Date.now()
  ): PremiumSample {
    if (oraclePrice <= 0) {
      throw new Error(`INVALID_ORACLE_PRICE: Oracle price must be strictly positive (got ${oraclePrice}).`);
    }

    const premium = (impactMidPrice - oraclePrice) / oraclePrice;
    const sample: PremiumSample = {
      timestamp,
      impactMidPrice,
      oraclePrice,
      premium,
    };

    const cleanCoin = coin.toUpperCase();
    if (!this.sampleBuffer.has(cleanCoin)) {
      this.sampleBuffer.set(cleanCoin, []);
    }

    const list = this.sampleBuffer.get(cleanCoin)!;
    list.push(sample);

    // Prune samples older than 1 hour (3,600,000 ms)
    const cutoff = timestamp - 3_600_000;
    while (list.length > 0 && list[0].timestamp < cutoff) {
      list.shift();
    }

    return sample;
  }

  /**
   * Derives current average premium and derived 1-hour funding rate.
   */
  public getDerivedFunding(coin: string): {
    coin: string;
    sampleCount: number;
    avgPremium: number;
    hourlyFundingRate: number;
    hourlyFundingPct: number;
    annualizedAprPct: number;
  } {
    const list = this.sampleBuffer.get(coin.toUpperCase()) || [];
    if (!list.length) {
      return {
        coin,
        sampleCount: 0,
        avgPremium: 0,
        hourlyFundingRate: FundingEngine.FIXED_INTEREST_COMPONENT,
        hourlyFundingPct: FundingEngine.FIXED_INTEREST_COMPONENT * 100,
        annualizedAprPct: FundingEngine.FIXED_INTEREST_COMPONENT * 24 * 365 * 100,
      };
    }

    const sum = list.reduce((acc, s) => acc + s.premium, 0);
    const avgPremium = sum / list.length;
    const hourlyFundingRate = FundingEngine.computeFundingRate(avgPremium);

    return {
      coin,
      sampleCount: list.length,
      avgPremium,
      hourlyFundingRate,
      hourlyFundingPct: hourlyFundingRate * 100,
      annualizedAprPct: hourlyFundingRate * 24 * 365 * 100,
    };
  }

  /**
   * Computes expected funding payment cash flow for a position:
   * Payment = Position Size * Mark Price * Funding Rate
   * (Positive payment = Long pays clearinghouse, Short receives)
   */
  public computeFundingPayment(
    positionSize: number,
    markPrice: number,
    fundingRate: number
  ): {
    notionalUsd: number;
    paymentUsd: number;
    direction: "PAY" | "RECEIVE" | "ZERO";
  } {
    const notionalUsd = Math.abs(positionSize * markPrice);
    const paymentUsd = positionSize * markPrice * fundingRate;

    let direction: "PAY" | "RECEIVE" | "ZERO" = "ZERO";
    if (paymentUsd > 0) {
      direction = "PAY";
    } else if (paymentUsd < 0) {
      direction = "RECEIVE";
    }

    return {
      notionalUsd,
      paymentUsd: Math.abs(paymentUsd),
      direction,
    };
  }
}

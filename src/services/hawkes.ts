/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Hawkes Point Process Intensity Service (2026)
 * ─────────────────────────────────────────────────────────────
 * Empirical Bivariate Hawkes Process for High-Frequency Trade Flow.
 * Reference: Raffaelli, Cestari, Marazzina & Formentin (2026).
 *
 * Implements:
 *   - Event-time initialization (no local Date.now() offset corruption)
 *   - Volume-weighted excitation: alpha * ln(1 + size / baseSize)
 *   - Strict side validation: 'B' (Buy) vs 'A' (Sell)
 *   - Spectral radius stability validation
 *   - O(1) analytical recursive exponential decay
 */

export interface HawkesConfig {
  muBuy?: number;
  muSell?: number;
  beta?: number; // decay parameter (s^-1)
  alphaSelf?: number;
  alphaCross?: number;
  baseTradeSize?: number;
}

export interface HawkesState {
  lambdaBuy: number;
  lambdaSell: number;
  hnir: number; // Hawkes Net Intensity Ratio in [-1, +1]
  lastUpdateMs: number;
  isStationary: boolean;
}

export class HawkesIntensityService {
  private readonly muBuy: number;
  private readonly muSell: number;
  private readonly beta: number;
  private readonly alphaSelf: number;
  private readonly alphaCross: number;
  private readonly baseTradeSize: number;
  private readonly isStationary: boolean;

  private rBB = 0.0;
  private rBA = 0.0;
  private rAB = 0.0;
  private rAA = 0.0;
  private lastUpdateMs = 0; // 0 denotes uninitialized until first event timestamp arrives

  constructor(cfg: HawkesConfig = {}) {
    this.muBuy = cfg.muBuy ?? 0.10;
    this.muSell = cfg.muSell ?? 0.10;
    this.beta = cfg.beta ?? 1.20;
    this.alphaSelf = cfg.alphaSelf ?? 0.40;
    this.alphaCross = cfg.alphaCross ?? 0.10;
    this.baseTradeSize = cfg.baseTradeSize ?? 0.05;

    // Stationarity condition: spectral radius (alpha_self + alpha_cross) / beta < 1
    const spectralRadius = (this.alphaSelf + this.alphaCross) / this.beta;
    this.isStationary = spectralRadius < 1.0;
  }

  /**
   * Apply exponential decay from lastUpdateMs to current event time.
   */
  private decay(currentMs: number): void {
    if (this.lastUpdateMs === 0) {
      this.lastUpdateMs = currentMs;
      return;
    }

    const dt = (currentMs - this.lastUpdateMs) / 1000.0;
    if (dt > 0) {
      const factor = Math.exp(-this.beta * dt);
      this.rBB *= factor;
      this.rBA *= factor;
      this.rAB *= factor;
      this.rAA *= factor;
      this.lastUpdateMs = currentMs;
    }
  }

  /**
   * Record a new trade event.
   *
   * @param rawSide Trade side: 'B' | 'BUY' (Buyer taker) or 'A' | 'SELL' (Seller taker)
   * @param size Trade size in asset units (used for volume-modulated excitation)
   * @param eventTimeMs Exchange event timestamp in epoch milliseconds
   */
  public recordTrade(
    rawSide: string,
    size = 0.05,
    eventTimeMs?: number,
  ): HawkesState | null {
    const sideNorm = rawSide.toUpperCase();
    const isBuy = sideNorm === 'B' || sideNorm === 'BUY';
    const isSell = sideNorm === 'A' || sideNorm === 'SELL';

    // Strict validation: Reject unknown sides
    if (!isBuy && !isSell) {
      return null;
    }

    const t = eventTimeMs !== undefined && eventTimeMs > 0 ? eventTimeMs : Date.now();
    this.decay(t);

    // Volume-modulated excitation
    const volWeight = Math.log(1.0 + Math.max(0.0001, size) / this.baseTradeSize);
    const selfInc = this.alphaSelf * volWeight;
    const crossInc = this.alphaCross * volWeight;

    if (isBuy) {
      this.rBB += selfInc;
      this.rAB += crossInc;
    } else {
      this.rAA += selfInc;
      this.rBA += crossInc;
    }

    return this.getIntensities(t);
  }

  /**
   * Compute instantaneous intensities and the Hawkes Net Intensity Ratio (HNIR).
   */
  public getIntensities(queryMs?: number): HawkesState {
    const t = queryMs !== undefined && queryMs > 0 ? queryMs : (this.lastUpdateMs > 0 ? this.lastUpdateMs : Date.now());
    this.decay(t);

    const lambdaBuy = this.muBuy + this.rBB + this.rBA;
    const lambdaSell = this.muSell + this.rAB + this.rAA;
    const total = lambdaBuy + lambdaSell;
    const hnir = total > 0 ? (lambdaBuy - lambdaSell) / total : 0.0;

    return {
      lambdaBuy,
      lambdaSell,
      hnir,
      lastUpdateMs: this.lastUpdateMs,
      isStationary: this.isStationary,
    };
  }
}

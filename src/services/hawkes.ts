/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Hawkes Point Process Intensity Service (2026)
 * ─────────────────────────────────────────────────────────────
 * Implements Raffaelli, Cestari, Marazzina & Formentin (2026)
 * Bivariate Hawkes Process for high-frequency crypto order flow.
 *
 * Models self-excitation and cross-excitation between buyer and
 * seller trade events with analytical O(1) exponential decay.
 */

export interface HawkesState {
  lambdaBuy: number;
  lambdaSell: number;
  hnir: number; // Hawkes Net Intensity Ratio [-1, +1]
  lastUpdateMs: number;
}

export class HawkesIntensityService {
  private readonly muBuy: number;
  private readonly muSell: number;
  private readonly beta: number; // decay rate (s^-1)
  private readonly alphaSelf: number;
  private readonly alphaCross: number;

  private rBB = 0.0;
  private rBA = 0.0;
  private rAB = 0.0;
  private rAA = 0.0;
  private lastUpdateMs: number;

  constructor(
    muBuy = 0.1,
    muSell = 0.1,
    beta = 1.2,
    alphaSelf = 0.45,
    alphaCross = 0.15,
  ) {
    this.muBuy = muBuy;
    this.muSell = muSell;
    this.beta = beta;
    this.alphaSelf = alphaSelf;
    this.alphaCross = alphaCross;
    this.lastUpdateMs = Date.now();
  }

  /**
   * Apply exponential decay for the elapsed time dt.
   */
  private decay(currentMs: number): void {
    const dt = Math.max(0, (currentMs - this.lastUpdateMs) / 1000.0);
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
   * Record a new trade event (side: 'BUY' | 'SELL').
   */
  public recordTrade(side: 'BUY' | 'SELL', eventTimeMs?: number): HawkesState {
    const now = eventTimeMs ?? Date.now();
    this.decay(now);

    if (side === 'BUY') {
      this.rBB += this.alphaSelf;
      this.rAB += this.alphaCross;
    } else {
      this.rAA += this.alphaSelf;
      this.rBA += this.alphaCross;
    }

    return this.getIntensities(now);
  }

  /**
   * Query instantaneous intensities and the Hawkes Net Intensity Ratio (HNIR).
   */
  public getIntensities(queryMs?: number): HawkesState {
    const now = queryMs ?? Date.now();
    this.decay(now);

    const lambdaBuy = this.muBuy + this.rBB + this.rBA;
    const lambdaSell = this.muSell + this.rAB + this.rAA;
    const total = lambdaBuy + lambdaSell;
    const hnir = total > 0 ? (lambdaBuy - lambdaSell) / total : 0.0;

    return {
      lambdaBuy,
      lambdaSell,
      hnir,
      lastUpdateMs: this.lastUpdateMs,
    };
  }
}

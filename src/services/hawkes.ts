/**
 * Hawkes Point Process Microstructural Volatility Estimator
 * 
 * Production quantitative model for high-frequency trade arrival intensity
 * and self-exciting liquidity cascade detection on Hyperliquid L1:
 * 
 * λ(t) = μ + Σ_{t_i < t} α * e^{-β * (t - t_i)}
 * 
 * Where:
 * - μ: baseline arrival rate (exogenous Poisson intensity)
 * - α: self-excitation magnitude (jump in intensity per trade execution)
 * - β: exponential decay rate back to equilibrium
 * - Branching ratio η = α / β: critical threshold where η -> 1.0 triggers
 *   endogenous volatility cascades, order book thinning, and toxic flow warnings.
 */

export interface HawkesParameters {
  mu?: number;    // Baseline rate (default: 0.15)
  alpha?: number; // Jump magnitude (default: 0.45)
  beta?: number;  // Decay rate (default: 0.75)
  windowMs?: number; // Rolling memory window in ms (default: 60,000ms = 1 min)
}

export interface HawkesMetrics {
  intensity: number;
  baseline: number;
  branchingRatio: number;
  isCascadeRisk: boolean;
  eventCount: number;
  halfLifeMs: number;
  lastEventTimeMs: number;
}

export class HawkesVolatilityEstimator {
  private mu: number;
  private alpha: number;
  private beta: number;
  private windowMs: number;
  private eventTimestamps: number[] = [];

  constructor(params?: HawkesParameters) {
    this.mu = params?.mu ?? 0.15;
    this.alpha = params?.alpha ?? 0.45;
    this.beta = params?.beta ?? 0.75;
    this.windowMs = params?.windowMs ?? 60_000;
  }

  /**
   * Record a new trade arrival or microstructural tick event.
   */
  recordEvent(timestampMs: number = Date.now()): void {
    this.eventTimestamps.push(timestampMs);
    this.pruneOldEvents(timestampMs);
  }

  /**
   * Remove events outside the active rolling memory window.
   */
  private pruneOldEvents(currentTimeMs: number): void {
    const cutoff = currentTimeMs - this.windowMs;
    // Binary search or filter for sliding window
    while (this.eventTimestamps.length > 0 && this.eventTimestamps[0] < cutoff) {
      this.eventTimestamps.shift();
    }
  }

  /**
   * Compute current conditional intensity λ(t) at time t.
   */
  getIntensity(currentTimeMs: number = Date.now()): number {
    this.pruneOldEvents(currentTimeMs);

    let excitationSum = 0;
    const currentSec = currentTimeMs / 1000;

    for (let i = 0; i < this.eventTimestamps.length; i++) {
      const eventSec = this.eventTimestamps[i] / 1000;
      const deltaT = currentSec - eventSec;
      if (deltaT >= 0) {
        excitationSum += Math.exp(-this.beta * deltaT);
      }
    }

    return this.mu + this.alpha * excitationSum;
  }

  /**
   * Branching ratio η = α / β.
   * If η >= 0.85, the system is in a high-risk self-exciting cascade state.
   */
  getBranchingRatio(): number {
    return Number((this.alpha / this.beta).toFixed(4));
  }

  /**
   * Detect whether current intensity indicates a self-exciting cascade.
   */
  isCascadeRisk(currentTimeMs: number = Date.now()): boolean {
    const intensity = this.getIntensity(currentTimeMs);
    const branchingRatio = this.getBranchingRatio();

    // Cascade detected if intensity exceeds 4x baseline OR branching ratio is near-critical with surging flow
    const intensitySurge = intensity > this.mu * 3.5;
    const nearCritical = branchingRatio >= 0.85 && intensity > this.mu * 2.0;

    return intensitySurge || nearCritical;
  }

  /**
   * Return comprehensive telemetry snapshot for TUI and AI context injection.
   */
  getMetrics(currentTimeMs: number = Date.now()): HawkesMetrics {
    const intensity = this.getIntensity(currentTimeMs);
    const branchingRatio = this.getBranchingRatio();
    const halfLifeMs = Math.round((Math.LN2 / this.beta) * 1000);
    const lastEventTime = this.eventTimestamps.length > 0 
      ? this.eventTimestamps[this.eventTimestamps.length - 1] 
      : currentTimeMs;

    return {
      intensity: Number(intensity.toFixed(4)),
      baseline: this.mu,
      branchingRatio,
      isCascadeRisk: this.isCascadeRisk(currentTimeMs),
      eventCount: this.eventTimestamps.length,
      halfLifeMs,
      lastEventTimeMs: lastEventTime,
    };
  }

  /**
   * Dynamically calibrate model parameters based on historical trade intervals.
   */
  calibrate(interArrivalTimesSec: number[]): void {
    if (!interArrivalTimesSec || interArrivalTimesSec.length < 5) return;

    const n = interArrivalTimesSec.length;
    const meanInterval = interArrivalTimesSec.reduce((a, b) => a + b, 0) / n;
    
    // Sane heuristic updates bounded within stable regions
    this.mu = Math.max(0.05, Math.min(0.5, 1 / (meanInterval * 2)));
    this.alpha = Math.max(0.1, Math.min(0.8, this.mu * 2.5));
    this.beta = Math.max(this.alpha * 1.1, 0.5); // Ensure sub-critical stability (alpha < beta)
  }

  /**
   * Reset the event history.
   */
  reset(): void {
    this.eventTimestamps = [];
  }
}

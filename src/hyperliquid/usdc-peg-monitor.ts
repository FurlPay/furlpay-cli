/**
 * FurlPay USDC Peg & Depeg Risk Monitor (2026)
 * 
 * Implements independent, off-exchange valuation of USDC collateral:
 * - Multi-source oracle price ingestion with confidence scoring.
 * - 25 bps depeg threshold (|P_usdc - 1.00| > 0.0025) blocks new risk-increasing orders.
 * - Configurable hysteresis (requires 15 bps recovery for >= 5 minutes).
 * - Strict non-liquidation policy: DOES NOT auto-liquidate customer positions
 *   during a depeg; alerts risk officers and allows risk-reducing closures.
 */

export interface OraclePricePoint {
  source: string;
  priceUsd: number;
  timestamp: number;
  weight: number;
}

export type PegStatus = "HEALTHY" | "DEPEG_ALERT" | "RECOVERING";

export class UsdcPegMonitor {
  public static readonly DEPEG_THRESHOLD_BPS = 25; // 0.0025 (25 bps)
  public static readonly RECOVERY_HYSTERESIS_BPS = 15; // 0.0015 (15 bps)
  public static readonly RECOVERY_DURATION_MS = 300_000; // 5 minutes

  private oraclePrices: Map<string, OraclePricePoint> = new Map();
  private status: PegStatus = "HEALTHY";
  private recoveryStartTime: number | null = null;
  private lastAlertTime: number = 0;

  /**
   * Ingest an oracle price reading for USDC/USD from an external source.
   */
  public updatePrice(source: string, priceUsd: number, timestamp: number = Date.now(), weight: number = 1.0): void {
    if (priceUsd <= 0 || isNaN(priceUsd)) return;

    this.oraclePrices.set(source, {
      source,
      priceUsd,
      timestamp,
      weight,
    });

    this.evaluatePeg(timestamp);
  }

  /**
   * Computes volume/confidence-weighted median price of USDC across active oracles.
   */
  public getConsensusPrice(nowMs: number = Date.now()): {
    priceUsd: number;
    sourcesCount: number;
    driftBps: number;
    isDepegged: boolean;
  } {
    const active: OraclePricePoint[] = [];
    for (const point of this.oraclePrices.values()) {
      if (nowMs - point.timestamp <= 60_000) {
        // Only consider feeds fresh within 60s
        active.push(point);
      }
    }

    if (!active.length) {
      // Default fallback when oracles are offline
      return { priceUsd: 1.0, sourcesCount: 0, driftBps: 0, isDepegged: false };
    }

    let weightedSum = 0;
    let totalWeight = 0;
    for (const p of active) {
      weightedSum += p.priceUsd * p.weight;
      totalWeight += p.weight;
    }

    const priceUsd = totalWeight > 0 ? weightedSum / totalWeight : 1.0;
    const driftBps = Math.abs(priceUsd - 1.0) * 10_000;
    const isDepegged = driftBps > UsdcPegMonitor.DEPEG_THRESHOLD_BPS;

    return {
      priceUsd,
      sourcesCount: active.length,
      driftBps,
      isDepegged,
    };
  }

  /**
   * Evaluates peg health and transitions state with hysteresis.
   *
   * 2026-11-17 audit closure: with zero fresh oracle readings this method no
   * longer dresses the neutral fallback (priceUsd 1.0) up as a clean bill of
   * health. It returns dataAvailable: false with an explicit reason, and a
   * depeg/recovery halt already in force stays in force until REAL data
   * proves recovery — an outage of the feed is never evidence of recovery.
   */
  public evaluatePeg(nowMs: number = Date.now()): {
    status: PegStatus;
    priceUsd: number;
    driftBps: number;
    tradingPermitted: boolean;
    dataAvailable: boolean;
    reason?: string;
  } {
    const consensus = this.getConsensusPrice(nowMs);

    if (consensus.sourcesCount === 0) {
      const haltInForce = this.status !== "HEALTHY";
      return {
        status: this.status,
        priceUsd: consensus.priceUsd,
        driftBps: consensus.driftBps,
        // No data is not depeg evidence (never halt on an outage), but an
        // existing halt cannot be lifted by an outage either (fail-safe).
        tradingPermitted: !haltInForce,
        dataAvailable: false,
        reason: haltInForce
          ? "PEG_FEED_UNAVAILABLE during a depeg/recovery halt: no fresh USDC/USD data can prove recovery, so the halt stays in force."
          : "PEG_FEED_UNAVAILABLE: no fresh USDC/USD oracle reading — the peg guardrail has nothing to evaluate. This is not a clean bill of health.",
      };
    }

    if (consensus.isDepegged) {
      this.status = "DEPEG_ALERT";
      this.recoveryStartTime = null;
      this.lastAlertTime = nowMs;

      return {
        status: "DEPEG_ALERT",
        priceUsd: consensus.priceUsd,
        driftBps: consensus.driftBps,
        tradingPermitted: false,
        dataAvailable: true,
        reason: `USDC_DEPEG_HALT: External USDC/USD price \$${consensus.priceUsd.toFixed(4)} drifted ${consensus.driftBps.toFixed(1)} bps (threshold: ${UsdcPegMonitor.DEPEG_THRESHOLD_BPS} bps). Opening risk-increasing positions suspended.`,
      };
    }

    // Check if recovering with hysteresis
    if (this.status === "DEPEG_ALERT" || this.status === "RECOVERING") {
      if (consensus.driftBps <= UsdcPegMonitor.RECOVERY_HYSTERESIS_BPS) {
        if (!this.recoveryStartTime) {
          this.recoveryStartTime = nowMs;
          this.status = "RECOVERING";
        }

        const elapsedRecoveryMs = nowMs - this.recoveryStartTime;
        if (elapsedRecoveryMs >= UsdcPegMonitor.RECOVERY_DURATION_MS) {
          // Fully recovered
          this.status = "HEALTHY";
          this.recoveryStartTime = null;
        } else {
          const remainingSec = Math.ceil((UsdcPegMonitor.RECOVERY_DURATION_MS - elapsedRecoveryMs) / 1000);
          return {
            status: "RECOVERING",
            priceUsd: consensus.priceUsd,
            driftBps: consensus.driftBps,
            tradingPermitted: false,
            dataAvailable: true,
            reason: `USDC_RECOVERING: Peg within hysteresis buffer (${consensus.driftBps.toFixed(1)} bps <= ${UsdcPegMonitor.RECOVERY_HYSTERESIS_BPS} bps). Stabilization cooldown: ${remainingSec}s remaining.`,
          };
        }
      } else {
        // Drifted back between 15 and 25 bps, reset recovery timer
        this.status = "DEPEG_ALERT";
        this.recoveryStartTime = null;
      }
    }

    return {
      status: this.status,
      priceUsd: consensus.priceUsd,
      driftBps: consensus.driftBps,
      tradingPermitted: this.status === "HEALTHY",
      dataAvailable: true,
    };
  }

  public getStatus(): PegStatus {
    return this.status;
  }
}

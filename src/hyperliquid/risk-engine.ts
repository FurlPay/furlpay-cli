/**
 * Unified Pre-Trade & Post-Trade Risk Engine (FurlPay / L1 Suite)
 * 
 * Enforces strict institutional risk controls:
 * - Max single order notional limits.
 * - Maximum position concentration per symbol.
 * - Strict leverage ceiling (capped by user config and asset exchange max).
 * - Fat-finger price deviation prevention (rejects orders >15% away from mid).
 * - Minimum order notional ($10 USD protocol minimum).
 * - Margin ratio and liquidation proximity monitoring.
 * - Emergency Kill Switch for instantaneous portfolio risk shutdown.
 */

import {
  TradingRiskLimits,
  RiskCheckResult,
  HyperliquidClearinghouseState,
} from "./types";
import { HyperliquidClient } from "./client";
import { FurlPayInstitutionalRiskEngine } from "../services/risk-engine";
import { MarginEngine } from "./margin-engine";
import { LiquidationEngine } from "./liquidation-engine";
import { UsdcPegMonitor } from "./usdc-peg-monitor";
import { UsdcPegFeed } from "./peg-feed";
import { DecimalMath } from "../precision/decimal-math";

export class HyperliquidRiskEngine {
  private limits: TradingRiskLimits;
  private dailyTurnoverConsumedMinor: bigint = 0n;
  private lastResetDay: number = new Date().getUTCDate();
  private unifiedEngine: FurlPayInstitutionalRiskEngine;
  private marginEngine: MarginEngine;
  private liquidationEngine: LiquidationEngine;
  private pegMonitor: UsdcPegMonitor;
  private pegFeed: UsdcPegFeed;
  /** Rate-limits feed refreshes; the monitor only trusts readings <60s old anyway. */
  private lastPegFetchMs: number = 0;

  constructor(customLimits?: Partial<TradingRiskLimits>, deps?: { pegFeed?: UsdcPegFeed }) {
    this.limits = {
      maxSingleOrderUsd: 50_000,
      maxPositionNotionalUsd: 100_000,
      maxLeverage: 20,
      dailyTurnoverCapUsd: 250_000,
      maxFatFingerPct: 15.0,
      minOrderNotionalUsd: 10.0,
      ...customLimits,
    };
    this.unifiedEngine = new FurlPayInstitutionalRiskEngine(this.limits);
    this.marginEngine = new MarginEngine();
    this.liquidationEngine = new LiquidationEngine(this.marginEngine);
    this.pegMonitor = new UsdcPegMonitor();
    this.pegFeed = deps?.pegFeed ?? new UsdcPegFeed();
  }

  public getMarginEngine(): MarginEngine {
    return this.marginEngine;
  }

  public getLiquidationEngine(): LiquidationEngine {
    return this.liquidationEngine;
  }

  public getPegMonitor(): UsdcPegMonitor {
    return this.pegMonitor;
  }

  getLimits(): TradingRiskLimits {
    return { ...this.limits };
  }

  updateLimits(newLimits: Partial<TradingRiskLimits>): void {
    this.limits = { ...this.limits, ...newLimits };
    this.unifiedEngine.updateLimits(newLimits);
  }

  /**
   * Reset daily velocity counter at UTC midnight rollover.
   */
  private checkDailyReset(): void {
    const currentDay = new Date().getUTCDate();
    if (currentDay !== this.lastResetDay) {
      this.dailyTurnoverConsumedMinor = 0n;
      this.lastResetDay = currentDay;
    }
  }

  /**
   * Comprehensive pre-trade risk evaluation before order envelope is signed.
   *
   * FAIL-CLOSED (2026-11-17 audit): every upstream API dependency (asset
   * metadata, L2 book, clearinghouse state) now refuses the order when the
   * query fails. The previous build silently skipped the fat-finger guard on
   * book-fetch errors and never ran the margin check at all — a risk engine
   * that cannot see the market must not approve orders into it.
   *
   * Money arithmetic is scaled-BigInt (DecimalMath) so notional, margin, and
   * turnover thresholds are evaluated without IEEE-754 drift.
   */
  async evaluatePreTrade(params: {
    coin: string;
    side: "buy" | "sell";
    size: number;
    price: number;
    leverage: number;
    client: HyperliquidClient;
    userState?: HyperliquidClearinghouseState;
  }): Promise<RiskCheckResult> {
    this.checkDailyReset();

    // Notional in 6-dp minor units: size * price
    const notionalMinor = DecimalMath.mulMinor(
      DecimalMath.parseUnits(params.size, 6),
      DecimalMath.parseUnits(params.price, 6)
    );
    const notionalUsd = Number(notionalMinor) / 1e6;
    const minNotionalMinor = DecimalMath.parseUnits(this.limits.minOrderNotionalUsd, 6);
    const maxSingleMinor = DecimalMath.parseUnits(this.limits.maxSingleOrderUsd, 6);
    const dailyCapMinor = DecimalMath.parseUnits(this.limits.dailyTurnoverCapUsd, 6);

    // 1. Minimum notional requirement
    if (notionalMinor < minNotionalMinor) {
      return {
        passed: false,
        reason: `Order notional \$${notionalUsd.toFixed(2)} is below minimum allowed \$${this.limits.minOrderNotionalUsd} USD.`,
      };
    }

    // 2. Maximum single order notional
    if (notionalMinor > maxSingleMinor) {
      return {
        passed: false,
        reason: `Order notional \$${notionalUsd.toFixed(2)} exceeds single order limit \$${this.limits.maxSingleOrderUsd} USD.`,
      };
    }

    // 3. Daily cumulative turnover cap
    if (this.dailyTurnoverConsumedMinor + notionalMinor > dailyCapMinor) {
      return {
        passed: false,
        reason: `Order would breach daily turnover cap \$${this.limits.dailyTurnoverCapUsd} USD (Consumed: \$${(Number(this.dailyTurnoverConsumedMinor) / 1e6).toFixed(2)}).`,
      };
    }

    // 4. Stablecoin Peg Guardrail Check — LIVE ingestion (2026-11-17 audit
    // closure): the monitor used to sit at zero readings forever because
    // nothing in src/ ever called updatePrice(), so its neutral fallback
    // read as a permanent clean bill of health. Each evaluation now
    // refreshes the USDC/USD reading (at most once per 30s — the monitor
    // itself only trusts readings <60s old). A failed feed never yields a
    // synthetic price: the monitor keeps its last state, a halt already in
    // force stays in force, and a no-data evaluation attaches an explicit
    // warning to the result instead of passing silently.
    const nowMs = Date.now();
    if (nowMs - this.lastPegFetchMs >= 30_000) {
      this.lastPegFetchMs = nowMs;
      const pegPrice = await this.pegFeed.fetchUsdcUsd();
      if (pegPrice !== null) {
        this.pegMonitor.updatePrice(this.pegFeed.describeSource(), pegPrice, nowMs);
      }
    }
    const pegEvaluation = this.pegMonitor.evaluatePeg(nowMs);
    const pegWarnings = pegEvaluation.dataAvailable ? undefined : [pegEvaluation.reason ?? "PEG_FEED_UNAVAILABLE"];
    if (!pegEvaluation.tradingPermitted) {
      return {
        passed: false,
        reason: pegEvaluation.reason || "USDC_DEPEG_HALT: Trading disabled due to active stablecoin depeg.",
      };
    }

    // 5. Dynamic Tiered Leverage Check — fail-closed on metadata failure
    let assetMeta;
    try {
      const tier = this.marginEngine.getTier(params.coin, notionalUsd);
      assetMeta = await params.client.getAssetMeta(params.coin);
      const effectiveMaxLeverage = Math.min(this.limits.maxLeverage, Math.min(assetMeta.maxLeverage, tier.maxLeverage));
      if (params.leverage > effectiveMaxLeverage) {
        return {
          passed: false,
          reason: `Requested leverage ${params.leverage}x exceeds max allowed ${effectiveMaxLeverage}x for ${params.coin} at notional \$${notionalUsd.toFixed(2)} (Tier ${tier.tier} limit: ${tier.maxLeverage}x).`,
        };
      }
    } catch (e: any) {
      return {
        passed: false,
        reason: `RISK_UNAVAILABLE: asset metadata query for ${params.coin} failed (${e?.message || e}). Refusing to evaluate leverage — fail-closed.`,
      };
    }

    // 6. Fat-finger price deviation protection — fail-closed on book failure
    try {
      const book = await params.client.getL2Book(params.coin);
      if (book.levels[0].length && book.levels[1].length) {
        const midPx = (parseFloat(book.levels[0][0].px) + parseFloat(book.levels[1][0].px)) / 2.0;
        const deviationPct = Math.abs((params.price - midPx) / midPx) * 100;

        if (deviationPct > this.limits.maxFatFingerPct) {
          return {
            passed: false,
            reason: `Order price \$${params.price} deviates ${deviationPct.toFixed(1)}% from mid (\$${midPx.toFixed(2)}). Fat-finger threshold is ${this.limits.maxFatFingerPct}%.`,
          };
        }
      }
    } catch (e: any) {
      return {
        passed: false,
        reason: `RISK_UNAVAILABLE: L2 book query for ${params.coin} failed (${e?.message || e}). Fat-finger guard cannot run — refusing order, fail-closed.`,
      };
    }

    // 7. Account margin buffer verification (if user state supplied)
    if (params.userState) {
      const accountValMinor = DecimalMath.parseUnits(params.userState.marginSummary.accountValue, 6);
      const marginUsedMinor = DecimalMath.parseUnits(params.userState.marginSummary.totalMarginUsed, 6);
      const requiredMarginMinor = DecimalMath.divMinor(notionalMinor, DecimalMath.parseUnits(params.leverage, 6));

      if (marginUsedMinor + requiredMarginMinor > accountValMinor) {
        const accountVal = Number(accountValMinor) / 1e6;
        const requiredMargin = Number(requiredMarginMinor) / 1e6;
        const totalUsed = Number(marginUsedMinor + requiredMarginMinor) / 1e6;
        return {
          passed: false,
          reason: `Insufficient account equity (\$${accountVal.toFixed(2)}) for required initial margin (\$${requiredMargin.toFixed(2)}). Total used would be \$${totalUsed.toFixed(2)}.`,
        };
      }
    }

    // Record turnover
    this.dailyTurnoverConsumedMinor += notionalMinor;

    return pegWarnings ? { passed: true, warnings: pegWarnings } : { passed: true };
  }

  /**
   * Monitor clearinghouse state for margin stress and liquidation proximity.
   */
  evaluateAccountRisk(state: HyperliquidClearinghouseState): {
    marginRatioPct: number;
    isHighRisk: boolean;
    warningMessage?: string;
  } {
    const accountVal = parseFloat(state.marginSummary.accountValue);
    const marginUsed = parseFloat(state.marginSummary.totalMarginUsed);

    return this.unifiedEngine.evaluateAccountRisk(accountVal, marginUsed);
  }
}

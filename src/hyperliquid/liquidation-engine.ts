/**
 * Hyperliquid L1 Protocol Liquidation Engine (2026)
 * 
 * Implements the verified, tier-aware protocol liquidation equation:
 * 
 *   P_liq = P_entry - (s * M_available) / [Q * (1 - s * l)]
 * 
 * Where:
 * - s: +1 for Long, -1 for Short
 * - Q: absolute position size |size|
 * - M_available:
 *     Cross Margin: Account Value - Total Maintenance Margin Required
 *     Isolated Margin: Assigned Margin - Position Maintenance Margin Required
 * - l: applicable maintenance margin rate for the position's notional tier
 * 
 * Also models the documented exchange liquidation lifecycle:
 * - <= 100,000 USDC: Full aggressive market order
 * - > 100,000 USDC: 20% partial liquidation with 30-second cooldown
 * - Equity < (2/3 * MMR): Liquidator vault backstop takeover
 */

import { MarginEngine, MarginTier } from "./margin-engine";
import { HyperliquidClearinghouseState } from "./types";

export interface LiquidationEstimate {
  coin: string;
  isBuy: boolean; // true = Long, false = Short
  positionSize: number;
  entryPrice: number;
  availableMarginUsd: number;
  maintenanceMarginRate: number;
  liquidationPrice: number;
  distanceToLiquidationPct: number;
  marginMode: "cross" | "isolated";
  liquidationType: "FULL_MARKET_ORDER" | "PARTIAL_20_PERCENT_ORDER";
  vaultTakeoverThresholdUsd: number;
}

export class LiquidationEngine {
  public static readonly PARTIAL_LIQ_NOTIONAL_THRESHOLD_USD = 100_000;
  public static readonly COOLDOWN_DURATION_MS = 30_000;

  private marginEngine: MarginEngine;
  private cooldownTimers: Map<string, number> = new Map();

  constructor(marginEngine?: MarginEngine) {
    this.marginEngine = marginEngine || new MarginEngine();
  }

  /**
   * Computes the exact protocol liquidation price:
   * P_liq = P_entry - (s * M_available) / [Q * (1 - s * l)]
   */
  public computeLiquidationPrice(params: {
    coin: string;
    isLong: boolean;
    size: number;
    entryPrice: number;
    availableMarginUsd: number;
    marginMode?: "cross" | "isolated";
  }): LiquidationEstimate {
    const s = params.isLong ? 1 : -1;
    const Q = Math.abs(params.size);
    const P_entry = params.entryPrice;
    const M_available = params.availableMarginUsd;

    if (Q === 0) {
      return {
        coin: params.coin,
        isBuy: params.isLong,
        positionSize: 0,
        entryPrice: P_entry,
        availableMarginUsd: M_available,
        maintenanceMarginRate: 0,
        liquidationPrice: 0,
        distanceToLiquidationPct: 100,
        marginMode: params.marginMode || "cross",
        liquidationType: "FULL_MARKET_ORDER",
        vaultTakeoverThresholdUsd: 0,
      };
    }

    const notionalUsd = Q * P_entry;
    const tier = this.marginEngine.getTier(params.coin, notionalUsd);
    const l = tier.maintenanceMarginRate;

    // Denominator: Q * (1 - s * l)
    const denominator = Q * (1.0 - s * l);
    if (denominator <= 0) {
      throw new Error(`INVALID_LIQUIDATION_DENOMINATOR: (1 - s * l) <= 0 with l=${l}`);
    }

    // P_liq = P_entry - (s * M_available) / denominator
    let P_liq = P_entry - (s * M_available) / denominator;
    P_liq = Math.max(0, P_liq);

    // Distance in percentage
    const distanceToLiquidationPct =
      P_entry > 0 ? (Math.abs(P_entry - P_liq) / P_entry) * 100 : 100;

    // Liquidation execution mode check
    const liquidationType =
      notionalUsd > LiquidationEngine.PARTIAL_LIQ_NOTIONAL_THRESHOLD_USD
        ? "PARTIAL_20_PERCENT_ORDER"
        : "FULL_MARKET_ORDER";

    // HLP Liquidator vault takeover trigger: Account Equity < (2/3 * MMR)
    const mmr = notionalUsd * l - tier.cumDeductionUsd;
    const vaultTakeoverThresholdUsd = (2.0 / 3.0) * Math.max(0, mmr);

    return {
      coin: params.coin,
      isBuy: params.isLong,
      positionSize: Q,
      entryPrice: P_entry,
      availableMarginUsd: M_available,
      maintenanceMarginRate: l,
      liquidationPrice: P_liq,
      distanceToLiquidationPct,
      marginMode: params.marginMode || "cross",
      liquidationType,
      vaultTakeoverThresholdUsd,
    };
  }

  /**
   * Evaluates clearinghouse state against protocol liquidation equations.
   */
  public evaluateState(state: HyperliquidClearinghouseState): {
    totalAccountValueUsd: number;
    totalMaintenanceMarginRequiredUsd: number;
    availableCrossMarginUsd: number;
    isLiquidationImminent: boolean;
    positions: LiquidationEstimate[];
  } {
    const totalAccountValueUsd = parseFloat(state.marginSummary.accountValue || "0");
    const totalMaintenanceMarginRequiredUsd = parseFloat(
      state.crossMaintenanceMarginUsed || state.marginSummary.totalMarginUsed || "0"
    );
    const availableCrossMarginUsd = Math.max(
      0,
      totalAccountValueUsd - totalMaintenanceMarginRequiredUsd
    );

    const positions: LiquidationEstimate[] = [];
    let isLiquidationImminent = false;

    if (Array.isArray(state.assetPositions)) {
      for (const item of state.assetPositions) {
        const pos = item.position;
        const size = parseFloat(pos.szi);
        if (size === 0) continue;

        const isLong = size > 0;
        const entryPrice = parseFloat(pos.entryPx);
        const marginMode = pos.leverage?.type === "isolated" ? "isolated" : "cross";

        let availableMargin = availableCrossMarginUsd;
        if (marginMode === "isolated" && pos.leverage?.rawUsd) {
          const isolatedAssigned = parseFloat(pos.leverage.rawUsd);
          const mmr = this.marginEngine.computeMaintenanceMargin(pos.coin, size, entryPrice);
          availableMargin = Math.max(0, isolatedAssigned - mmr.maintenanceMarginUsd);
        }

        const estimate = this.computeLiquidationPrice({
          coin: pos.coin,
          isLong,
          size,
          entryPrice,
          availableMarginUsd: availableMargin,
          marginMode,
        });

        if (estimate.distanceToLiquidationPct < 5.0) {
          isLiquidationImminent = true;
        }

        positions.push(estimate);
      }
    }

    return {
      totalAccountValueUsd,
      totalMaintenanceMarginRequiredUsd,
      availableCrossMarginUsd,
      isLiquidationImminent,
      positions,
    };
  }

  /**
   * Tracks partial liquidation cooldown state (30 seconds).
   */
  public registerPartialLiquidation(coin: string, nowMs: number = Date.now()): void {
    this.cooldownTimers.set(coin.toUpperCase(), nowMs + LiquidationEngine.COOLDOWN_DURATION_MS);
  }

  public isUnderCooldown(coin: string, nowMs: number = Date.now()): boolean {
    const expiry = this.cooldownTimers.get(coin.toUpperCase());
    if (!expiry) return false;
    return nowMs < expiry;
  }
}

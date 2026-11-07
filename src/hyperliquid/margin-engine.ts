/**
 * Hyperliquid L1 Dynamic Margin & Tier Engine (2026)
 * 
 * Implements verified tiered leverage, maintenance margin rates (MMR),
 * and cumulative tier deductions parameterized dynamically by asset and position notional.
 * 
 * Invariants:
 * - Dynamic metadata overrides hardcoded defaults.
 * - Cumulative deductions eliminate discrete cliff edges at tier boundaries.
 * - Maintenance margin requirement: MMR = Notional * l_k - Deduction_k.
 * - Initial margin requirement: IMR = Notional / Leverage.
 */

export interface MarginTier {
  tier: number;
  maxNotionalUsd: number;
  maxLeverage: number;
  maintenanceMarginRate: number; // l = 1 / (2 * maxLeverage)
  cumDeductionUsd: number;
}

export interface AssetMarginConfig {
  coin: string;
  tiers: MarginTier[];
}

export class MarginEngine {
  private assetConfigs: Map<string, AssetMarginConfig> = new Map();

  constructor() {
    this.initDefaultTiers();
  }

  /**
   * Initialize documented protocol margin tier structures.
   */
  private initDefaultTiers(): void {
    // BTC: Tier 1 (40x), Tier 2 (20x), Tier 3 (10x)
    this.assetConfigs.set("BTC", {
      coin: "BTC",
      tiers: [
        {
          tier: 1,
          maxNotionalUsd: 1_000_000,
          maxLeverage: 40,
          maintenanceMarginRate: 1 / (2 * 40), // 0.0125 (1.25%)
          cumDeductionUsd: 0,
        },
        {
          tier: 2,
          maxNotionalUsd: 5_000_000,
          maxLeverage: 20,
          maintenanceMarginRate: 1 / (2 * 20), // 0.0250 (2.50%)
          cumDeductionUsd: 12_500, // (0.025 - 0.0125) * 1,000,000
        },
        {
          tier: 3,
          maxNotionalUsd: Infinity,
          maxLeverage: 10,
          maintenanceMarginRate: 1 / (2 * 10), // 0.0500 (5.00%)
          cumDeductionUsd: 137_500,
        },
      ],
    });

    // ETH: Tier 1 (25x), Tier 2 (15x), Tier 3 (10x)
    this.assetConfigs.set("ETH", {
      coin: "ETH",
      tiers: [
        {
          tier: 1,
          maxNotionalUsd: 500_000,
          maxLeverage: 25,
          maintenanceMarginRate: 1 / (2 * 25), // 0.0200 (2.00%)
          cumDeductionUsd: 0,
        },
        {
          tier: 2,
          maxNotionalUsd: 2_500_000,
          maxLeverage: 15,
          maintenanceMarginRate: 1 / (2 * 15), // 0.0333 (3.33%)
          cumDeductionUsd: 6_666.67,
        },
        {
          tier: 3,
          maxNotionalUsd: Infinity,
          maxLeverage: 10,
          maintenanceMarginRate: 1 / (2 * 10), // 0.0500 (5.00%)
          cumDeductionUsd: 48_333.33,
        },
      ],
    });

    // SOL: Tier 1 (20x), Tier 2 (10x), Tier 3 (5x)
    this.assetConfigs.set("SOL", {
      coin: "SOL",
      tiers: [
        {
          tier: 1,
          maxNotionalUsd: 250_000,
          maxLeverage: 20,
          maintenanceMarginRate: 1 / (2 * 20), // 0.0250 (2.50%)
          cumDeductionUsd: 0,
        },
        {
          tier: 2,
          maxNotionalUsd: 1_000_000,
          maxLeverage: 10,
          maintenanceMarginRate: 1 / (2 * 10), // 0.0500 (5.00%)
          cumDeductionUsd: 6_250,
        },
        {
          tier: 3,
          maxNotionalUsd: Infinity,
          maxLeverage: 5,
          maintenanceMarginRate: 1 / (2 * 5), // 0.1000 (10.00%)
          cumDeductionUsd: 56_250,
        },
      ],
    });
  }

  /**
   * Update tiers dynamically from meta and asset context metadata.
   */
  public updateAssetMeta(coin: string, maxLeverage: number): void {
    const cleanCoin = coin.replace(/-PERP$/i, "").toUpperCase();
    const existing = this.assetConfigs.get(cleanCoin);
    const tier1Rate = 1.0 / (2.0 * maxLeverage);

    if (existing) {
      existing.tiers[0].maxLeverage = maxLeverage;
      existing.tiers[0].maintenanceMarginRate = tier1Rate;
    } else {
      this.assetConfigs.set(cleanCoin, {
        coin: cleanCoin,
        tiers: [
          {
            tier: 1,
            maxNotionalUsd: 250_000,
            maxLeverage,
            maintenanceMarginRate: tier1Rate,
            cumDeductionUsd: 0,
          },
          {
            tier: 2,
            maxNotionalUsd: 1_000_000,
            maxLeverage: Math.max(1, Math.floor(maxLeverage / 2)),
            maintenanceMarginRate: tier1Rate * 2,
            cumDeductionUsd: 250_000 * tier1Rate,
          },
        ],
      });
    }
  }

  /**
   * Resolves the active margin tier for a given position notional.
   */
  public getTier(coin: string, notionalUsd: number): MarginTier {
    const cleanCoin = coin.replace(/-PERP$/i, "").toUpperCase();
    const config = this.assetConfigs.get(cleanCoin);

    if (!config || !config.tiers.length) {
      // Conservative default fallback (20x, 2.5% MMR)
      return {
        tier: 1,
        maxNotionalUsd: Infinity,
        maxLeverage: 20,
        maintenanceMarginRate: 0.025,
        cumDeductionUsd: 0,
      };
    }

    const absNotional = Math.abs(notionalUsd);
    for (const tier of config.tiers) {
      if (absNotional <= tier.maxNotionalUsd) {
        return tier;
      }
    }

    return config.tiers[config.tiers.length - 1];
  }

  /**
   * Computes Tiered Maintenance Margin Required (MMR):
   * MMR = Notional * l_k - cumDeduction_k
   */
  public computeMaintenanceMargin(coin: string, positionSize: number, markPrice: number): {
    notionalUsd: number;
    tier: MarginTier;
    maintenanceMarginRate: number;
    maintenanceMarginUsd: number;
  } {
    const notionalUsd = Math.abs(positionSize * markPrice);
    const tier = this.getTier(coin, notionalUsd);
    const rawMmr = notionalUsd * tier.maintenanceMarginRate - tier.cumDeductionUsd;
    const maintenanceMarginUsd = Math.max(0, rawMmr);

    return {
      notionalUsd,
      tier,
      maintenanceMarginRate: tier.maintenanceMarginRate,
      maintenanceMarginUsd,
    };
  }

  /**
   * Computes Initial Margin Required (IMR):
   * IMR = Notional / Leverage
   */
  public computeInitialMargin(coin: string, positionSize: number, price: number, leverage: number): {
    notionalUsd: number;
    initialMarginUsd: number;
    allowedLeverage: number;
  } {
    const notionalUsd = Math.abs(positionSize * price);
    const tier = this.getTier(coin, notionalUsd);
    const allowedLeverage = Math.min(leverage, tier.maxLeverage);
    const initialMarginUsd = notionalUsd / allowedLeverage;

    return {
      notionalUsd,
      initialMarginUsd,
      allowedLeverage,
    };
  }
}

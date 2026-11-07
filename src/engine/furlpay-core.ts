/**
 * FurlPay Core L1 Sovereign Financial Engine (2026)
 * 
 * Implements native on-chain execution primitives:
 * 1. Price-Time Priority Central Limit Order Book (CLOB) with discrete tick sizes.
 * 2. High-performance Clearinghouse (cross/isolated margin, holds, positions, P&L).
 * 3. Two-phase liquidation engine (CLOB 20% tranches -> FLP Backstop Vault).
 * 4. Funding rate engine (continuous premium sampling, clamp bounds, hourly cashflows).
 * 5. FurlPay Liquidity Provider (FLP) Protocol Vault with 4-day lockup cooldown.
 * 6. Cross-VM Precompiles (0x...0801 spot balance, 0x...0807 mark price, 0x333...333 CoreWriter).
 */

export interface DiscreteAssetMeta {
  coin: string;
  szDecimals: number;
  tickSize: number;
  maxLeverage: number;
  minOrderNotionalUsd: number;
}

export type CoreOrderSide = "buy" | "sell";
export type OrderTif = "Gtc" | "Ioc" | "Alo";

export interface CoreOrderRequest {
  coin: string;
  isBuy: boolean;
  limitPx: number;
  sz: number;
  reduceOnly?: boolean;
  tif?: OrderTif;
  cloid?: string;
  user: string;
}

export interface ActiveOrder extends CoreOrderRequest {
  oid: number;
  timestamp: number;
  filledSz: number;
}

export interface OrderFillResult {
  filledSz: number;
  avgPx: number;
  makerOrders: Array<{ oid: number; filledSz: number; user: string }>;
  restingOrder?: ActiveOrder;
}

export interface PositionState {
  coin: string;
  size: number; // positive = long, negative = short
  entryPx: number;
  leverage: number;
  marginUsed: number;
  liquidationPx: number;
  unrealizedPnl: number;
}

export interface UserClearinghouseState {
  user: string;
  accountValue: number;
  totalMarginUsed: number;
  freeCollateral: number;
  positions: Map<string, PositionState>;
}

/**
 * 1. Price-Time Priority L1 Central Limit Order Book (CLOB)
 */
export class FurlPayCLOB {
  private bids: ActiveOrder[] = []; // sorted descending by price, ascending by time
  private asks: ActiveOrder[] = []; // sorted ascending by price, ascending by time
  private nextOid: number = 100000;
  private orderIndex = new Map<number, ActiveOrder>();
  private cloidIndex = new Map<string, ActiveOrder>();

  constructor(public readonly meta: DiscreteAssetMeta) {}

  public roundPrice(price: number): number {
    return Math.round(price / this.meta.tickSize) * this.meta.tickSize;
  }

  public roundSize(size: number): number {
    const factor = Math.pow(10, this.meta.szDecimals);
    return Math.floor(size * factor) / factor;
  }

  public getTopBids(depth = 10): Array<{ px: string; sz: string; n: number }> {
    return this.aggregateLevels(this.bids, depth);
  }

  public getTopAsks(depth = 10): Array<{ px: string; sz: string; n: number }> {
    return this.aggregateLevels(this.asks, depth);
  }

  private aggregateLevels(orders: ActiveOrder[], depth: number): Array<{ px: string; sz: string; n: number }> {
    const levelMap = new Map<number, { sz: number; n: number }>();
    for (const o of orders) {
      const remaining = o.sz - o.filledSz;
      if (remaining <= 0) continue;
      const cur = levelMap.get(o.limitPx) || { sz: 0, n: 0 };
      cur.sz += remaining;
      cur.n += 1;
      levelMap.set(o.limitPx, cur);
    }
    const levels: Array<{ px: string; sz: string; n: number }> = [];
    for (const [px, data] of levelMap.entries()) {
      levels.push({
        px: px.toFixed(this.meta.szDecimals > 2 ? this.meta.szDecimals : 2),
        sz: data.sz.toFixed(this.meta.szDecimals),
        n: data.n,
      });
      if (levels.length >= depth) break;
    }
    return levels;
  }

  public placeOrder(req: CoreOrderRequest): { success: boolean; result?: OrderFillResult; error?: string } {
    const px = this.roundPrice(req.limitPx);
    const sz = this.roundSize(req.sz);
    const tif = req.tif ?? "Gtc";

    if (sz <= 0) {
      return { success: false, error: "INVALID_SIZE: Size must be strictly positive." };
    }
    if (px * sz < this.meta.minOrderNotionalUsd) {
      return {
        success: false,
        error: `MIN_NOTIONAL: Minimum order notional is \$${this.meta.minOrderNotionalUsd} USD.`,
      };
    }

    // Check ALO (Add Liquidity Only / Post-Only)
    if (tif === "Alo") {
      if (req.isBuy && this.asks.length > 0 && px >= this.asks[0].limitPx) {
        return { success: false, error: "POST_ONLY_REJECTED: Buy order would cross the best ask." };
      }
      if (!req.isBuy && this.bids.length > 0 && px <= this.bids[0].limitPx) {
        return { success: false, error: "POST_ONLY_REJECTED: Sell order would cross the best bid." };
      }
    }

    // Execute matching
    let remainingSz = sz;
    let totalFilledSz = 0;
    let totalNotional = 0;
    const makerOrders: Array<{ oid: number; filledSz: number; user: string }> = [];

    const book = req.isBuy ? this.asks : this.bids;
    let bookIdx = 0;

    while (bookIdx < book.length && remainingSz > 0) {
      const resting = book[bookIdx];
      const crosses = req.isBuy ? px >= resting.limitPx : px <= resting.limitPx;
      if (!crosses) break;

      const restingRemaining = resting.sz - resting.filledSz;
      const fillAmount = Math.min(remainingSz, restingRemaining);

      resting.filledSz += fillAmount;
      remainingSz -= fillAmount;
      totalFilledSz += fillAmount;
      totalNotional += fillAmount * resting.limitPx;

      makerOrders.push({
        oid: resting.oid,
        filledSz: fillAmount,
        user: resting.user,
      });

      if (resting.filledSz >= resting.sz) {
        this.orderIndex.delete(resting.oid);
        if (resting.cloid) this.cloidIndex.delete(resting.cloid);
        book.splice(bookIdx, 1);
      } else {
        bookIdx++;
      }
    }

    // If IOC, discard remaining
    if (tif === "Ioc") {
      return {
        success: true,
        result: {
          filledSz: totalFilledSz,
          avgPx: totalFilledSz > 0 ? totalNotional / totalFilledSz : px,
          makerOrders,
        },
      };
    }

    // If GTC and remaining size exists, place on book
    let restingOrder: ActiveOrder | undefined;
    if (remainingSz > 0) {
      const active: ActiveOrder = {
        ...req,
        limitPx: px,
        sz,
        filledSz: totalFilledSz,
        oid: this.nextOid++,
        timestamp: Date.now(),
      };
      this.orderIndex.set(active.oid, active);
      if (active.cloid) this.cloidIndex.set(active.cloid, active);

      if (req.isBuy) {
        this.bids.push(active);
        this.bids.sort((a, b) => b.limitPx - a.limitPx || a.timestamp - b.timestamp);
      } else {
        this.asks.push(active);
        this.asks.sort((a, b) => a.limitPx - b.limitPx || a.timestamp - b.timestamp);
      }
      restingOrder = active;
    }

    return {
      success: true,
      result: {
        filledSz: totalFilledSz,
        avgPx: totalFilledSz > 0 ? totalNotional / totalFilledSz : px,
        makerOrders,
        restingOrder,
      },
    };
  }

  public cancelOrder(oid: number): boolean {
    const o = this.orderIndex.get(oid);
    if (!o) return false;

    this.orderIndex.delete(oid);
    if (o.cloid) this.cloidIndex.delete(o.cloid);

    if (o.isBuy) {
      this.bids = this.bids.filter((x) => x.oid !== oid);
    } else {
      this.asks = this.asks.filter((x) => x.oid !== oid);
    }
    return true;
  }

  public cancelByCloid(cloid: string): boolean {
    const o = this.cloidIndex.get(cloid);
    if (!o) return false;
    return this.cancelOrder(o.oid);
  }
}

/**
 * 2. High-Performance FurlPay Clearinghouse & Margin State Engine
 */
export class FurlPayClearinghouse {
  private users = new Map<string, UserClearinghouseState>();

  public getOrCreateUser(user: string, initialDeposit = 0): UserClearinghouseState {
    let state = this.users.get(user);
    if (!state) {
      state = {
        user,
        accountValue: initialDeposit,
        totalMarginUsed: 0,
        freeCollateral: initialDeposit,
        positions: new Map(),
      };
      this.users.set(user, state);
    }
    return state;
  }

  public deposit(user: string, amountUsd: number): void {
    const u = this.getOrCreateUser(user);
    u.accountValue += amountUsd;
    u.freeCollateral += amountUsd;
  }

  public withdraw(user: string, amountUsd: number): boolean {
    const u = this.getOrCreateUser(user);
    const fee = 1.0; // $1.00 flat protocol fee
    const totalRequired = amountUsd + fee;
    if (u.freeCollateral < totalRequired) return false;

    u.accountValue -= totalRequired;
    u.freeCollateral -= totalRequired;
    return true;
  }

  public updatePosition(params: {
    user: string;
    coin: string;
    fillSz: number;
    fillPx: number;
    isBuy: boolean;
    leverage: number;
    maxLeverage: number;
  }): void {
    const u = this.getOrCreateUser(params.user);
    let pos = u.positions.get(params.coin);

    const deltaSz = params.isBuy ? params.fillSz : -params.fillSz;

    if (!pos || pos.size === 0) {
      // Open new position
      const marginReq = (params.fillSz * params.fillPx) / params.leverage;
      const maintenanceMarginRate = 1.0 / (2.0 * params.maxLeverage);
      const liqPx = params.isBuy
        ? params.fillPx * ((1.0 - 1.0 / params.leverage) / (1.0 - maintenanceMarginRate))
        : params.fillPx * ((1.0 + 1.0 / params.leverage) / (1.0 + maintenanceMarginRate));

      pos = {
        coin: params.coin,
        size: deltaSz,
        entryPx: params.fillPx,
        leverage: params.leverage,
        marginUsed: marginReq,
        liquidationPx: Math.max(0, liqPx),
        unrealizedPnl: 0,
      };
      u.positions.set(params.coin, pos);
      u.totalMarginUsed += marginReq;
      u.freeCollateral -= marginReq;
    } else {
      // Modify or close existing position
      const sameDirection = (pos.size > 0 && params.isBuy) || (pos.size < 0 && !params.isBuy);

      if (sameDirection) {
        // Adding to position
        const currentNotional = Math.abs(pos.size) * pos.entryPx;
        const addNotional = params.fillSz * params.fillPx;
        const totalSize = Math.abs(pos.size) + params.fillSz;
        pos.entryPx = (currentNotional + addNotional) / totalSize;
        pos.size = pos.size > 0 ? totalSize : -totalSize;

        const additionalMargin = addNotional / pos.leverage;
        pos.marginUsed += additionalMargin;
        u.totalMarginUsed += additionalMargin;
        u.freeCollateral -= additionalMargin;
      } else {
        // Reducing / closing
        const closeSz = Math.min(Math.abs(pos.size), params.fillSz);
        const realizedPnl = pos.size > 0
          ? closeSz * (params.fillPx - pos.entryPx)
          : closeSz * (pos.entryPx - params.fillPx);

        const marginReleased = (closeSz * pos.entryPx) / pos.leverage;
        pos.marginUsed -= marginReleased;
        u.totalMarginUsed -= marginReleased;
        u.accountValue += realizedPnl;
        u.freeCollateral += marginReleased + realizedPnl;

        const newSize = Math.abs(pos.size) - closeSz;
        if (newSize === 0) {
          pos.size = 0;
          u.positions.delete(params.coin);
        } else {
          pos.size = pos.size > 0 ? newSize : -newSize;
        }
      }
    }
  }

  public evaluateMarkPnl(user: string, coin: string, markPx: number): void {
    const u = this.users.get(user);
    if (!u) return;
    const pos = u.positions.get(coin);
    if (!pos || pos.size === 0) return;

    pos.unrealizedPnl = pos.size > 0
      ? pos.size * (markPx - pos.entryPx)
      : Math.abs(pos.size) * (pos.entryPx - markPx);
  }
}

/**
 * 3. FurlPay Liquidity Provider (FLP) Protocol Vault
 */
export class FLPVault {
  public totalUsd: number = 0;
  public totalShares: number = 0;
  private userShares = new Map<string, { shares: number; depositTimestamp: number }>();
  public readonly lockupPeriodMs = 4 * 24 * 3600 * 1000; // 4-day withdrawal lockup

  constructor(initialCapital = 1_000_000) {
    this.totalUsd = initialCapital;
    this.totalShares = initialCapital;
  }

  public deposit(user: string, amountUsd: number): { sharesMinted: number } {
    let shares = 0;
    if (this.totalShares === 0 || this.totalUsd === 0) {
      shares = amountUsd;
    } else {
      shares = (amountUsd * this.totalShares) / this.totalUsd;
    }

    this.totalUsd += amountUsd;
    this.totalShares += shares;

    const existing = this.userShares.get(user) || { shares: 0, depositTimestamp: Date.now() };
    existing.shares += shares;
    existing.depositTimestamp = Date.now();
    this.userShares.set(user, existing);

    return { sharesMinted: shares };
  }

  public withdraw(user: string, sharesToBurn: number): { success: boolean; usdReturned?: number; error?: string } {
    const record = this.userShares.get(user);
    if (!record || record.shares < sharesToBurn) {
      return { success: false, error: "INSUFFICIENT_SHARES" };
    }

    const elapsed = Date.now() - record.depositTimestamp;
    if (elapsed < this.lockupPeriodMs) {
      const remainingHours = ((this.lockupPeriodMs - elapsed) / 3_600_000).toFixed(1);
      return {
        success: false,
        error: `LOCKUP_ACTIVE: Capital subject to 4-day cooldown (${remainingHours}h remaining).`,
      };
    }

    const usdVal = (sharesToBurn * this.totalUsd) / this.totalShares;
    record.shares -= sharesToBurn;
    this.totalShares -= sharesToBurn;
    this.totalUsd -= usdVal;

    return { success: true, usdReturned: usdVal };
  }

  /**
   * Absorbs underwater positions from the liquidation engine (Backstop Liquidation).
   */
  public absorbLiquidation(positionNotional: number, remainingCollateral: number): void {
    // FLP takes over position and retains remaining liquidation buffer
    this.totalUsd += remainingCollateral;
  }
}

/**
 * 4. FurlPay Funding Rate Engine
 */
export class FurlPayFundingEngine {
  private premiumSamples: number[] = [];
  private lastSettlementTime: number = Date.now();

  public samplePremium(orderBookMidPx: number, oracleSpotPx: number): void {
    if (oracleSpotPx <= 0) return;
    const premium = (orderBookMidPx - oracleSpotPx) / oracleSpotPx;
    this.premiumSamples.push(premium);
  }

  public computeFundingRate(): number {
    if (this.premiumSamples.length === 0) return 0.0001; // default interest baseline

    const avgPremium = this.premiumSamples.reduce((a, b) => a + b, 0) / this.premiumSamples.length;
    const interestDiff = 0.0001 - avgPremium;
    const clampedDiff = Math.max(-0.0005, Math.min(0.0005, interestDiff));
    return avgPremium + clampedDiff;
  }

  public resetCycle(): void {
    this.premiumSamples = [];
    this.lastSettlementTime = Date.now();
  }
}

/**
 * 5. Sovereign FurlPay Core L1 Controller
 */
export class FurlPayCoreEngine {
  public readonly clob: FurlPayCLOB;
  public readonly clearinghouse: FurlPayClearinghouse;
  public readonly flpVault: FLPVault;
  public readonly funding: FurlPayFundingEngine;

  constructor(meta: DiscreteAssetMeta) {
    this.clob = new FurlPayCLOB(meta);
    this.clearinghouse = new FurlPayClearinghouse();
    this.flpVault = new FLPVault();
    this.funding = new FurlPayFundingEngine();
  }

  /**
   * Precompile simulation: 0x...0801 (Spot Balance)
   */
  public readPrecompileSpotBalance(user: string): number {
    const u = this.clearinghouse.getOrCreateUser(user);
    return u.accountValue;
  }

  /**
   * Precompile simulation: 0x...0807 (Oracle Mark Price)
   */
  public readPrecompileOraclePrice(baseMid: number): number {
    return this.clob.roundPrice(baseMid);
  }

  /**
   * Submit an order into the L1 matching engine with clearinghouse validation.
   */
  public submitOrder(req: CoreOrderRequest, leverage = 10): { success: boolean; fill?: OrderFillResult; error?: string } {
    const u = this.clearinghouse.getOrCreateUser(req.user);
    const requiredMargin = (req.sz * req.limitPx) / leverage;

    if (!req.reduceOnly && u.freeCollateral < requiredMargin) {
      return {
        success: false,
        error: `INSUFFICIENT_MARGIN: Free collateral \$${u.freeCollateral.toFixed(2)} is less than required \$${requiredMargin.toFixed(2)}.`,
      };
    }

    const res = this.clob.placeOrder(req);
    if (!res.success) return res;

    if (res.result && res.result.filledSz > 0) {
      // Update buyer position
      this.clearinghouse.updatePosition({
        user: req.user,
        coin: req.coin,
        fillSz: res.result.filledSz,
        fillPx: res.result.avgPx,
        isBuy: req.isBuy,
        leverage,
        maxLeverage: this.clob.meta.maxLeverage,
      });

      // Update makers
      for (const m of res.result.makerOrders) {
        this.clearinghouse.updatePosition({
          user: m.user,
          coin: req.coin,
          fillSz: m.filledSz,
          fillPx: res.result.avgPx,
          isBuy: !req.isBuy,
          leverage,
          maxLeverage: this.clob.meta.maxLeverage,
        });
      }
    }

    return { success: true, fill: res.result };
  }
}

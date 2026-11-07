/**
 * Hyperliquid L1 Market Data Engine (2026)
 * 
 * Ingests and validates L2 order books, real-time trade ticks, and OHLCV candles:
 * - Stale quote detection (quote age > 200ms triggers lockout).
 * - Crossed-book invariant enforcement (Best Bid >= Best Ask rejected).
 * - Micro-price and depth-weighted volume calculations.
 * - Deterministic trade-to-candle aggregation without Math.random().
 */

import {
  HyperliquidL2Book,
  MicrostructureAnalytics,
  BookValidationResult,
  SlippageEstimate,
} from "./types";

export interface CandleTick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MarketDataEngine {
  public static readonly STALE_THRESHOLD_MS = 200;

  private activeBooks: Map<string, HyperliquidL2Book> = new Map();
  private bookTimestamps: Map<string, number> = new Map();
  private candleBuckets: Map<string, Map<number, CandleTick>> = new Map();

  /**
   * Validates L2 order book structure, freshness, and crossed-book invariant.
   */
  public validateBook(book: HyperliquidL2Book, nowMs: number = Date.now()): BookValidationResult {
    const errors: string[] = [];
    const bids = book.levels?.[0] || [];
    const asks = book.levels?.[1] || [];

    if (!bids.length || !asks.length) {
      errors.push("EMPTY_BOOK_LEVELS: Order book missing bids or asks.");
      return {
        valid: false,
        errors,
        isCrossed: false,
        bestBid: 0,
        bestAsk: 0,
        spread: 0,
        timestamp: book.time,
        levelsCount: { bids: bids.length, asks: asks.length },
      };
    }

    const bestBid = parseFloat(bids[0].px);
    const bestAsk = parseFloat(asks[0].px);
    const spread = bestAsk - bestBid;

    // Inverted or crossed book check
    const isCrossed = bestBid >= bestAsk;
    if (isCrossed) {
      errors.push(
        `CROSSED_ORDER_BOOK: Inverted book invariant breached (Best Bid \$${bestBid} >= Best Ask \$${bestAsk}).`
      );
    }

    // Monotonic ladder check
    for (let i = 1; i < Math.min(bids.length, 10); i++) {
      if (parseFloat(bids[i].px) >= parseFloat(bids[i - 1].px)) {
        errors.push(`INVALID_BID_LADDER: Bid level ${i} not strictly descending.`);
        break;
      }
    }
    for (let i = 1; i < Math.min(asks.length, 10); i++) {
      if (parseFloat(asks[i].px) <= parseFloat(asks[i - 1].px)) {
        errors.push(`INVALID_ASK_LADDER: Ask level ${i} not strictly ascending.`);
        break;
      }
    }

    // Freshness check
    const ageMs = nowMs - book.time;
    if (ageMs > MarketDataEngine.STALE_THRESHOLD_MS) {
      errors.push(
        `STALE_BOOK_DATA: Quote age (${ageMs}ms) exceeds max freshness threshold (${MarketDataEngine.STALE_THRESHOLD_MS}ms).`
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      isCrossed,
      bestBid,
      bestAsk,
      spread,
      timestamp: book.time,
      levelsCount: { bids: bids.length, asks: asks.length },
    };
  }

  /**
   * Ingests and stores an updated L2 book if valid.
   */
  public updateBook(book: HyperliquidL2Book, recvTimeMs: number = Date.now()): BookValidationResult {
    const validation = this.validateBook(book, recvTimeMs);
    if (validation.valid) {
      this.activeBooks.set(book.coin.toUpperCase(), book);
      this.bookTimestamps.set(book.coin.toUpperCase(), recvTimeMs);
    }
    return validation;
  }

  public getBook(coin: string): HyperliquidL2Book | undefined {
    return this.activeBooks.get(coin.toUpperCase());
  }

  public isBookFresh(coin: string, nowMs: number = Date.now()): boolean {
    const lastRecv = this.bookTimestamps.get(coin.toUpperCase());
    if (!lastRecv) return false;
    return nowMs - lastRecv <= MarketDataEngine.STALE_THRESHOLD_MS;
  }

  /**
   * Computes Microstructure Analytics:
   * - Mid Price & Micro-Price (volume-weighted top level)
   * - Volume-Weighted Spread (VWS) across top 5 levels
   * - Liquidity Herfindahl-Hirschman Index (HHI concentration)
   */
  public computeAnalytics(coin: string, nowMs: number = Date.now()): MicrostructureAnalytics | null {
    const book = this.activeBooks.get(coin.toUpperCase());
    if (!book) return null;

    const bids = book.levels[0];
    const asks = book.levels[1];
    if (!bids.length || !asks.length) return null;

    const bestBidPx = parseFloat(bids[0].px);
    const bestBidSz = parseFloat(bids[0].sz);
    const bestAskPx = parseFloat(asks[0].px);
    const bestAskSz = parseFloat(asks[0].sz);

    const midPrice = (bestBidPx + bestAskPx) / 2.0;

    // Depth-weighted Micro-Price
    const microPrice = (bestBidPx * bestAskSz + bestAskPx * bestBidSz) / (bestBidSz + bestAskSz);

    // Volume-Weighted Spread (VWS) across top 5 levels
    let vwsNumerator = 0;
    let vwsDenominator = 0;
    const depthLevels = Math.min(5, Math.min(bids.length, asks.length));
    for (let i = 0; i < depthLevels; i++) {
      const spreadLvl = parseFloat(asks[i].px) - parseFloat(bids[i].px);
      const volLvl = parseFloat(asks[i].sz) + parseFloat(bids[i].sz);
      vwsNumerator += spreadLvl * volLvl;
      vwsDenominator += volLvl;
    }
    const volumeWeightedSpread = vwsDenominator > 0 ? vwsNumerator / vwsDenominator : bestAskPx - bestBidPx;

    // Total Depth
    let bidDepthTotal = 0;
    let askDepthTotal = 0;
    for (const b of bids) bidDepthTotal += parseFloat(b.sz) * parseFloat(b.px);
    for (const a of asks) askDepthTotal += parseFloat(a.sz) * parseFloat(a.px);

    // Liquidity HHI
    let hhiSum = 0;
    const totalDepth = bidDepthTotal + askDepthTotal;
    if (totalDepth > 0) {
      for (const b of bids.slice(0, 10)) {
        const share = (parseFloat(b.sz) * parseFloat(b.px)) / totalDepth;
        hhiSum += share * share;
      }
      for (const a of asks.slice(0, 10)) {
        const share = (parseFloat(a.sz) * parseFloat(a.px)) / totalDepth;
        hhiSum += share * share;
      }
    }

    const ageMs = nowMs - book.time;
    return {
      coin,
      timestamp: nowMs,
      midPrice,
      microPrice,
      volumeWeightedSpread,
      rollingOfi: 0,
      liquidityHhi: hhiSum,
      bidDepthTotal,
      askDepthTotal,
      exchangeTimestampMs: book.time,
      receivedAtMs: this.bookTimestamps.get(coin.toUpperCase()) || nowMs,
      feedLatencyMs: ageMs,
      isStale: ageMs > MarketDataEngine.STALE_THRESHOLD_MS,
    };
  }

  /**
   * Deterministic slippage and market impact estimation.
   */
  public estimateSlippage(
    coin: string,
    side: "buy" | "sell",
    targetSize: number
  ): SlippageEstimate | null {
    const book = this.activeBooks.get(coin.toUpperCase());
    if (!book) return null;

    const levels = side === "buy" ? book.levels[1] : book.levels[0];
    if (!levels || !levels.length) return null;

    const midPx = (parseFloat(book.levels[0][0].px) + parseFloat(book.levels[1][0].px)) / 2.0;

    let remaining = targetSize;
    let totalCost = 0;

    for (const lvl of levels) {
      const px = parseFloat(lvl.px);
      const sz = parseFloat(lvl.sz);
      const fillSz = Math.min(remaining, sz);

      totalCost += fillSz * px;
      remaining -= fillSz;

      if (remaining <= 0) break;
    }

    const filledSz = targetSize - remaining;
    const expectedAvgPrice = filledSz > 0 ? totalCost / filledSz : parseFloat(levels[0].px);
    const targetNotionalUsd = targetSize * midPx;
    const slippageUsd = Math.abs(totalCost - targetSize * midPx);
    const priceImpactPct = ((expectedAvgPrice - midPx) / midPx) * 100 * (side === "buy" ? 1 : -1);

    return {
      targetSize,
      targetNotionalUsd,
      side,
      expectedAvgPrice,
      priceImpactPct,
      slippageUsd,
      canFillFully: remaining <= 0,
    };
  }

  /**
   * Ingests a trade and updates rolling 1-minute OHLCV candles.
   */
  public ingestTrade(coin: string, price: number, size: number, timeMs: number): CandleTick {
    const cleanCoin = coin.toUpperCase();
    if (!this.candleBuckets.has(cleanCoin)) {
      this.candleBuckets.set(cleanCoin, new Map());
    }

    const bucketMap = this.candleBuckets.get(cleanCoin)!;
    const minuteBucket = Math.floor(timeMs / 60_000) * 60_000;

    let candle = bucketMap.get(minuteBucket);
    if (!candle) {
      candle = {
        time: minuteBucket,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: size,
      };
      bucketMap.set(minuteBucket, candle);
    } else {
      candle.high = Math.max(candle.high, price);
      candle.low = Math.min(candle.low, price);
      candle.close = price;
      candle.volume += size;
    }

    return candle;
  }

  public getCandles(coin: string, limit: number = 60): CandleTick[] {
    const bucketMap = this.candleBuckets.get(coin.toUpperCase());
    if (!bucketMap) return [];
    return Array.from(bucketMap.values())
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }
}

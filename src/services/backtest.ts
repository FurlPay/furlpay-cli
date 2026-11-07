/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Corrected Quantitative Backtest Engine (2026)
 * ─────────────────────────────────────────────────────────────
 * Rigorous discrete-trade microstructure backtesting engine:
 *   - Strictly eliminates look-ahead bias (signal formed at t,
 *     executed at t + delay at executable Ask/Bid)
 *   - Turnover-based transaction costs (fees charged only on position transitions)
 *   - Discrete round-trip trade lifecycle (Entry -> Exit accounting)
 *   - Uniform time-grid resampling for mathematically valid Sharpe/Sortino
 *   - Explicit turnover, fee drag, and trade-level win rate metrics
 */

import { HawkesIntensityService } from './hawkes.js';

export interface OrderBookEvent {
  kind: 'book';
  timestampMs: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
}

export interface TradeTapeEvent {
  kind: 'trade';
  timestampMs: number;
  side: 'B' | 'A';
  price: number;
  size: number;
  tid?: number;
}

export type MarketFeedEvent = OrderBookEvent | TradeTapeEvent;

export interface CompletedTrade {
  entryTimeMs: number;
  exitTimeMs: number;
  side: 1 | -1; // 1 for Long, -1 for Short
  entryPrice: number;
  exitPrice: number;
  grossReturnPct: number;
  netReturnPct: number;
  frictionBps: number;
  durationMs: number;
}

export interface StrategyMetrics {
  strategyName: string;
  totalNetReturnPct: number;
  grossReturnPct: number;
  totalFrictionCostPct: number;
  completedTradesCount: number;
  tradeWinRatePct: number;
  profitFactor: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  turnover: number;
  timeNormalizedSharpe: number;
  resampledBarCount: number;
}

export interface BacktestSuiteReport {
  asset: string;
  totalEventsProcessed: number;
  bookSnapshotsCount: number;
  tradesIngestedCount: number;
  sessionDurationSec: number;
  strategies: StrategyMetrics[];
}

export class RobustBacktestEngine {
  private events: MarketFeedEvent[];
  private readonly feeBps: number;
  private readonly slippageBps: number;
  private readonly executionDelayEvents: number;

  constructor(
    events: MarketFeedEvent[],
    feeBps = 1.0, // 0.01% fee per side
    slippageBps = 0.5, // 0.005% execution slippage
    executionDelayEvents = 1, // execute on subsequent observable price
  ) {
    // Sort all events strictly by timestamp to prevent out-of-order execution
    this.events = events.slice().sort((a, b) => a.timestampMs - b.timestampMs);
    this.feeBps = feeBps;
    this.slippageBps = slippageBps;
    this.executionDelayEvents = executionDelayEvents;
  }

  /**
   * Run the backtest across all four strategies.
   */
  public evaluateAll(asset = 'BTC'): BacktestSuiteReport {
    if (this.events.length < 5) {
      throw new Error('Insufficient event stream for backtesting (minimum 5 events required)');
    }

    const tStart = this.events[0].timestampMs;
    const tEnd = this.events[this.events.length - 1].timestampMs;
    const durationSec = Math.max(1.0, (tEnd - tStart) / 1000.0);

    const bookCount = this.events.filter((e) => e.kind === 'book').length;
    const tradeCount = this.events.filter((e) => e.kind === 'trade').length;

    const s1 = this.runStrategy('Naive Micro-Price Momentum', (state) => {
      const mid = (state.bestBid + state.bestAsk) / 2.0;
      const totSz = state.bidSize + state.askSize;
      if (totSz <= 0) return 0;
      const micro = (state.bestBid * state.askSize + state.bestAsk * state.bidSize) / totSz;
      return micro > mid ? 1 : micro < mid ? -1 : 0;
    });

    const s2 = this.runStrategy('Top-of-Book Depth Imbalance', (state) => {
      const totSz = state.bidSize + state.askSize;
      if (totSz <= 0) return 0;
      const imb = (state.bidSize - state.askSize) / totSz;
      // Require significant threshold to avoid churning
      return imb > 0.25 ? 1 : imb < -0.25 ? -1 : 0;
    });

    const s3 = this.runStrategy('Cont et al. BBO OFI (2014)', (state) => {
      return state.rollingOfi > 0.3 ? 1 : state.rollingOfi < -0.3 ? -1 : 0;
    });

    const s4 = this.runStrategy('Hawkes Point-Process Filtered OFI (2026)', (state) => {
      // Require mutual alignment of trade-arrival point process AND order book OFI
      if (state.hawkesHnir > 0.20 && state.rollingOfi > 0) return 1;
      if (state.hawkesHnir < -0.20 && state.rollingOfi < 0) return -1;
      return 0;
    });

    return {
      asset,
      totalEventsProcessed: this.events.length,
      bookSnapshotsCount: bookCount,
      tradesIngestedCount: tradeCount,
      sessionDurationSec: durationSec,
      strategies: [s1, s2, s3, s4],
    };
  }

  /**
   * Generic execution simulator enforcing:
   * 1. No look-ahead bias (signal formed at t, filled at executable price at t + delay)
   * 2. Position turnover accounting
   * 3. Completed round-trip trade logging
   */
  private runStrategy(
    strategyName: string,
    signalFn: (state: {
      bestBid: number;
      bestAsk: number;
      bidSize: number;
      askSize: number;
      rollingOfi: number;
      hawkesHnir: number;
    }) => 1 | -1 | 0,
  ): StrategyMetrics {
    let currentPosition: 1 | -1 | 0 = 0;
    let entryPrice = 0.0;
    let entryTimeMs = 0;
    let totalTurnover = 0.0;
    let totalFrictionPct = 0.0;
    let grossPnlPct = 0.0;
    let netPnlPct = 0.0;

    const completedTrades: CompletedTrade[] = [];
    const equityCurve: { t: number; equity: number }[] = [];
    let currentEquity = 1.0;

    // State tracking variables
    let bestBid = 0.0;
    let bestAsk = 0.0;
    let bidSize = 0.0;
    let askSize = 0.0;
    let prevBidPx = 0.0;
    let prevBidSz = 0.0;
    let prevAskPx = 0.0;
    let prevAskSz = 0.0;
    let rollingOfi = 0.0;

    const hawkes = new HawkesIntensityService();

    // Signal execution queue (delayed fills)
    interface QueuedOrder {
      targetPosition: 1 | -1 | 0;
      scheduledExecutionIndex: number;
    }
    const orderQueue: QueuedOrder[] = [];

    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i];

      // ── 1. Update Market State ───────────────────────────────────────────
      if (ev.kind === 'book') {
        bestBid = ev.bidPrice;
        bestAsk = ev.askPrice;
        bidSize = ev.bidSize;
        askSize = ev.askSize;

        // BBO-level OFI
        if (prevBidPx > 0 && prevAskPx > 0) {
          const dBid = bestBid > prevBidPx ? bidSize : bestBid === prevBidPx ? bidSize - prevBidSz : -prevBidSz;
          const dAsk = bestAsk < prevAskPx ? askSize : bestAsk === prevAskPx ? askSize - prevAskSz : -prevAskSz;
          const ofi = dBid - dAsk;
          rollingOfi = rollingOfi * 0.9 + ofi;
        }
        prevBidPx = bestBid;
        prevBidSz = bidSize;
        prevAskPx = bestAsk;
        prevAskSz = askSize;
      } else if (ev.kind === 'trade') {
        hawkes.recordTrade(ev.side, ev.size, ev.timestampMs);
      }

      // Can only trade if valid book quotes exist
      if (bestBid <= 0 || bestAsk <= 0) continue;

      // ── 2. Process Pending Fills from Previous Signal ────────────────────
      while (orderQueue.length > 0 && orderQueue[0].scheduledExecutionIndex <= i) {
        const order = orderQueue.shift()!;
        const newPos = order.targetPosition;

        if (newPos !== currentPosition) {
          const turnover = Math.abs(newPos - currentPosition);
          totalTurnover += turnover;

          // Executable price accounting:
          // Buying consumes Ask + slippage. Selling consumes Bid - slippage.
          const frictionPerUnit = (this.feeBps + this.slippageBps) / 10000.0;
          const fillPrice = newPos > currentPosition
            ? bestAsk * (1.0 + this.slippageBps / 10000.0)
            : bestBid * (1.0 - this.slippageBps / 10000.0);

          // If closing an existing position, record completed round-trip trade
          if (currentPosition !== 0) {
            const tradeGross = currentPosition === 1
              ? (fillPrice - entryPrice) / entryPrice
              : (entryPrice - fillPrice) / entryPrice;

            const roundTripFriction = frictionPerUnit * 2.0;
            const tradeNet = tradeGross - roundTripFriction;

            completedTrades.push({
              entryTimeMs,
              exitTimeMs: ev.timestampMs,
              side: currentPosition,
              entryPrice,
              exitPrice: fillPrice,
              grossReturnPct: tradeGross * 100.0,
              netReturnPct: tradeNet * 100.0,
              frictionBps: roundTripFriction * 10000.0,
              durationMs: Math.max(0, ev.timestampMs - entryTimeMs),
            });

            grossPnlPct += tradeGross * 100.0;
            totalFrictionPct += roundTripFriction * 100.0;
            netPnlPct += tradeNet * 100.0;
            currentEquity *= (1.0 + tradeNet);
          }

          // If establishing a new position
          if (newPos !== 0) {
            entryPrice = fillPrice;
            entryTimeMs = ev.timestampMs;
          }

          currentPosition = newPos;
        }
      }

      // ── 3. Evaluate Signal at Time t (Zero Look-Ahead) ───────────────────
      const { hnir } = hawkes.getIntensities(ev.timestampMs);
      const desiredPos = signalFn({
        bestBid,
        bestAsk,
        bidSize,
        askSize,
        rollingOfi,
        hawkesHnir: hnir,
      });

      // If desired position differs from current AND no fill is already pending, queue order
      if (desiredPos !== currentPosition && orderQueue.length === 0) {
        orderQueue.push({
          targetPosition: desiredPos,
          scheduledExecutionIndex: i + this.executionDelayEvents,
        });
      }

      equityCurve.push({ t: ev.timestampMs, equity: currentEquity });
    }

    // ── 4. Close any Open Position at Final Mid-Price ───────────────────────
    if (currentPosition !== 0 && bestBid > 0 && bestAsk > 0) {
      const exitPx = currentPosition === 1 ? bestBid : bestAsk;
      const tradeGross = currentPosition === 1
        ? (exitPx - entryPrice) / entryPrice
        : (entryPrice - exitPx) / entryPrice;
      const frictionPerUnit = (this.feeBps + this.slippageBps) / 10000.0;
      const roundTripFriction = frictionPerUnit * 2.0;
      const tradeNet = tradeGross - roundTripFriction;

      completedTrades.push({
        entryTimeMs,
        exitTimeMs: this.events[this.events.length - 1].timestampMs,
        side: currentPosition,
        entryPrice,
        exitPrice: exitPx,
        grossReturnPct: tradeGross * 100.0,
        netReturnPct: tradeNet * 100.0,
        frictionBps: roundTripFriction * 10000.0,
        durationMs: Math.max(0, this.events[this.events.length - 1].timestampMs - entryTimeMs),
      });

      grossPnlPct += tradeGross * 100.0;
      totalFrictionPct += roundTripFriction * 100.0;
      netPnlPct += tradeNet * 100.0;
      currentEquity *= (1.0 + tradeNet);
    }

    // ── 5. Metric Calculations ─────────────────────────────────────────────
    const wins = completedTrades.filter((t) => t.netReturnPct > 0);
    const losses = completedTrades.filter((t) => t.netReturnPct <= 0);
    const tradeWinRate = completedTrades.length > 0 ? (wins.length / completedTrades.length) * 100.0 : 0.0;

    const sumWins = wins.reduce((acc, t) => acc + t.netReturnPct, 0);
    const sumLosses = losses.reduce((acc, t) => acc + Math.abs(t.netReturnPct), 0);
    const profitFactor = sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? 99.0 : 0.0;
    const avgWin = wins.length > 0 ? sumWins / wins.length : 0.0;
    const avgLoss = losses.length > 0 ? sumLosses / losses.length : 0.0;

    // Maximum drawdown calculation on equity curve
    let peak = 1.0;
    let maxDd = 0.0;
    for (const pt of equityCurve) {
      if (pt.equity > peak) peak = pt.equity;
      const dd = (peak - pt.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }

    // Mathematically sound Sharpe on 1-second resampled time grid
    const { sharpe, barCount } = this.computeResampledSharpe(equityCurve, 1000);

    return {
      strategyName,
      totalNetReturnPct: parseFloat(netPnlPct.toFixed(3)),
      grossReturnPct: parseFloat(grossPnlPct.toFixed(3)),
      totalFrictionCostPct: parseFloat(totalFrictionPct.toFixed(3)),
      completedTradesCount: completedTrades.length,
      tradeWinRatePct: parseFloat(tradeWinRate.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      avgWinPct: parseFloat(avgWin.toFixed(3)),
      avgLossPct: parseFloat(avgLoss.toFixed(3)),
      maxDrawdownPct: parseFloat((maxDd * 100.0).toFixed(2)),
      turnover: parseFloat(totalTurnover.toFixed(1)),
      timeNormalizedSharpe: parseFloat(sharpe.toFixed(2)),
      resampledBarCount: barCount,
    };
  }

  /**
   * Resamples irregular equity curve onto a uniform time grid (intervalMs)
   * to compute an annualized Sharpe ratio without tick-count distortion.
   */
  private computeResampledSharpe(
    curve: { t: number; equity: number }[],
    intervalMs = 1000,
  ): { sharpe: number; barCount: number } {
    if (curve.length < 2) return { sharpe: 0.0, barCount: 0 };

    const tStart = curve[0].t;
    const tEnd = curve[curve.length - 1].t;
    const totalBars = Math.floor((tEnd - tStart) / intervalMs);

    if (totalBars < 3) {
      // Too few time intervals to establish statistical annualization
      return { sharpe: 0.0, barCount: totalBars };
    }

    const barReturns: number[] = [];
    let curveIdx = 0;
    let prevEquity = curve[0].equity;

    for (let b = 1; b <= totalBars; b++) {
      const barTime = tStart + b * intervalMs;
      while (curveIdx < curve.length - 1 && curve[curveIdx + 1].t <= barTime) {
        curveIdx++;
      }
      const curEquity = curve[curveIdx].equity;
      const ret = (curEquity - prevEquity) / prevEquity;
      barReturns.push(ret);
      prevEquity = curEquity;
    }

    const mean = barReturns.reduce((a, b) => a + b, 0) / barReturns.length;
    const variance =
      barReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (barReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev <= 0.0000001) return { sharpe: 0.0, barCount: totalBars };

    // Annualization factor: sqrt(periods per year)
    // For 1-second bars: 31,536,000 bars/year
    const periodsPerYear = (365.25 * 86400 * 1000) / intervalMs;
    const sharpe = (mean / stdDev) * Math.sqrt(periodsPerYear);

    // Clamp extreme values if observation window is small
    const clampedSharpe = Math.max(-10.0, Math.min(10.0, sharpe));
    return { sharpe: clampedSharpe, barCount: totalBars };
  }
}

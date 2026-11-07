/**
 * ─────────────────────────────────────────────────────────────
 * FurlPay CLI — Quantitative Backtest Engine (2026)
 * ─────────────────────────────────────────────────────────────
 * High-performance microstructure backtesting engine comparing:
 *   1. Naive Micro-Price Momentum
 *   2. Top-5 Depth Imbalance
 *   3. Cont-Kukanov-Stoikov Event OFI (2014)
 *   4. FurlPay Hawkes-Hybrid (2026 Raffaelli point process)
 *
 * Accounts for maker/taker fees, bid/ask spread, and latency slippage.
 */

import { HawkesIntensityService } from './hawkes.js';

export interface BacktestTick {
  timestampMs: number;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  tradeSide?: 'BUY' | 'SELL';
  tradeSize?: number;
}

export interface StrategyResult {
  name: string;
  totalReturnPct: number;
  annualizedSharpe: number;
  maxDrawdownPct: number;
  winRatePct: number;
  profitFactor: number;
  tradeCount: number;
}

export interface BacktestReport {
  asset: string;
  totalTicks: number;
  durationSeconds: number;
  strategies: StrategyResult[];
}

export class QuantitativeBacktestEngine {
  private ticks: BacktestTick[];
  private readonly feeRateBps = 1.0; // 0.01% maker/taker fee
  private readonly slippageBps = 0.5; // 0.005% execution slippage

  constructor(ticks: BacktestTick[]) {
    this.ticks = ticks;
  }

  /**
   * Run backtest across all four quantitative models.
   */
  public runBacktest(asset = 'BTC'): BacktestReport {
    if (this.ticks.length < 5) {
      throw new Error('Insufficient ticks for backtest (minimum 5 required)');
    }

    const durationSeconds =
      (this.ticks[this.ticks.length - 1].timestampMs - this.ticks[0].timestampMs) / 1000.0;

    const resNaive = this.simulateNaiveMomentum();
    const resImbalance = this.simulateTop5Imbalance();
    const resOFI = this.simulateContOFI();
    const resHawkesHybrid = this.simulateHawkesHybrid();

    return {
      asset,
      totalTicks: this.ticks.length,
      durationSeconds: Math.max(1.0, durationSeconds),
      strategies: [resNaive, resImbalance, resOFI, resHawkesHybrid],
    };
  }

  // ── Strategy 1: Naive Micro-Price Momentum ────────────────────────────────
  private simulateNaiveMomentum(): StrategyResult {
    let pnl = 0.0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0.0;
    let grossLoss = 0.0;
    let peak = 0.0;
    let maxDd = 0.0;
    const pnlSeries: number[] = [];

    for (let i = 1; i < this.ticks.length; i++) {
      const prev = this.ticks[i - 1];
      const curr = this.ticks[i];
      const prevMid = (prev.bidPrice + prev.askPrice) / 2.0;
      const currMid = (curr.bidPrice + curr.askPrice) / 2.0;

      // Micro-price calculation
      const micro =
        (prev.bidPrice * prev.askSize + prev.askPrice * prev.bidSize) /
        (prev.bidSize + prev.askSize);
      const signal = micro > prevMid ? 1 : -1;

      const rawReturn = ((currMid - prevMid) / prevMid) * signal;
      const netReturn = rawReturn - ((this.feeRateBps + this.slippageBps) / 10000.0);

      pnl += netReturn;
      pnlSeries.push(netReturn);

      if (netReturn > 0) {
        wins++;
        grossWin += netReturn;
      } else {
        losses++;
        grossLoss += Math.abs(netReturn);
      }

      if (pnl > peak) peak = pnl;
      const dd = peak - pnl;
      if (dd > maxDd) maxDd = dd;
    }

    return this.calculateMetrics('Naive Micro-Price Momentum', pnlSeries, wins, losses, grossWin, grossLoss, maxDd);
  }

  // ── Strategy 2: Depth Imbalance ───────────────────────────────────────────
  private simulateTop5Imbalance(): StrategyResult {
    let pnl = 0.0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0.0;
    let grossLoss = 0.0;
    let peak = 0.0;
    let maxDd = 0.0;
    const pnlSeries: number[] = [];

    for (let i = 1; i < this.ticks.length; i++) {
      const prev = this.ticks[i - 1];
      const curr = this.ticks[i];
      const prevMid = (prev.bidPrice + prev.askPrice) / 2.0;
      const currMid = (curr.bidPrice + curr.askPrice) / 2.0;

      const imbalance = (prev.bidSize - prev.askSize) / (prev.bidSize + prev.askSize);
      const signal = imbalance > 0.1 ? 1 : imbalance < -0.1 ? -1 : 0;

      const rawReturn = ((currMid - prevMid) / prevMid) * signal;
      const friction = signal !== 0 ? (this.feeRateBps + this.slippageBps) / 10000.0 : 0.0;
      const netReturn = rawReturn - friction;

      pnl += netReturn;
      pnlSeries.push(netReturn);

      if (signal !== 0) {
        if (netReturn > 0) {
          wins++;
          grossWin += netReturn;
        } else {
          losses++;
          grossLoss += Math.abs(netReturn);
        }
      }

      if (pnl > peak) peak = pnl;
      const dd = peak - pnl;
      if (dd > maxDd) maxDd = dd;
    }

    return this.calculateMetrics('Top-5 Depth Imbalance', pnlSeries, wins, losses, grossWin, grossLoss, maxDd);
  }

  // ── Strategy 3: Cont, Kukanov & Stoikov Event OFI ─────────────────────────
  private simulateContOFI(): StrategyResult {
    let pnl = 0.0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0.0;
    let grossLoss = 0.0;
    let peak = 0.0;
    let maxDd = 0.0;
    const pnlSeries: number[] = [];

    for (let i = 1; i < this.ticks.length; i++) {
      const prev = this.ticks[i - 1];
      const curr = this.ticks[i];
      const prevMid = (prev.bidPrice + prev.askPrice) / 2.0;
      const currMid = (curr.bidPrice + curr.askPrice) / 2.0;

      // Event OFI formulation
      let deltaBid = 0;
      if (curr.bidPrice > prev.bidPrice) deltaBid = curr.bidSize;
      else if (curr.bidPrice === prev.bidPrice) deltaBid = curr.bidSize - prev.bidSize;
      else deltaBid = -prev.bidSize;

      let deltaAsk = 0;
      if (curr.askPrice < prev.askPrice) deltaAsk = curr.askSize;
      else if (curr.askPrice === prev.askPrice) deltaAsk = curr.askSize - prev.askSize;
      else deltaAsk = -prev.askSize;

      const ofi = deltaBid - deltaAsk;
      const signal = ofi > 0 ? 1 : ofi < 0 ? -1 : 0;

      const rawReturn = ((currMid - prevMid) / prevMid) * signal;
      const friction = signal !== 0 ? (this.feeRateBps + this.slippageBps) / 10000.0 : 0.0;
      const netReturn = rawReturn - friction;

      pnl += netReturn;
      pnlSeries.push(netReturn);

      if (signal !== 0) {
        if (netReturn > 0) {
          wins++;
          grossWin += netReturn;
        } else {
          losses++;
          grossLoss += Math.abs(netReturn);
        }
      }

      if (pnl > peak) peak = pnl;
      const dd = peak - pnl;
      if (dd > maxDd) maxDd = dd;
    }

    return this.calculateMetrics('Cont-Kukanov-Stoikov Event OFI (2014)', pnlSeries, wins, losses, grossWin, grossLoss, maxDd);
  }

  // ── Strategy 4: FurlPay Hawkes Hybrid ────────────────────────────────────
  private simulateHawkesHybrid(): StrategyResult {
    let pnl = 0.0;
    let wins = 0;
    let losses = 0;
    let grossWin = 0.0;
    let grossLoss = 0.0;
    let peak = 0.0;
    let maxDd = 0.0;
    const pnlSeries: number[] = [];
    const hawkes = new HawkesIntensityService();

    let cumulativeOFI = 0.0;

    for (let i = 1; i < this.ticks.length; i++) {
      const prev = this.ticks[i - 1];
      const curr = this.ticks[i];
      const prevMid = (prev.bidPrice + prev.askPrice) / 2.0;
      const currMid = (curr.bidPrice + curr.askPrice) / 2.0;

      if (curr.tradeSide) {
        hawkes.recordTrade(curr.tradeSide, curr.timestampMs);
      }
      const { hnir } = hawkes.getIntensities(curr.timestampMs);

      // OFI
      const deltaBid = curr.bidPrice >= prev.bidPrice ? curr.bidSize : -prev.bidSize;
      const deltaAsk = curr.askPrice <= prev.askPrice ? curr.askSize : -prev.askSize;
      cumulativeOFI = cumulativeOFI * 0.95 + (deltaBid - deltaAsk);

      // Multi-factor alpha: Combine Hawkes Point Process with OFI filter
      let signal = 0;
      if (hnir > 0.15 && cumulativeOFI > 0) signal = 1;
      else if (hnir < -0.15 && cumulativeOFI < 0) signal = -1;

      const rawReturn = ((currMid - prevMid) / prevMid) * signal;
      const friction = signal !== 0 ? (this.feeRateBps + this.slippageBps) / 10000.0 : 0.0;
      const netReturn = rawReturn - friction;

      pnl += netReturn;
      pnlSeries.push(netReturn);

      if (signal !== 0) {
        if (netReturn > 0) {
          wins++;
          grossWin += netReturn;
        } else {
          losses++;
          grossLoss += Math.abs(netReturn);
        }
      }

      if (pnl > peak) peak = pnl;
      const dd = peak - pnl;
      if (dd > maxDd) maxDd = dd;
    }

    return this.calculateMetrics('FurlPay Hawkes-OFI Hybrid (2026)', pnlSeries, wins, losses, grossWin, grossLoss, maxDd);
  }

  // ── Metrics Calculation Helper ───────────────────────────────────────────
  private calculateMetrics(
    name: string,
    returns: number[],
    wins: number,
    losses: number,
    grossWin: number,
    grossLoss: number,
    maxDd: number,
  ): StrategyResult {
    const totalReturnPct = returns.reduce((acc, r) => acc + r, 0) * 100.0;
    const trades = wins + losses;
    const winRatePct = trades > 0 ? (wins / trades) * 100.0 : 0.0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99.0 : 0.0;

    // Annualized Sharpe Ratio calculation (assume high-frequency 1-second ticks)
    let sharpe = 0.0;
    if (returns.length > 2) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance =
        returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
      const stdDev = Math.sqrt(variance);
      // Annualize over 31.5 million seconds/year
      if (stdDev > 0) {
        sharpe = (mean / stdDev) * Math.sqrt(31_536_000);
      }
    }

    return {
      name,
      totalReturnPct: parseFloat(totalReturnPct.toFixed(3)),
      annualizedSharpe: parseFloat(sharpe.toFixed(2)),
      maxDrawdownPct: parseFloat((maxDd * 100.0).toFixed(3)),
      winRatePct: parseFloat(winRatePct.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      tradeCount: trades,
    };
  }
}

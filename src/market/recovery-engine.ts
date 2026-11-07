/**
 * FurlPay Market Data Recovery Engine (2026)
 * 
 * Manages post-disconnect synchronization, L2 book reconstruction,
 * crossed-book validation, and timed-out order recovery across WebSocket reconnects.
 */

import { OrderBookLevel } from "./types";

export type MarketHealthState = "HEALTHY" | "DISCONNECTED" | "RECOVERING" | "DEGRADED";

export interface ReconstructedBook {
  coin: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  midPx: number;
  spreadBps: number;
  recoveredAt: number;
}

export class MarketDataRecoveryEngine {
  private healthState: MarketHealthState = "HEALTHY";
  private lastRecoveryTime: number = 0;

  public getHealthState(): MarketHealthState {
    return this.healthState;
  }

  public notifyDisconnect(): void {
    this.healthState = "DISCONNECTED";
  }

  /**
   * Reconstructs order book from an authoritative REST snapshot following a socket disconnect.
   */
  public async recoverOrderBook(
    coin: string,
    fetchSnapshot: (coin: string) => Promise<{ levels: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>] }>
  ): Promise<ReconstructedBook> {
    this.healthState = "RECOVERING";

    try {
      const raw = await fetchSnapshot(coin);
      const bids: OrderBookLevel[] = (raw.levels[0] || []).map((l) => ({
        price: parseFloat(l.px),
        size: parseFloat(l.sz),
      }));
      const asks: OrderBookLevel[] = (raw.levels[1] || []).map((l) => ({
        price: parseFloat(l.px),
        size: parseFloat(l.sz),
      }));

      // Crossed Book Invariant Check
      if (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) {
        this.healthState = "DEGRADED";
        throw new Error(`CROSSED_BOOK_ON_RECOVERY: Best bid (${bids[0].price}) >= Best ask (${asks[0].price})`);
      }

      const bestBid = bids.length > 0 ? bids[0].price : 0;
      const bestAsk = asks.length > 0 ? asks[0].price : 0;
      const midPx = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2.0 : bestBid || bestAsk;
      const spreadBps = bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / midPx) * 10_000 : 0;

      this.healthState = "HEALTHY";
      this.lastRecoveryTime = Date.now();

      return {
        coin,
        bids,
        asks,
        midPx,
        spreadBps: Number(spreadBps.toFixed(2)),
        recoveredAt: this.lastRecoveryTime,
      };
    } catch (e: any) {
      this.healthState = "DEGRADED";
      throw e;
    }
  }

  /**
   * Resolves in-flight timed-out orders after network failure against live exchange open orders.
   */
  public resolveTimedOutOrders(
    pendingCloids: string[],
    exchangeOpenOrders: Array<{ cloid?: string; oid: number; coin: string; limitPx: string; sz: string }>
  ): {
    confirmedResting: Array<{ cloid: string; oid: number }>;
    presumedFilledOrCancelled: string[];
  } {
    const exchangeMap = new Map<string, number>();
    for (const o of exchangeOpenOrders) {
      if (o.cloid) {
        exchangeMap.set(o.cloid.toLowerCase(), o.oid);
      }
    }

    const confirmedResting: Array<{ cloid: string; oid: number }> = [];
    const presumedFilledOrCancelled: string[] = [];

    for (const cloid of pendingCloids) {
      const oid = exchangeMap.get(cloid.toLowerCase());
      if (oid !== undefined) {
        confirmedResting.push({ cloid, oid });
      } else {
        presumedFilledOrCancelled.push(cloid);
      }
    }

    return { confirmedResting, presumedFilledOrCancelled };
  }
}

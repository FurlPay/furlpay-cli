// ─────────────────────────────────────────────────────────────
//  FurlPay CLI — Market Data Service (Hyperliquid L1)
// ─────────────────────────────────────────────────────────────

import WebSocket from 'ws';
import type {
  OrderBookLevel,
  OrderBookSnapshot,
  MicrostructureMetrics,
} from '../types/index.js';
import { SUPPORTED_NETWORKS } from '../utils/constants.js';
import * as logger from '../utils/logger.js';

const HL_NETWORK_ID = 'hyperliquid:999';

function getHyperliquidConfig() {
  const cfg = SUPPORTED_NETWORKS.get(HL_NETWORK_ID);
  if (!cfg) throw new Error(`Network ${HL_NETWORK_ID} not found in SUPPORTED_NETWORKS`);
  return cfg;
}

/**
 * Service for consuming Hyperliquid L1 market data via REST and WebSocket.
 */
export class MarketDataService {
  private readonly restUrl: string;
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly baseReconnectDelayMs = 500;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const cfg = getHyperliquidConfig();
    this.restUrl = `${cfg.rpcUrl}/info`;
    this.wsUrl = cfg.wsUrl!;
  }

  // ── REST helpers ─────────────────────────────────────────

  /**
   * Fetch the L2 order book for a given coin via REST.
   *
   * @param coin  Ticker symbol (e.g. "BTC")
   * @param depth Number of price levels to return (default: all)
   */
  async getOrderBook(coin: string, depth?: number): Promise<OrderBookSnapshot> {
    const body = JSON.stringify({ type: 'l2Book', coin });

    const res = await fetch(this.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!res.ok) {
      throw new Error(`Hyperliquid REST error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
    };

    const parseLevels = (
      raw: Array<{ px: string; sz: string; n: number }>,
    ): OrderBookLevel[] =>
      raw.map((l) => ({
        price: parseFloat(l.px),
        size: parseFloat(l.sz),
        numOrders: l.n,
      }));

    let bids = parseLevels(data.levels[0]);
    let asks = parseLevels(data.levels[1]);

    if (depth !== undefined && depth > 0) {
      bids = bids.slice(0, depth);
      asks = asks.slice(0, depth);
    }

    const now = Date.now();
    return {
      coin,
      timestamp: now,
      time: now,
      bids,
      asks,
    };
  }

  /**
   * Compute microstructure metrics from an order book snapshot.
   */
  calculateMicrostructure(snapshot: OrderBookSnapshot): MicrostructureMetrics {
    if (snapshot.bids.length === 0 || snapshot.asks.length === 0) {
      throw new Error('Cannot compute microstructure from empty order book');
    }

    const bestBid = snapshot.bids[0].price;
    const bestAsk = snapshot.asks[0].price;
    const bidVol = snapshot.bids[0].size;
    const askVol = snapshot.asks[0].size;

    const midPrice = (bestBid + bestAsk) / 2;
    const microPrice = (bestBid * askVol + bestAsk * bidVol) / (bidVol + askVol);
    const spreadBps = ((bestAsk - bestBid) / midPrice) * 10_000;

    // Top-5 levels for OFI and imbalance
    const top5Bids = snapshot.bids.slice(0, 5);
    const top5Asks = snapshot.asks.slice(0, 5);
    const sumBidVol = top5Bids.reduce((acc, l) => acc + l.size, 0);
    const sumAskVol = top5Asks.reduce((acc, l) => acc + l.size, 0);

    const ofi = sumBidVol - sumAskVol;
    const imbalanceRatio =
      sumBidVol + sumAskVol === 0
        ? 0
        : (sumBidVol - sumAskVol) / (sumBidVol + sumAskVol);

    return {
      midPrice,
      microPrice,
      spreadBps,
      ofi,
      topBidVolume: bidVol,
      topAskVolume: askVol,
      imbalanceRatio,
    };
  }

  // ── WebSocket streaming ──────────────────────────────────

  /**
   * Open a WebSocket subscription to the L2 order book for a coin.
   * Calls `onUpdate` with each incremental snapshot.
   */
  streamOrderBook(
    coin: string,
    onUpdate: (snapshot: OrderBookSnapshot) => void,
  ): void {
    this.shouldReconnect = true;
    this.connectWebSocket(coin, onUpdate);
  }

  private connectWebSocket(
    coin: string,
    onUpdate: (snapshot: OrderBookSnapshot) => void,
  ): void {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // ignore cleanup errors
      }
    }

    logger.debug(`Connecting to Hyperliquid WebSocket: ${this.wsUrl}`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      logger.debug('Hyperliquid WebSocket connected');
      this.reconnectAttempts = 0;

      const subMsg = JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'l2Book', coin },
      });
      this.ws?.send(subMsg);
      logger.debug(`Subscribed to l2Book for ${coin}`);
    });

    this.ws.on('message', (rawData: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          channel?: string;
          data?: {
            coin: string;
            time: number;
            levels: [
              Array<{ px: string; sz: string; n: number }>,
              Array<{ px: string; sz: string; n: number }>,
            ];
          };
        };

        if (msg.channel === 'l2Book' && msg.data) {
          const { data } = msg;
          const snapshot: OrderBookSnapshot = {
            coin: data.coin,
            timestamp: data.time,
            time: data.time,
            bids: data.levels[0].map((l) => ({
              price: parseFloat(l.px),
              size: parseFloat(l.sz),
              numOrders: l.n,
            })),
            asks: data.levels[1].map((l) => ({
              price: parseFloat(l.px),
              size: parseFloat(l.sz),
              numOrders: l.n,
            })),
          };

          onUpdate(snapshot);
        }
      } catch (err) {
        logger.debug(`Error parsing WebSocket message: ${(err as Error).message}`);
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.debug(`WebSocket error: ${err.message}`);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.debug(`WebSocket closed (${code}): ${reason.toString()}`);
      if (this.shouldReconnect) {
        this.scheduleReconnect(coin, onUpdate);
      }
    });
  }

  private scheduleReconnect(
    coin: string,
    onUpdate: (snapshot: OrderBookSnapshot) => void,
  ): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('Max WebSocket reconnect attempts reached. Giving up.');
      return;
    }

    const delay = this.baseReconnectDelayMs * 2 ** this.reconnectAttempts;
    this.reconnectAttempts++;
    logger.debug(`Reconnecting in ${delay} ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connectWebSocket(coin, onUpdate);
    }, delay);
  }

  /**
   * Fetch exchange metadata (active assets, universe, oracle prices).
   */
  async getMeta(): Promise<unknown> {
    const res = await fetch(this.restUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    });

    if (!res.ok) {
      throw new Error(`Hyperliquid meta error ${res.status}: ${await res.text()}`);
    }

    return res.json();
  }

  /**
   * Gracefully close any active WebSocket connection.
   */
  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    logger.debug('MarketDataService closed');
  }
}

// ── Standalone helper functions ───────────────────────────────

export async function fetchOrderBook(coin: string, depth = 10) {
  const service = new MarketDataService();
  const snapshot = await service.getOrderBook(coin, depth);
  const metrics = service.calculateMicrostructure(snapshot);
  return {
    bids: snapshot.bids,
    asks: snapshot.asks,
    metrics,
    snapshot,
  };
}

export async function streamOrderBook(
  coin: string,
  depth = 10,
  onUpdate: (data: { bids: OrderBookLevel[]; asks: OrderBookLevel[]; metrics: MicrostructureMetrics }) => boolean | void,
): Promise<void> {
  const service = new MarketDataService();

  return new Promise((resolve, reject) => {
    let running = true;
    service.streamOrderBook(coin, (snapshot) => {
      if (!running) return;
      try {
        const bids = depth > 0 ? snapshot.bids.slice(0, depth) : snapshot.bids;
        const asks = depth > 0 ? snapshot.asks.slice(0, depth) : snapshot.asks;
        const metrics = service.calculateMicrostructure(snapshot);
        const shouldContinue = onUpdate({ bids, asks, metrics });
        if (shouldContinue === false) {
          running = false;
          service.close();
          resolve();
        }
      } catch (e) {
        // ignore occasional parse error
      }
    });

    // Fallback polling if WS is slow to connect
    const interval = setInterval(async () => {
      if (!running) {
        clearInterval(interval);
        return;
      }
      try {
        const snapshot = await service.getOrderBook(coin, depth);
        const metrics = service.calculateMicrostructure(snapshot);
        const shouldContinue = onUpdate({ bids: snapshot.bids, asks: snapshot.asks, metrics });
        if (shouldContinue === false) {
          running = false;
          clearInterval(interval);
          service.close();
          resolve();
        }
      } catch {}
    }, 1000);
  });
}

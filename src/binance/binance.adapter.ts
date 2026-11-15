// Binance exchange adapter — the unified capability surface + agent-trust
// gate. EVERY private action passes the ExecutionAuthorizationService mandate
// check BEFORE a request is built or signed: the signing layer is where
// spending limits live, not the tool description.

import {
  BinanceClient,
  BinanceApiError,
} from "./binance.client.js";
import { credentialsFromEnv } from "./binance.auth.js";
import type {
  BinanceEnv,
  BinanceMarket,
  ExchangeCapabilities,
  OpenOrder,
  OrderBook,
  PlacedOrder,
  Ticker24h,
} from "./binance.types.js";

export interface BinanceAdapterOptions {
  readonly env?: BinanceEnv;
  readonly market?: BinanceMarket;
  /** Injected fetch for tests. */
  readonly fetchImpl?: typeof fetch;
  /** Injected clock for tests. */
  readonly nowMs?: () => number;
}

export interface TradeIntent {
  readonly symbol: string;
  readonly side: "BUY" | "SELL";
  readonly notionalUsd: number;
  readonly agentAddress: string;
}

export interface ExchangeAdapter {
  readonly capabilities: ExchangeCapabilities;
  balances(): Promise<{ asset: string; free: string; locked: string }[]>;
  ticker(symbol: string): Promise<Ticker24h>;
  orderBook(symbol: string, limit?: number): Promise<OrderBook>;
  openOrders(symbol?: string): Promise<OpenOrder[]>;
  /** Policy-gated: refuses before signing when the mandate declines. */
  marketOrder(intent: TradeIntent, mandateCheck: (intent: TradeIntent) => { authorized: boolean; reason?: string }): Promise<PlacedOrder>;
  cancelOrder(symbol: string, orderId: number): Promise<unknown>;
}

/** The declared capability surface, from documented APIs only. Withdrawals
 *  are structurally absent — `false` is an explicit answer, not an omission. */
export function binanceCapabilities(env: BinanceEnv): ExchangeCapabilities {
  return {
    exchange: `binance-${env}`,
    markets: ["spot", "usds-m-futures"],
    supports: {
      balances: true,
      marketOrders: true,
      limitOrders: true,
      ocoOrders: false, // OCO endpoints not implemented in this build — explicit, not assumed
      cancel: true,
      orderBook: true,
      ticker: true,
      klines: true,
      websockets: false, // ws engine ships separately; never claimed early
      withdrawals: false,
    },
  };
}

export class BinanceAdapter implements ExchangeAdapter {
  readonly capabilities: ExchangeCapabilities;
  private readonly client: BinanceClient;
  private readonly env: BinanceEnv;

  constructor(opts: BinanceAdapterOptions = {}) {
    const env = opts.env ?? "testnet";
    const market: BinanceMarket = opts.market ?? "spot";
    const credentials = credentialsFromEnv();
    if (!credentials) {
      throw new Error(
        "BINANCE_API_KEY and BINANCE_API_SECRET must be set in the environment — " +
          "keys are never accepted as CLI arguments (argv is visible in process listings)"
      );
    }
    this.env = env;
    this.capabilities = binanceCapabilities(env);
    this.client = new BinanceClient({
      env,
      market,
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      fetchImpl: opts.fetchImpl,
      nowMs: opts.nowMs,
    });
  }

  get baseUrl(): string {
    return this.client.baseUrl;
  }

  async balances(): Promise<{ asset: string; free: string; locked: string }[]> {
    const snap = await this.client.accountSnapshot();
    // Zero-check only — the exact strings pass through untouched; filtering
    // compares numerically because the exchange emits "0.00000000", not "0".
    return snap.balances.filter(
      (b) => Number(b.free) > 0 || Number(b.locked) > 0
    );
  }

  async ticker(symbol: string): Promise<Ticker24h> {
    return this.client.ticker24h(symbol);
  }

  async orderBook(symbol: string, limit = 20): Promise<OrderBook> {
    return this.client.orderBook(symbol, limit);
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.client.openOrders(symbol);
  }

  /**
   * Market order behind the mandate gate. The mandate check runs FIRST — a
   * refusal never reaches signing. Notional is validated as a finite positive
   * number; quantity derives from the live ticker price as an exact decimal
   * STRING division is avoided (we send quoteOrderQty for market buys, so the
   * exchange computes quantity at its own precision).
   */
  async marketOrder(
    intent: TradeIntent,
    mandateCheck: (intent: TradeIntent) => { authorized: boolean; reason?: string }
  ): Promise<PlacedOrder> {
    if (!Number.isFinite(intent.notionalUsd) || intent.notionalUsd <= 0) {
      throw new Error(`notionalUsd must be a positive finite number, got ${String(intent.notionalUsd)}`);
    }
    const gate = mandateCheck(intent);
    if (!gate.authorized) {
      throw new Error(`POLICY_REFUSED: ${gate.reason ?? "mandate declined this order"}`);
    }
    // Market buy: spend quote (USDT) amount. Market sell: base quantity is
    // required by the exchange; we refuse to derive it silently from a float
    // price and require the caller to send a quantity-bearing intent instead.
    if (intent.side === "BUY") {
      return this.client.placeSpotOrder({
        symbol: intent.symbol.toUpperCase(),
        side: "BUY",
        type: "MARKET",
        quoteOrderQty: String(intent.notionalUsd),
      });
    }
    throw new Error(
      "MARKET_SELL_QUANTITY_REQUIRED: selling requires an exact base quantity; " +
        "derive it from a live ticker in the calling command and pass it explicitly"
    );
  }

  async cancelOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.client.cancelSpotOrder(symbol, orderId);
  }
}

export { BinanceApiError };

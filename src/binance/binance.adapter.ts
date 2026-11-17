// Binance exchange adapter — the unified capability surface + agent-trust
// gate. EVERY private action passes the ExecutionAuthorizationService mandate
// check BEFORE a request is built or signed: the signing layer is where
// spending limits live, not the tool description.

import {
  BinanceClient,
  BinanceApiError,
} from "./binance.client.js";
import { credentialsFromEnv } from "./binance.auth.js";
import { DecimalMath } from "../precision/decimal-math.js";
import { assertLiveAllowed } from "../capabilities/registry.js";
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
  /** Durable audit blotter (external audit M-02): order intents and
   *  outcomes land in the hash-chained ledger when provided. Best-effort —
   *  an audit-write failure never blocks the trade path. */
  readonly blotter?: { appendEvent(t: any, payload: any): unknown };
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
  private readonly blotter?: { appendEvent(t: any, payload: any): unknown };
  private blotterWriteFailures = 0;
  private note(type: string, payload: Record<string, unknown>): void {
    if (!this.blotter) return;
    try {
      this.blotter.appendEvent(type, payload);
    } catch {
      this.blotterWriteFailures += 1; // visible on the instance, never silent
    }
  }

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
    this.blotter = opts.blotter;
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
    this.note("AUTHORIZATION_GRANTED", {
      symbol: intent.symbol, side: intent.side, notionalUsd: intent.notionalUsd,
      authorized: gate.authorized, reason: gate.authorized ? undefined : gate.reason,
      agentAddress: intent.agentAddress,
    });
    if (!gate.authorized) {
      throw new Error(`POLICY_REFUSED: ${gate.reason ?? "mandate declined this order"}`);
    }
    // Capability registry live gate (readiness P1): a refused or unopted
    // build never signs an exchange order — the gate fires before any HTTP
    // request is built.
    assertLiveAllowed("binance.spot");
    // Market buy: spend quote (USDT) amount. Market sell: base quantity is
    // required by the exchange; we refuse to derive it silently from a float
    // price and require the caller to send a quantity-bearing intent instead.
    if (intent.side === "BUY") {
      const placed = await this.client.placeSpotOrder({
        symbol: intent.symbol.toUpperCase(),
        side: "BUY",
        type: "MARKET",
        quoteOrderQty: String(intent.notionalUsd),
      });
      this.note("ORDER_SUBMITTED", {
        venue: "BINANCE", env: this.env, symbol: intent.symbol, side: "BUY",
        notionalUsd: intent.notionalUsd, orderId: placed.orderId, status: placed.status,
      });
      return placed;
    }
    throw new Error(
      "MARKET_SELL_QUANTITY_REQUIRED: selling requires an exact base quantity; " +
        "derive it from a live ticker in the calling command and pass it explicitly"
    );
  }

  async cancelOrder(symbol: string, orderId: number): Promise<unknown> {
    const res = await this.client.cancelSpotOrder(symbol, orderId);
    this.note("ORDER_CANCELLED", { venue: "BINANCE", env: this.env, symbol, orderId });
    return res;
  }

  /**
   * Market sell with an explicit base quantity. The gate runs on the
   * price-derived notional BEFORE signing — a refused order never builds a
   * request, same as marketOrder.
   */
  async marketSell(
    symbol: string,
    quantity: string,
    mandateCheck: (intent: TradeIntent) => { authorized: boolean; reason?: string }
  ): Promise<PlacedOrder> {
    const qtyNum = Number(quantity);
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      throw new Error(`quantity must be a positive finite number, got ${String(quantity)}`);
    }
    const ticker = await this.client.ticker24h(symbol.toUpperCase());
    // Exact notional for the mandate gate (scaled-BigInt, no float product).
    const notionalUsd = Number(
      DecimalMath.mulMinor(
        DecimalMath.parseUnits(quantity, 6),
        DecimalMath.parseUnits(ticker.lastPrice || "0", 6)
      )
    ) / 1e6;
    const intent: TradeIntent = {
      symbol: symbol.toUpperCase(),
      side: "SELL",
      notionalUsd,
      agentAddress: "cli",
    };
    const gate = mandateCheck(intent);
    this.note("AUTHORIZATION_GRANTED", {
      symbol: intent.symbol, side: "SELL", notionalUsd: intent.notionalUsd,
      authorized: gate.authorized, reason: gate.authorized ? undefined : gate.reason,
    });
    if (!gate.authorized) {
      throw new Error(`POLICY_REFUSED: ${gate.reason ?? "mandate declined this order"}`);
    }
    const placed = await this.client.placeSpotOrder({
      symbol: symbol.toUpperCase(),
      side: "SELL",
      type: "MARKET",
      quantity,
    });
    this.note("ORDER_SUBMITTED", {
      venue: "BINANCE", env: this.env, symbol: intent.symbol, side: "SELL",
      quantity, notionalUsd: intent.notionalUsd, orderId: placed.orderId, status: placed.status,
    });
    return placed;
  }
}

export { BinanceApiError };

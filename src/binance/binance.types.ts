// Binance integration — shared types.
//
// ENVIRONMENT IS EXPLICIT. The production host (api.binance.com) and the
// testnet hosts (testnet.binance.vision for spot, testnet.binancefuture.com
// for futures) are different constants, and switching between them is a
// startup-time decision read from FURLPAY_BINANCE_ENV — never a silent
// fallback. A client that quietly routes a "test" order to production is how
// real money moves by accident.

export type BinanceEnv = "mainnet" | "testnet";

export type BinanceMarket = "spot" | "usds-m-futures";

export interface BinanceCredentials {
  readonly apiKey: string;
  /** The secret never leaves this module except into the HMAC signer. */
  readonly apiSecret: string;
}

export interface SymbolFilter {
  readonly filterType: string;
  /** Exact decimal strings from the exchange — never parsed into floats. */
  readonly [key: string]: unknown;
}

export interface SymbolInfo {
  readonly symbol: string;
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly filters: readonly SymbolFilter[];
}

export interface ExchangeInfo {
  readonly timezone: string;
  readonly symbols: readonly SymbolInfo[];
}

export interface Balance {
  readonly asset: string;
  /** Exact decimal strings from the exchange. */
  readonly free: string;
  readonly locked: string;
}

export interface AccountSnapshot {
  readonly accountType: string;
  readonly canTrade: boolean;
  readonly balances: readonly Balance[];
}

export interface OrderBookLevel {
  readonly price: string;
  readonly quantity: string;
}

export interface OrderBook {
  readonly symbol: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
}

export interface Ticker24h {
  readonly symbol: string;
  readonly lastPrice: string;
  readonly priceChangePercent: string;
  readonly volume: string;
  readonly quoteVolume: string;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType =
  | "LIMIT"
  | "LIMIT_MAKER"
  | "MARKET"
  | "STOP_LOSS"
  | "STOP_LOSS_LIMIT"
  | "TAKE_PROFIT"
  | "TAKE_PROFIT_LIMIT";

export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface PlacedOrder {
  readonly symbol: string;
  readonly orderId: number;
  readonly clientOrderId: string;
  readonly status: string;
  readonly executedQty: string;
  /** Exact decimal strings — the exchange confirms execution, not us. */
  readonly transactTime: number;
}

export interface OpenOrder {
  readonly symbol: string;
  readonly orderId: number;
  readonly price: string;
  readonly origQty: string;
  readonly executedQty: string;
  readonly status: string;
  readonly type: string;
  readonly side: string;
}

export interface BinanceError {
  readonly code: number;
  readonly msg: string;
  /** The HTTP status the exchange returned — surfaced, never swallowed. */
  readonly httpStatus: number;
}

/** The unified capability surface every exchange adapter declares. Derived
 *  from documented APIs — never assumed identical across exchanges. */
export interface ExchangeCapabilities {
  readonly exchange: string;
  readonly markets: readonly BinanceMarket[];
  readonly supports: {
    readonly balances: boolean;
    readonly marketOrders: boolean;
    readonly limitOrders: boolean;
    readonly ocoOrders: boolean;
    readonly cancel: boolean;
    readonly orderBook: boolean;
    readonly ticker: boolean;
    readonly klines: boolean;
    readonly websockets: boolean;
    /** Withdrawals are structurally ABSENT from this adapter — the field
     *  exists so an agent's capability query gets an explicit `false` instead
     *  of a silent no-method. */
    readonly withdrawals: false;
  };
}

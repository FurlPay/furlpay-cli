// Binance REST client — spot (api/v3) and USD-M futures (fapi/v1).
//
// Every failure SURFACES: the exchange's code, message and HTTP status come
// back as a typed BinanceError. A network failure is never converted into a
// synthetic "success", and a testnet client can never be silently swapped for
// a mainnet one — the host is fixed at construction from an explicit env.

import type {
  AccountSnapshot,
  BinanceEnv,
  BinanceError,
  BinanceMarket,
  ExchangeInfo,
  OpenOrder,
  OrderBook,
  PlacedOrder,
  Ticker24h,
} from "./binance.types.js";
import { signRequest, type SignedRequestParts } from "./binance.auth.js";

export const HOSTS: Readonly<Record<BinanceEnv, Readonly<Record<BinanceMarket, string>>>> = {
  mainnet: {
    spot: "https://api.binance.com",
    "usds-m-futures": "https://fapi.binance.com",
  },
  testnet: {
    spot: "https://testnet.binance.vision",
    "usds-m-futures": "https://testnet.binancefuture.com",
  },
};

export class BinanceApiError extends Error implements BinanceError {
  readonly code: number;
  readonly msg: string;
  readonly httpStatus: number;
  constructor(code: number, msg: string, httpStatus: number) {
    super(`binance ${httpStatus} ${code}: ${msg}`);
    this.name = "BinanceApiError";
    this.code = code;
    this.msg = msg;
    this.httpStatus = httpStatus;
  }
}

export interface BinanceClientOptions {
  readonly env: BinanceEnv;
  readonly market: BinanceMarket;
  readonly apiKey: string;
  /** The secret is held in the closure below and used only by `signedFetch`. */
  readonly apiSecret: string;
  readonly recvWindowMs?: number;
  /** Injected clock — tests pass a fixed time. */
  readonly nowMs?: () => number;
  /** Injected fetch — tests stub the transport; production uses globalThis. */
  readonly fetchImpl?: typeof fetch;
}

export class BinanceClient {
  private readonly host: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly recvWindowMs?: number;
  private readonly nowMs: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: BinanceClientOptions) {
    this.host = HOSTS[opts.env][opts.market];
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.recvWindowMs = opts.recvWindowMs;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get baseUrl(): string {
    return this.host;
  }

  /** Public (unsigned) GET — market data. */
  async publicGet(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const res = await this.fetchImpl(`${this.host}${path}${qs ? `?${qs}` : ""}`);
    return this.parse(res);
  }

  /** Signed (private) request — account, orders. The secret never leaves. */
  async signedRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PUT",
    path: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    const signed: SignedRequestParts = signRequest(
      { apiKey: this.apiKey, apiSecret: this.apiSecret },
      method,
      path,
      params,
      { nowMs: this.nowMs(), recvWindowMs: this.recvWindowMs }
    );
    const url = `${this.host}${path}?${signed.queryString}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: signed.headers,
    });
    return this.parse<T>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (proxy/html error page): surface it, never guess.
      throw new BinanceApiError(-1, text.slice(0, 300), res.status);
    }
    if (!res.ok) {
      const b = body as { code?: number; msg?: string } | null;
      throw new BinanceApiError(b?.code ?? -1, b?.msg ?? text.slice(0, 300), res.status);
    }
    return body as T;
  }

  // ── Spot market data (public) ────────────────────────────────────────────

  async exchangeInfo(): Promise<ExchangeInfo> {
    return this.publicGet("/api/v3/exchangeInfo") as Promise<ExchangeInfo>;
  }

  async ticker24h(symbol: string): Promise<Ticker24h> {
    return this.publicGet("/api/v3/ticker/24hr", { symbol: symbol.toUpperCase() }) as Promise<Ticker24h>;
  }

  async orderBook(symbol: string, limit = 20): Promise<OrderBook> {
    return this.publicGet("/api/v3/depth", { symbol: symbol.toUpperCase(), limit }) as Promise<OrderBook>;
  }

  // ── Private — account and orders ─────────────────────────────────────────

  async accountSnapshot(): Promise<AccountSnapshot> {
    return this.signedRequest<UnknownRecord>("GET", "/api/v3/account").then(mapAccount);
  }

  async placeSpotOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    type: string;
    quantity?: string;
    quoteOrderQty?: string;
    price?: string;
    timeInForce?: string;
    newClientOrderId?: string;
  }): Promise<PlacedOrder> {
    return this.signedRequest<PlacedOrder>("POST", "/api/v3/order", {
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      type: params.type,
      ...(params.quantity !== undefined ? { quantity: params.quantity } : {}),
      ...(params.quoteOrderQty !== undefined ? { quoteOrderQty: params.quoteOrderQty } : {}),
      ...(params.price !== undefined ? { price: params.price } : {}),
      ...(params.timeInForce ? { timeInForce: params.timeInForce } : {}),
      ...(params.newClientOrderId ? { newClientOrderId: params.newClientOrderId } : {}),
    });
  }

  async cancelSpotOrder(symbol: string, orderId: number): Promise<unknown> {
    return this.signedRequest("DELETE", "/api/v3/order", {
      symbol: symbol.toUpperCase(),
      orderId,
    });
  }

  async openOrders(symbol?: string): Promise<OpenOrder[]> {
    return this.signedRequest<OpenOrder[]>("GET", "/api/v3/openOrders", {
      ...(symbol ? { symbol: symbol.toUpperCase() } : {}),
    });
  }
}

type UnknownRecord = Record<string, unknown>;

function mapAccount(raw: UnknownRecord): AccountSnapshot {
  const balances = Array.isArray(raw.balances) ? raw.balances : [];
  return {
    accountType: String(raw.accountType ?? ""),
    canTrade: Boolean(raw.canTrade),
    balances: balances.map((b) => {
      const rec = b as Record<string, unknown>;
      return {
        asset: String(rec.asset ?? ""),
        free: String(rec.free ?? "0"),
        locked: String(rec.locked ?? "0"),
      };
    }),
  };
}

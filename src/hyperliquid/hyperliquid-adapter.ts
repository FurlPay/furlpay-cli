/**
 * Hyperliquid L1 Protocol Adapter (2026)
 * 
 * Implements verified Hyperliquid API connectivity, versioned schemas,
 * weighted REST rate-limiting, and global WebSocket budget governance.
 * 
 * Rate Limit Standards:
 * - REST IP Budget: 1,200 weighted points per minute per IP.
 * - Batch Weight Formula: Weight = 1 + floor(batchLength / 40).
 * - WebSocket Global Budget: 2,000 messages per minute across all connections.
 * - WebSocket In-Flight Limit: max 10 unacknowledged requests.
 */

import * as nativeHttps from "https";
import * as nativeHttp from "http";
import {
  HyperliquidMeta,
  HyperliquidAssetCtx,
  HyperliquidL2Book,
  HyperliquidClearinghouseState,
  HyperliquidOpenOrder,
  HyperliquidUserFill,
  HyperliquidVaultDetails,
  HyperliquidNetwork,
} from "./types";
import { HyperliquidSignature } from "./signer";

export interface RateLimitTracker {
  restWeightUsed: number;
  restWindowStart: number;
  wsMessageCount: number;
  wsWindowStart: number;
  inFlightRequests: number;
}

export class HyperliquidAdapter {
  public static readonly REST_BUDGET_PER_MIN = 1200;
  public static readonly WS_BUDGET_PER_MIN = 2000;
  public static readonly WS_MAX_IN_FLIGHT = 10;
  public static readonly WS_MAX_SUBSCRIPTIONS = 1000;

  private apiUrl: string;
  private wsUrl: string;
  private network: HyperliquidNetwork;

  // Rate Limiting Sliding Windows
  private restWeightUsed = 0;
  private restWindowStart = Date.now();
  private wsMessageCount = 0;
  private wsWindowStart = Date.now();
  private inFlightRequests = 0;

  constructor(network: HyperliquidNetwork = "mainnet") {
    this.network = network;
    if (network === "testnet") {
      this.apiUrl = "https://api.hyperliquid-testnet.xyz";
      this.wsUrl = "wss://api.hyperliquid-testnet.xyz/ws";
    } else {
      this.apiUrl = "https://api.hyperliquid.xyz";
      this.wsUrl = "wss://api.hyperliquid.xyz/ws";
    }
  }

  public getNetwork(): HyperliquidNetwork {
    return this.network;
  }

  public getApiUrl(): string {
    return this.apiUrl;
  }

  public getWsUrl(): string {
    return this.wsUrl;
  }

  /**
   * Verified Batch Weight Calculation:
   * Weight = 1 + floor(batch_length / 40)
   */
  public calculateBatchWeight(batchLength: number): number {
    if (batchLength <= 0) return 1;
    return 1 + Math.floor(batchLength / 40);
  }

  /**
   * Consumes REST rate-limiting budget and enforces sliding-window limit.
   */
  public checkAndConsumeRestBudget(weight: number = 1): { allowed: boolean; remaining: number; waitMs: number } {
    const now = Date.now();
    if (now - this.restWindowStart >= 60_000) {
      this.restWeightUsed = 0;
      this.restWindowStart = now;
    }

    if (this.restWeightUsed + weight > HyperliquidAdapter.REST_BUDGET_PER_MIN) {
      const waitMs = Math.max(0, 60_000 - (now - this.restWindowStart));
      return { allowed: false, remaining: 0, waitMs };
    }

    this.restWeightUsed += weight;
    return {
      allowed: true,
      remaining: HyperliquidAdapter.REST_BUDGET_PER_MIN - this.restWeightUsed,
      waitMs: 0,
    };
  }

  /**
   * Tracks WebSocket incoming/outgoing messages against the 2,000 msgs/min global budget.
   */
  public trackWsMessage(): { allowed: boolean; count: number; remaining: number } {
    const now = Date.now();
    if (now - this.wsWindowStart >= 60_000) {
      this.wsMessageCount = 0;
      this.wsWindowStart = now;
    }

    if (this.wsMessageCount >= HyperliquidAdapter.WS_BUDGET_PER_MIN) {
      return { allowed: false, count: this.wsMessageCount, remaining: 0 };
    }

    this.wsMessageCount++;
    return {
      allowed: true,
      count: this.wsMessageCount,
      remaining: HyperliquidAdapter.WS_BUDGET_PER_MIN - this.wsMessageCount,
    };
  }

  public trackInFlightStart(): boolean {
    if (this.inFlightRequests >= HyperliquidAdapter.WS_MAX_IN_FLIGHT) {
      return false;
    }
    this.inFlightRequests++;
    return true;
  }

  public trackInFlightEnd(): void {
    if (this.inFlightRequests > 0) {
      this.inFlightRequests--;
    }
  }

  public getInFlightCount(): number {
    return this.inFlightRequests;
  }

  /**
   * Low-level POST request execution with weight deduction.
   */
  public async postRequest<T>(endpoint: "/info" | "/exchange", payload: any, weight = 1): Promise<T> {
    const budget = this.checkAndConsumeRestBudget(weight);
    if (!budget.allowed) {
      throw new Error(
        `RATE_LIMIT_EXCEEDED: REST weight quota exceeded (${this.restWeightUsed}/${HyperliquidAdapter.REST_BUDGET_PER_MIN}). Retry in ${budget.waitMs}ms.`
      );
    }

    const targetUrl = new URL(endpoint, this.apiUrl);
    const bodyStr = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const isHttps = targetUrl.protocol === "https:";
      const lib = isHttps ? nativeHttps : nativeHttp;

      const req = lib.request(
        targetUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr),
            "User-Agent": "FurlPay-Quant-Adapter/3.0.0",
          },
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(
                new Error(`Hyperliquid HTTP ${res.statusCode}: ${data || res.statusMessage}`)
              );
            }
            try {
              const parsed = JSON.parse(data);
              resolve(parsed as T);
            } catch (err: any) {
              reject(new Error(`Failed to parse Hyperliquid JSON response: ${err.message}`));
            }
          });
        }
      );

      req.on("error", (e) => reject(new Error(`Hyperliquid Request Failed: ${e.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Hyperliquid Request Timed Out (10s limit)`));
      });

      req.write(bodyStr);
      req.end();
    });
  }

  // ---- Type-Safe /info Queries ---------------------------------------------

  public async getMetaAndAssetCtxs(): Promise<[HyperliquidMeta, HyperliquidAssetCtx[]]> {
    return await this.postRequest<[HyperliquidMeta, HyperliquidAssetCtx[]]>("/info", {
      type: "metaAndAssetCtxs",
    });
  }

  public async getL2Book(coin: string): Promise<HyperliquidL2Book> {
    const cleanCoin = coin.replace(/-PERP$/i, "").toUpperCase();
    return await this.postRequest<HyperliquidL2Book>("/info", {
      type: "l2Book",
      coin: cleanCoin,
    });
  }

  public async getClearinghouseState(userAddress: string): Promise<HyperliquidClearinghouseState> {
    return await this.postRequest<HyperliquidClearinghouseState>("/info", {
      type: "clearinghouseState",
      user: userAddress,
    });
  }

  public async getOpenOrders(userAddress: string): Promise<HyperliquidOpenOrder[]> {
    return await this.postRequest<HyperliquidOpenOrder[]>("/info", {
      type: "openOrders",
      user: userAddress,
    });
  }

  public async getUserFills(userAddress: string): Promise<HyperliquidUserFill[]> {
    return await this.postRequest<HyperliquidUserFill[]>("/info", {
      type: "userFills",
      user: userAddress,
    });
  }

  public async getVaultDetails(vaultAddress: string, userAddress?: string): Promise<HyperliquidVaultDetails> {
    const payload: any = { type: "vaultDetails", vaultAddress };
    if (userAddress) payload.user = userAddress;
    return await this.postRequest<HyperliquidVaultDetails>("/info", payload);
  }

  // ---- /exchange Submission ------------------------------------------------

  public async submitSignedAction<T>(
    action: any,
    nonce: number,
    signature: HyperliquidSignature,
    vaultAddress?: string
  ): Promise<T> {
    const ordersCount = Array.isArray(action?.orders) ? action.orders.length : 1;
    const weight = this.calculateBatchWeight(ordersCount);

    const payload: any = {
      action,
      nonce,
      signature,
    };
    if (vaultAddress) {
      payload.vaultAddress = vaultAddress;
    }

    return await this.postRequest<T>("/exchange", payload, weight);
  }
}

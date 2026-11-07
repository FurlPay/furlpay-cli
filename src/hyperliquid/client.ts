/**
 * Hyperliquid L1 Production API Client
 * 
 * Interacts with the real Hyperliquid validator network:
 * - Querying /info for order books, clearinghouse margin state, fills, and vaults.
 * - Submitting signed EIP-712 envelopes to /exchange for order execution, cancellations, leverage updates, and vault deposits.
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
  HyperliquidAssetMeta,
  HyperliquidNetwork,
} from "./types";
import { HyperliquidSignature } from "./signer";

export class HyperliquidClient {
  private apiUrl: string;
  private network: HyperliquidNetwork;
  private cachedMeta: HyperliquidMeta | null = null;
  private metaCacheTime: number = 0;
  private metaCacheTtlMs: number = 60_000; // 1 minute cache

  constructor(network: HyperliquidNetwork = "mainnet") {
    this.network = network;
    this.apiUrl = network === "testnet" 
      ? "https://api.hyperliquid-testnet.xyz" 
      : "https://api.hyperliquid.xyz";
  }

  getNetwork(): HyperliquidNetwork {
    return this.network;
  }

  getApiUrl(): string {
    return this.apiUrl;
  }

  /**
   * Execute an authenticated or read-only POST request against Hyperliquid endpoints.
   */
  private async postRequest<T>(endpoint: "/info" | "/exchange", payload: any): Promise<T> {
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
            "User-Agent": "FurlPay-CLI/0.4.0",
          },
          timeout: 10_000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
              return reject(
                new Error(
                  `Hyperliquid API Error HTTP ${res.statusCode}: ${data || res.statusMessage}`
                )
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

      req.on("error", (e) => reject(new Error(`Hyperliquid Network Request Failed: ${e.message}`)));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Hyperliquid Request Timed Out (10s limit)`));
      });

      req.write(bodyStr);
      req.end();
    });
  }

  // ---- /info Public Queries ------------------------------------------------

  /**
   * Fetch universe metadata (all tradeable perpetual assets, szDecimals, maxLeverage).
   */
  async getMeta(forceRefresh = false): Promise<HyperliquidMeta> {
    const now = Date.now();
    if (!forceRefresh && this.cachedMeta && now - this.metaCacheTime < this.metaCacheTtlMs) {
      return this.cachedMeta;
    }
    const meta = await this.postRequest<HyperliquidMeta>("/info", { type: "meta" });
    this.cachedMeta = meta;
    this.metaCacheTime = now;
    return meta;
  }

  /**
   * Fetch universe metadata along with live asset contexts (oracle prices, funding rates, open interest).
   */
  async getMetaAndAssetCtxs(): Promise<[HyperliquidMeta, HyperliquidAssetCtx[]]> {
    const [meta, assetCtxs] = await this.postRequest<[HyperliquidMeta, HyperliquidAssetCtx[]]>("/info", {
      type: "metaAndAssetCtxs",
    });
    this.cachedMeta = meta;
    this.metaCacheTime = Date.now();
    return [meta, assetCtxs];
  }

  /**
   * Fetch mid prices for all coins.
   */
  async getAllMids(): Promise<Record<string, string>> {
    return await this.postRequest<Record<string, string>>("/info", { type: "allMids" });
  }

  /**
   * Fetch L2 Order Book depth for any perpetual asset.
   */
  async getL2Book(coin: string): Promise<HyperliquidL2Book> {
    const cleanCoin = coin.replace(/-PERP$/i, "").toUpperCase();
    const book = await this.postRequest<HyperliquidL2Book>("/info", {
      type: "l2Book",
      coin: cleanCoin,
    });
    if (book && book.levels && book.levels[0]?.length && book.levels[1]?.length) {
      return book;
    }
    throw new Error(`Empty book levels returned for ${cleanCoin}`);
  }

  /**
   * Fetch clearinghouse margin state, equity, and open positions for a user address.
   */
  async getClearinghouseState(userAddress: string): Promise<HyperliquidClearinghouseState> {
    return await this.postRequest<HyperliquidClearinghouseState>("/info", {
      type: "clearinghouseState",
      user: userAddress,
    });
  }

  /**
   * Fetch open resting orders for a user.
   */
  async getUserOpenOrders(userAddress: string): Promise<HyperliquidOpenOrder[]> {
    return await this.postRequest<HyperliquidOpenOrder[]>("/info", {
      type: "openOrders",
      user: userAddress,
    });
  }

  /**
   * Fetch recent trade fills for a user.
   */
  async getUserFills(userAddress: string): Promise<HyperliquidUserFill[]> {
    return await this.postRequest<HyperliquidUserFill[]>("/info", {
      type: "userFills",
      user: userAddress,
    });
  }

  /**
   * Fetch funding history for a user.
   */
  async getUserFunding(userAddress: string, startTime: number = Date.now() - 7 * 86400 * 1000): Promise<any[]> {
    return await this.postRequest<any[]>("/info", {
      type: "userFunding",
      user: userAddress,
      startTime,
    });
  }

  /**
   * Fetch live vault details (e.g. HLP community vault).
   */
  async getVaultDetails(vaultAddress: string, userAddress?: string): Promise<HyperliquidVaultDetails> {
    const payload: any = {
      type: "vaultDetails",
      vaultAddress,
    };
    if (userAddress) {
      payload.user = userAddress;
    }
    return await this.postRequest<HyperliquidVaultDetails>("/info", payload);
  }

  // ---- /exchange Execution Mutations ---------------------------------------

  /**
   * Submit an EIP-712 signed action to the Hyperliquid L1 order execution engine.
   */
  async submitAction(
    action: any,
    signature: HyperliquidSignature,
    nonce: number,
    vaultAddress?: string
  ): Promise<any> {
    const payload: any = {
      action,
      nonce,
      signature: {
        r: signature.r,
        s: signature.s,
        v: signature.v,
      },
    };
    if (vaultAddress) {
      payload.vaultAddress = vaultAddress;
    }

    const res = await this.postRequest<any>("/exchange", payload);
    if (res && res.status === "err") {
      throw new Error(`Hyperliquid Execution Error: ${res.response}`);
    }
    return res;
  }

  // ---- Asset Formatting Helpers --------------------------------------------

  async getAssetIndex(coin: string): Promise<number> {
    const clean = coin.replace(/-PERP$/i, "").toUpperCase();
    const meta = await this.getMeta();
    const index = meta.universe.findIndex((a) => a.name.toUpperCase() === clean);
    if (index === -1) {
      throw new Error(`Asset '${coin}' not found in Hyperliquid universe (${meta.universe.length} assets available).`);
    }
    return index;
  }

  async getAssetMeta(coin: string): Promise<HyperliquidAssetMeta> {
    const clean = coin.replace(/-PERP$/i, "").toUpperCase();
    const meta = await this.getMeta();
    const asset = meta.universe.find((a) => a.name.toUpperCase() === clean);
    if (!asset) {
      throw new Error(`Asset '${coin}' not found in Hyperliquid universe.`);
    }
    return asset;
  }

  /**
   * Format size strictly matching Hyperliquid szDecimals for the asset.
   */
  async formatSize(coin: string, size: number): Promise<string> {
    const asset = await this.getAssetMeta(coin);
    return size.toFixed(asset.szDecimals);
  }

  /**
   * Format price matching Hyperliquid precision rules (up to 5 significant figures, max 6 decimals).
   */
  formatPrice(price: number): string {
    if (price >= 100_000) return price.toFixed(1);
    if (price >= 10_000) return price.toFixed(2);
    if (price >= 100) return price.toFixed(2);
    if (price >= 1) return Number(price.toPrecision(5)).toString();
    return Number(price.toPrecision(5)).toString();
  }
}

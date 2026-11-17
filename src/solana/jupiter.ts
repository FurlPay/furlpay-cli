/**
 * Jupiter aggregator client — live, read-only (gap report 2026-11-17, Gap 5).
 *
 * Two surfaces, both against the public Jupiter Lite API (probed live
 * 2026-11-17):
 *   price  lite-api.jup.ag/price/v3?ids={mint}         — liquidity-weighted USD price
 *   quote  lite-api.jup.ag/swap/v1/quote?...            — indicative swap route
 *
 * HONESTY LABEL — a quote here is ROUTING INFORMATION, never an execution:
 * this build has no Solana signing path, so a returned quote cannot be
 * filled by anything in this CLI. The response is labeled indicative at
 * every layer that surfaces it. When execution ships it will go through the
 * capability registry's assertLiveAllowed gate like every other signing
 * surface — this module deliberately contains no such gate because there is
 * nothing behind it yet.
 */

import { assertValidSolanaAddress } from "./rpc";

export interface JupiterDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to the public Lite API; override for a paid/self-hosted endpoint. */
  baseUrl?: string;
}

/** Verified mainnet mints (cross-checked against live Jupiter responses). */
export const KNOWN_MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

/** Resolve "SOL"/"USDC" aliases or validate a raw mint address. */
export function resolveMint(symbolOrMint: string): string {
  const clean = symbolOrMint.trim();
  const alias = KNOWN_MINTS[clean.toUpperCase()];
  if (alias) return alias;
  return assertValidSolanaAddress(clean, "mint");
}

export interface JupiterPrice {
  mint: string;
  usdPrice: number;
  decimals: number | null;
  liquidityUsd: number | null;
  priceChange24hPct: number | null;
}

export interface JupiterRouteQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: string | null;
  swapMode: string;
  routeLabels: string[];
  /** Always "INDICATIVE" in this build — see the module honesty label. */
  execution: "INDICATIVE";
}

export class JupiterClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(deps: JupiterDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
    const fromEnv = process.env.FURLPAY_JUPITER_API_URL?.trim();
    this.baseUrl = deps.baseUrl ?? (fromEnv || "https://lite-api.jup.ag");
    if (!/^https:\/\//.test(this.baseUrl)) {
      throw new Error("JUPITER_INSECURE_URL: the Jupiter endpoint must be https.");
    }
  }

  describeEndpoint(): string {
    return this.baseUrl;
  }

  /** Liquidity-weighted USD price for a mint (or SOL/USDC alias). Null on any failure — never a guess. */
  async priceUsd(symbolOrMint: string): Promise<JupiterPrice | null> {
    const mint = resolveMint(symbolOrMint);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/price/v3?ids=${mint}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, {
        usdPrice?: number; decimals?: number; liquidity?: number; priceChange24h?: number;
      }>;
      const entry = body?.[mint];
      if (!entry || typeof entry.usdPrice !== "number" || !Number.isFinite(entry.usdPrice)) return null;
      return {
        mint,
        usdPrice: entry.usdPrice,
        decimals: typeof entry.decimals === "number" ? entry.decimals : null,
        liquidityUsd: typeof entry.liquidity === "number" ? entry.liquidity : null,
        priceChange24hPct: typeof entry.priceChange24h === "number" ? entry.priceChange24h : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Indicative swap quote (raw integer amounts in mint decimals). Amounts
   * are integers-enforced: `amount` must be a non-negative integer string —
   * the on-chain world has no fractional lamports, and a float here is a
   * precision bug, not convenience.
   */
  async quote(input: {
    inputMint: string;
    outputMint: string;
    /** Raw amount in the input mint's smallest unit, e.g. 100000000 = 0.1 SOL. */
    amount: string | number;
    slippageBps?: number;
  }): Promise<JupiterRouteQuote | null> {
    const inputMint = resolveMint(input.inputMint);
    const outputMint = resolveMint(input.outputMint);
    const amount = typeof input.amount === "number" ? String(Math.trunc(input.amount)) : input.amount.trim();
    if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error(`JUPITER_INVALID_AMOUNT: amount must be a positive integer of the input mint's smallest unit (got "${input.amount}").`);
    }
    const slippageBps = input.slippageBps ?? 50;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
      throw new Error("JUPITER_INVALID_SLIPPAGE: slippageBps must be an integer in [0, 10000].");
    }
    try {
      const url =
        `${this.baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
        `&amount=${amount}&slippageBps=${slippageBps}`;
      const res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        inputMint?: string; outputMint?: string; inAmount?: string; outAmount?: string;
        slippageBps?: number; priceImpactPct?: string | null; swapMode?: string;
        routePlan?: Array<{ swapInfo?: { label?: string } }>;
      };
      if (!body.inputMint || !body.outputMint || !body.inAmount || !body.outAmount) return null;
      return {
        inputMint: body.inputMint,
        outputMint: body.outputMint,
        inAmount: body.inAmount,
        outAmount: body.outAmount,
        slippageBps: typeof body.slippageBps === "number" ? body.slippageBps : slippageBps,
        priceImpactPct: body.priceImpactPct ?? null,
        swapMode: body.swapMode ?? "ExactIn",
        routeLabels: (body.routePlan ?? []).map((leg) => leg.swapInfo?.label ?? "unlabeled").filter(Boolean),
        execution: "INDICATIVE",
      };
    } catch {
      return null;
    }
  }
}

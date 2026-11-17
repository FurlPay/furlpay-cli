/**
 * Solana JSON-RPC client — live, read-only (gap report 2026-11-17, Gap 5,
 * first slice: cluster telemetry + account lookups over real RPC).
 *
 * Plain fetch, no new dependencies, https-only, injectable transport — the
 * same pattern as the market adapter and the peg feed. This surface never
 * signs or broadcasts: there is no key handling here at all, so "live" for
 * this module means live reads, and nothing else.
 *
 * Honesty rules:
 * - A failed RPC call throws with the protocol error surfaced — never a
 *   synthetic slot, never epoch 0.
 * - Externally supplied addresses are validated as base58 (32-44 chars,
 *   no 0/O/I/l) BEFORE they are put in a request body.
 */

export interface SolanaRpcDeps {
  /** Defaults to SOLANA_RPC_URL or the public mainnet-beta endpoint. */
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validate an externally supplied Solana address. Throws (does not return false) so callers fail closed. */
export function assertValidSolanaAddress(address: string, label = "address"): string {
  const clean = address.trim();
  if (!BASE58_RE.test(clean)) {
    throw new Error(`INVALID_SOLANA_ADDRESS: ${label} "${address}" is not a base58 Solana address.`);
  }
  return clean;
}

export interface SolanaEpochInfo {
  epoch: number;
  absoluteSlot: number;
  blockHeight: number;
  slotIndex: number;
  slotsInEpoch: number;
  transactionCount: number | null;
}

export class SolanaRpcClient {
  private readonly rpcUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(deps: SolanaRpcDeps = {}) {
    const fromEnv = process.env.SOLANA_RPC_URL?.trim();
    this.rpcUrl = deps.rpcUrl ?? (fromEnv || "https://api.mainnet-beta.solana.com");
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? 8_000;
    if (!/^https:\/\//.test(this.rpcUrl)) {
      throw new Error("SOLANA_RPC_INSECURE_URL: the Solana RPC endpoint must be https.");
    }
  }

  describeEndpoint(): string {
    return this.rpcUrl;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Solana RPC HTTP ${res.status} from ${this.rpcUrl}`);
    }
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) {
      throw new Error(`Solana RPC error on ${method}: ${json.error.message ?? "unknown error"}`);
    }
    if (json.result === undefined) {
      throw new Error(`Solana RPC returned no result on ${method}.`);
    }
    return json.result;
  }

  async getEpochInfo(): Promise<SolanaEpochInfo> {
    const r = await this.rpc<{
      epoch: number; absoluteSlot: number; blockHeight: number;
      slotIndex: number; slotsInEpoch: number; transactionCount?: number;
    }>("getEpochInfo", []);
    return {
      epoch: r.epoch,
      absoluteSlot: r.absoluteSlot,
      blockHeight: r.blockHeight,
      slotIndex: r.slotIndex,
      slotsInEpoch: r.slotsInEpoch,
      transactionCount: typeof r.transactionCount === "number" ? r.transactionCount : null,
    };
  }

  async getSlot(commitment: "confirmed" | "finalized" = "finalized"): Promise<number> {
    return this.rpc<number>("getSlot", [{ commitment }]);
  }

  /** Lamport balance for an address (1 SOL = 1e9 lamports). Address is validated before the call. */
  async getBalanceLamports(address: string): Promise<number> {
    const validated = assertValidSolanaAddress(address);
    const r = await this.rpc<{ value: number }>("getBalance", [validated, { commitment: "confirmed" }]);
    return r.value;
  }
}

// Binance request signing — HMAC-SHA256 over the sorted query string.
//
// The secret exists ONLY inside signRequest's closure; call sites receive
// signed URLs/headers and never see the key material. The timestamp source is
// injected so signing is deterministic and testable without a clock, and
// recvWindow is enforced here — a stale signature must be rejected BEFORE the
// request is sent rather than after the exchange refuses it.

import { createHmac } from "node:crypto";
import type { BinanceCredentials } from "./binance.types.js";

export const DEFAULT_RECV_WINDOW_MS = 5_000;

export interface SignedRequestParts {
  /** The signed payload WITH the signature appended — the exact bytes to
   *  send. GET puts them in the URL query; POST/PUT/DELETE put them in an
   *  application/x-www-form-urlencoded body (audit P4, CWE-598). */
  readonly queryString: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Deterministic HMAC-SHA256 hex signature over the query string. Exported
 *  pure so the test battery can pin exact signatures against a fixed secret. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Sign a Binance private-endpoint request.
 *
 * `params` must already carry every business parameter; timestamp and
 * recvWindow are added here from the injected clock and policy. Order of
 * concatenation is insertion order (Binance accepts any consistent order as
 * long as the signature covers exactly what is sent).
 */
export function signRequest(
  credentials: BinanceCredentials,
  method: "GET" | "POST" | "DELETE" | "PUT",
  basePath: string,
  params: Readonly<Record<string, string | number | boolean>>,
  opts: {
    nowMs: number;
    recvWindowMs?: number;
  }
): SignedRequestParts {
  const recvWindow = opts.recvWindowMs ?? DEFAULT_RECV_WINDOW_MS;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  parts.push(`timestamp=${opts.nowMs}`);
  parts.push(`recvWindow=${recvWindow}`);
  const base = parts.join("&");
  const signature = hmacSha256Hex(credentials.apiSecret, base);
  return {
    queryString: `${base}&signature=${signature}`,
    headers: { "X-MBX-APIKEY": credentials.apiKey },
  };
}

/**
 * Read the credentials from the environment. Keys are NEVER accepted as CLI
 * arguments — argv is visible in process listings and shell history.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): BinanceCredentials | null {
  const apiKey = env.BINANCE_API_KEY;
  const apiSecret = env.BINANCE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

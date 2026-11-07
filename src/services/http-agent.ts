/**
 * Institutional Low-Latency HTTP Agent & Undici Connection Pooling
 * 
 * Replaces legacy axios / http.Agent connections with high-performance
 * socket reuse, pipelining, and bounded concurrency to eliminate p99 TLS
 * renegotiation spikes.
 */

import { Agent, setGlobalDispatcher } from "undici";
import { LatencyTelemetry } from "../types";

// Institutional Low-Latency Undici Dispatcher
export const institutionalDispatcher = new Agent({
  connections: 128,          // Maximum concurrent sockets per origin
  pipelining: 1,             // 1 for HTTP/1.1 to avoid head-of-line blocking
  keepAliveTimeout: 60_000,   // Keep idle sockets open for 60s
  keepAliveMaxTimeout: 600_000,
  connectTimeout: 5_000,      // Fast 5s fail-fast connection timeout
  headersTimeout: 5_000,
  bodyTimeout: 10_000,
});

// Configure global dispatcher for outbound requests
try {
  setGlobalDispatcher(institutionalDispatcher);
} catch {
  // If global dispatcher is immutable or already configured, retain dispatcher instance
}

/**
 * Computes high-resolution network vs local processing telemetry.
 */
export function computeLatencyTelemetry(
  exchangeTime: number,
  startRecv: number,
  renderDiffMs: number = 0
): LatencyTelemetry {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const wallClockNow = Date.now();
  return {
    exchangeTimestampMs: exchangeTime,
    localReceiptTimestampMs: wallClockNow,
    normalizationDurationMs: Math.max(0, now - startRecv),
    renderDiffDurationMs: renderDiffMs,
    totalDeliveryLatencyMs: Math.max(0, wallClockNow - exchangeTime),
    clockDriftMs: wallClockNow - exchangeTime,
  };
}

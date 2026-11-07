import { SUPPORTED_NETWORKS } from './constants.js';

/**
 * Format a number as a USD currency string.
 * @example formatUSD(1234.5) => "$1,234.50"
 */
export function formatUSD(amount: number): string {
  return '$' + amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a basis-points value for display.
 * @example formatBPS(1.5) => "1.50 bps"
 */
export function formatBPS(bps: number): string {
  return `${bps.toFixed(2)} bps`;
}

/**
 * Format a latency value, choosing µs or ms based on magnitude.
 * @example formatLatency(169.54)  => "169.54 ms"
 * @example formatLatency(0.0242)  => "24.20 µs"
 */
export function formatLatency(ms: number): string {
  if (ms < 1) {
    return `${(ms * 1000).toFixed(2)} µs`;
  }
  return `${ms.toFixed(2)} ms`;
}

/**
 * Format a BTC volume with 4 decimal places.
 * @example formatVolume(3.3418) => "3.3418 BTC"
 */
export function formatVolume(btcSize: number): string {
  return `${btcSize.toFixed(4)} BTC`;
}

/**
 * Shorten an Ethereum-style address for display.
 * @example shortenAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") => "0x833...2913"
 */
export function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 5)}...${addr.slice(-4)}`;
}

/**
 * Format a timestamp (number in ms or Date) as an ISO 8601 string.
 */
export function formatTimestamp(ts: number | Date): string {
  const date = typeof ts === 'number' ? new Date(ts) : ts;
  return date.toISOString();
}

/**
 * Look up the human-readable network name for a CAIP-2 identifier.
 * @example formatNetworkName("eip155:8453") => "Base Mainnet"
 */
export function formatNetworkName(caip2Id: string): string {
  const network = SUPPORTED_NETWORKS.get(caip2Id);
  return network ? network.name : caip2Id;
}

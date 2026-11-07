import path from 'node:path';
import os from 'node:os';

export interface NetworkConfig {
  name: string;
  chainId: number | null;
  rpcUrl: string;
  wsUrl: string | null;
  explorerUrl: string | null;
  nativeCurrency: string;
  usdcAddress: string | null;
}

export const SUPPORTED_NETWORKS: Map<string, NetworkConfig> = new Map([
  [
    'eip155:8453',
    {
      name: 'Base Mainnet',
      chainId: 8453,
      rpcUrl: 'https://mainnet.base.org',
      wsUrl: null,
      explorerUrl: 'https://basescan.org',
      nativeCurrency: 'ETH',
      usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  ],
  [
    'eip155:42161',
    {
      name: 'Arbitrum One',
      chainId: 42161,
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      wsUrl: null,
      explorerUrl: 'https://arbiscan.io',
      nativeCurrency: 'ETH',
      usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    },
  ],
  [
    'eip155:1',
    {
      name: 'Ethereum',
      chainId: 1,
      rpcUrl: 'https://eth.llamarpc.com',
      wsUrl: null,
      explorerUrl: 'https://etherscan.io',
      nativeCurrency: 'ETH',
      usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    },
  ],
  [
    'hyperliquid:999',
    {
      name: 'Hyperliquid L1',
      chainId: null,
      rpcUrl: 'https://api.hyperliquid.xyz',
      wsUrl: 'wss://api.hyperliquid.xyz/ws',
      explorerUrl: null,
      nativeCurrency: 'HYPE',
      usdcAddress: null,
    },
  ],
]);

export const DEFAULT_NETWORK = 'eip155:8453';

export const X402_VERSION = 'x402-v2';

/** Default take rate in basis points (1.5 bps) */
export const DEFAULT_TAKE_RATE_BPS = 1.5;

/** Escrow time-to-live in milliseconds */
export const ESCROW_TTL_MS = 5000;

/** Maximum per-transaction amount in USDC */
export const MAX_PER_TX_DEFAULT = 0.05;

/** Maximum per-day amount in USDC */
export const MAX_PER_DAY_DEFAULT = 500;

/** Path to the FurlPay configuration directory */
export const CONFIG_DIR = path.join(os.homedir(), '.furlpay');

/** Default facilitator URL */
export const FACILITATOR_DEFAULT_URL = 'https://facilitator.furlpay.io';

import Conf from 'conf';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, DEFAULT_NETWORK, FACILITATOR_DEFAULT_URL } from './constants.js';

export interface FurlPayConfig {
  privateKey: string | null;
  network: string;
  rpcUrl: string | null;
  facilitatorUrl: string;
  takeRateBps: number | null;
  maxPerTx: number | null;
  maxPerDay: number | null;
}

const defaults: FurlPayConfig = {
  privateKey: null,
  network: DEFAULT_NETWORK,
  rpcUrl: null,
  facilitatorUrl: FACILITATOR_DEFAULT_URL,
  takeRateBps: null,
  maxPerTx: null,
  maxPerDay: null,
};

const store = new Conf<FurlPayConfig>({
  projectName: 'furlpay',
  cwd: CONFIG_DIR,
  configName: 'config',
  fileExtension: 'json',
  defaults,
});

/**
 * Load the full configuration, with environment variable overrides taking
 * precedence over persisted values.
 */
export function loadConfig(): FurlPayConfig {
  const config: FurlPayConfig = { ...store.store };

  // Environment variable overrides
  if (process.env.FURLPAY_PRIVATE_KEY) {
    config.privateKey = process.env.FURLPAY_PRIVATE_KEY;
  }
  if (process.env.FURLPAY_NETWORK) {
    config.network = process.env.FURLPAY_NETWORK;
  }
  if (process.env.FURLPAY_RPC_URL) {
    config.rpcUrl = process.env.FURLPAY_RPC_URL;
  }

  return config;
}

/**
 * Persist the entire configuration object.
 */
export function saveConfig(config: Partial<FurlPayConfig>): void {
  for (const [key, value] of Object.entries(config)) {
    store.set(key as keyof FurlPayConfig, value);
  }
}

/**
 * Retrieve a single configuration value.
 */
export function getConfig<K extends keyof FurlPayConfig>(key: K): FurlPayConfig[K] {
  // Environment overrides take precedence for the well-known keys
  if (key === 'privateKey' && process.env.FURLPAY_PRIVATE_KEY) {
    return process.env.FURLPAY_PRIVATE_KEY as FurlPayConfig[K];
  }
  if (key === 'network' && process.env.FURLPAY_NETWORK) {
    return process.env.FURLPAY_NETWORK as FurlPayConfig[K];
  }
  if (key === 'rpcUrl' && process.env.FURLPAY_RPC_URL) {
    return process.env.FURLPAY_RPC_URL as FurlPayConfig[K];
  }

  return store.get(key);
}

/**
 * Set a single configuration value.
 */
export function setConfig<K extends keyof FurlPayConfig>(
  key: K,
  value: FurlPayConfig[K],
): void {
  store.set(key, value);
}

/**
 * Reset configuration to defaults, removing the persisted file.
 */
export function resetConfig(): void {
  store.clear();

  // Re-apply defaults
  for (const [key, value] of Object.entries(defaults)) {
    store.set(key as keyof FurlPayConfig, value);
  }
}

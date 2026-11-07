/**
 * FurlPay Configuration Management
 * Supports ~/.furlpay/config.toml with JSON fallback.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { FurlPayConfig, NetworkConfig, NetworkProfile } from "../types";

export const DEFAULT_CONFIG: FurlPayConfig = {
  network: {
    activeProfile: "mainnet",
    mainnet: {
      horizonUrl: "https://horizon.stellar.org",
      sorobanRpcUrl: "https://mainnet.sorobanrpc.com",
      passphrase: "Public Global Stellar Network ; September 2015",
      furlpayGateway: "https://gateway.furlpay.io/v1",
      sponsorshipEndpoint: "https://gateway.furlpay.io/v1/sponsor",
    },
    testnet: {
      horizonUrl: "https://horizon-testnet.stellar.org",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      passphrase: "Test SDF Network ; September 2015",
      furlpayGateway: "https://test-gateway.furlpay.io/v1",
      sponsorshipEndpoint: "https://test-gateway.furlpay.io/v1/sponsor",
    },
  },
  wallet: {
    defaultAccount: "trading-desk-primary",
    keyringBackend: "os_keychain",
    autoLockMinutes: 15,
  },
  trading: {
    defaultSlippagePct: 0.5,
    defaultPostOnly: false,
    maxPriceImpactPct: 2.0,
    autoDetectSep8: true,
    autoSweepYield: false,
  },
  agent_trust: {
    maxSingleTxUsd: 10.00,
    dailyVelocityCapUsd: 250.00,
    enforceOfacSdn: true,
    anomalyThreshold: 0.82,
  },
  ui: {
    theme: "dark",
    orderbookDepth: 20,
    refreshIntervalMs: 500,
  },
};

export function getConfigDir(): string {
  const dir = path.join(os.homedir(), ".furlpay");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getConfigPath(): string {
  const dir = getConfigDir();
  const tomlPath = path.join(dir, "config.toml");
  if (fs.existsSync(tomlPath)) return tomlPath;
  const jsonPath = path.join(dir, "config.json");
  if (fs.existsSync(jsonPath)) return jsonPath;
  return tomlPath;
}

export function parseTomlLike(content: string): Partial<FurlPayConfig> {
  const result: any = { network: {}, wallet: {}, trading: {}, agent_trust: {}, ui: {} };
  let currentSection = "";

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[(.*)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      let valStr = kvMatch[2].trim();
      // Remove inline comments
      const commentIdx = valStr.indexOf("#");
      if (commentIdx !== -1) {
        valStr = valStr.slice(0, commentIdx).trim();
      }

      let parsedVal: any = valStr;
      if (valStr.startsWith('"') && valStr.endsWith('"')) {
        parsedVal = valStr.slice(1, -1);
      } else if (valStr === "true") {
        parsedVal = true;
      } else if (valStr === "false") {
        parsedVal = false;
      } else if (!isNaN(Number(valStr)) && valStr !== "") {
        parsedVal = Number(valStr);
      }

      if (currentSection === "network") {
        result.network[key === "active_profile" ? "activeProfile" : key] = parsedVal;
      } else if (currentSection === "network.mainnet") {
        if (!result.network.mainnet) result.network.mainnet = {};
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.network.mainnet[camelKey] = parsedVal;
      } else if (currentSection === "network.testnet") {
        if (!result.network.testnet) result.network.testnet = {};
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.network.testnet[camelKey] = parsedVal;
      } else if (currentSection === "wallet") {
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.wallet[camelKey] = parsedVal;
      } else if (currentSection === "trading") {
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.trading[camelKey] = parsedVal;
      } else if (currentSection === "agent_trust") {
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.agent_trust[camelKey] = parsedVal;
      } else if (currentSection === "ui") {
        const camelKey = key.replace(/_([a-z])/g, (_, g) => g.toUpperCase());
        result.ui[camelKey] = parsedVal;
      }
    }
  }

  return result;
}

export function formatToml(cfg: FurlPayConfig): string {
  return `# FurlPay CLI Production Configuration
# Path: ~/.furlpay/config.toml

[network]
active_profile = "${cfg.network.activeProfile}"

[network.mainnet]
horizon_url = "${cfg.network.mainnet.horizonUrl}"
soroban_rpc_url = "${cfg.network.mainnet.sorobanRpcUrl}"
passphrase = "${cfg.network.mainnet.passphrase}"
furlpay_gateway = "${cfg.network.mainnet.furlpayGateway}"
sponsorship_endpoint = "${cfg.network.mainnet.sponsorshipEndpoint}"

[network.testnet]
horizon_url = "${cfg.network.testnet.horizonUrl}"
soroban_rpc_url = "${cfg.network.testnet.sorobanRpcUrl}"
passphrase = "${cfg.network.testnet.passphrase}"
furlpay_gateway = "${cfg.network.testnet.furlpayGateway}"
sponsorship_endpoint = "${cfg.network.testnet.sponsorshipEndpoint}"

[wallet]
default_account = "${cfg.wallet.defaultAccount}"
keyring_backend = "${cfg.wallet.keyringBackend}"
auto_lock_minutes = ${cfg.wallet.autoLockMinutes}

[trading]
default_slippage_pct = ${cfg.trading.defaultSlippagePct}
default_post_only = ${cfg.trading.defaultPostOnly}
max_price_impact_pct = ${cfg.trading.maxPriceImpactPct}
auto_detect_sep8 = ${cfg.trading.autoDetectSep8}
auto_sweep_yield = ${cfg.trading.autoSweepYield}

[agent_trust]
max_single_tx_usd = ${cfg.agent_trust.maxSingleTxUsd.toFixed(2)}
daily_velocity_cap_usd = ${cfg.agent_trust.dailyVelocityCapUsd.toFixed(2)}
enforce_ofac_sdn = ${cfg.agent_trust.enforceOfacSdn}
anomaly_threshold = ${cfg.agent_trust.anomalyThreshold}

[ui]
theme = "${cfg.ui.theme}"
orderbook_depth = ${cfg.ui.orderbookDepth}
refresh_interval_ms = ${cfg.ui.refreshIntervalMs}
`;
}

export function loadConfig(customPath?: string): FurlPayConfig {
  const targetPath = customPath || getConfigPath();
  if (!fs.existsSync(targetPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf-8");
    if (targetPath.endsWith(".json")) {
      const parsed = JSON.parse(raw);
      return mergeWithDefaults(parsed);
    }
    const parsedToml = parseTomlLike(raw);
    return mergeWithDefaults(parsedToml);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cfg: FurlPayConfig, customPath?: string): void {
  const targetPath = customPath || path.join(getConfigDir(), "config.toml");
  const content = formatToml(cfg);
  fs.writeFileSync(targetPath, content, { encoding: "utf-8", mode: 0o600 });
}

function mergeWithDefaults(partial: any): FurlPayConfig {
  return {
    network: {
      activeProfile: partial.network?.activeProfile || DEFAULT_CONFIG.network.activeProfile,
      mainnet: { ...DEFAULT_CONFIG.network.mainnet, ...(partial.network?.mainnet || {}) },
      testnet: { ...DEFAULT_CONFIG.network.testnet, ...(partial.network?.testnet || {}) },
    },
    wallet: { ...DEFAULT_CONFIG.wallet, ...(partial.wallet || {}) },
    trading: { ...DEFAULT_CONFIG.trading, ...(partial.trading || {}) },
    agent_trust: { ...DEFAULT_CONFIG.agent_trust, ...(partial.agent_trust || {}) },
    ui: { ...DEFAULT_CONFIG.ui, ...(partial.ui || {}) },
  };
}

export function getActiveNetworkConfig(cfg: FurlPayConfig, overrideProfile?: NetworkProfile): NetworkConfig {
  const profile = overrideProfile || cfg.network.activeProfile;
  return cfg.network[profile] || cfg.network.mainnet;
}

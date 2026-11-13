/**
 * Configuration validation — `furlpay config validate`.
 *
 * Validates a loaded FurlPayConfig for structural sanity: network profiles,
 * canonical Stellar passphrases, https endpoints, risk-control bounds, and
 * agent-trust limits. Returns machine-readable check results so the CLI can
 * emit either a human report or JSON, and exit non-zero on failure.
 */

import { FurlPayConfig } from "../types";

export interface ConfigCheck {
  name: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
}

export interface ConfigValidationResult {
  valid: boolean;
  checks: ConfigCheck[];
}

/** Official network passphrases (developers.stellar.org — never edited). */
export const CANONICAL_PASSPHRASES: Record<string, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

export const KEYRING_BACKENDS = ["os_keychain", "encrypted_file", "memory"] as const;

function isHttpsUrl(v: unknown): boolean {
  if (typeof v !== "string" || !v) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkNetworkProfile(cfg: FurlPayConfig, profile: "mainnet" | "testnet", checks: ConfigCheck[]): void {
  const net = cfg.network?.[profile];
  const label = `network.${profile}`;

  if (!net || typeof net !== "object") {
    checks.push({
      name: `${label}.present`,
      ok: false,
      severity: "error",
      detail: `The ${profile} network profile is missing entirely.`,
    });
    return;
  }

  checks.push({
    name: `${label}.horizonUrl`,
    ok: isHttpsUrl(net.horizonUrl),
    severity: "error",
    detail: isHttpsUrl(net.horizonUrl)
      ? String(net.horizonUrl)
      : "horizonUrl must be a valid https:// URL.",
  });
  checks.push({
    name: `${label}.sorobanRpcUrl`,
    ok: isHttpsUrl(net.sorobanRpcUrl),
    severity: "error",
    detail: isHttpsUrl(net.sorobanRpcUrl)
      ? String(net.sorobanRpcUrl)
      : "sorobanRpcUrl must be a valid https:// URL.",
  });

  const canonical = CANONICAL_PASSPHRASES[profile];
  const passphraseOk = net.passphrase === canonical;
  checks.push({
    name: `${label}.passphrase`,
    ok: passphraseOk,
    severity: "error",
    detail: passphraseOk
      ? "matches the canonical network passphrase"
      : `does not match the canonical ${profile} passphrase ("${canonical}"). A wrong passphrase produces transactions the network will reject as bad_auth.`,
  });

  checks.push({
    name: `${label}.furlpayGateway`,
    ok: isHttpsUrl(net.furlpayGateway),
    severity: "error",
    detail: isHttpsUrl(net.furlpayGateway)
      ? String(net.furlpayGateway)
      : "furlpayGateway must be a valid https:// URL.",
  });
}

export function validateConfig(cfg: FurlPayConfig): ConfigValidationResult {
  const checks: ConfigCheck[] = [];

  // -- network ------------------------------------------------------------
  const activeProfile = cfg.network?.activeProfile;
  const profileOk = activeProfile === "mainnet" || activeProfile === "testnet";
  checks.push({
    name: "network.activeProfile",
    ok: profileOk,
    severity: "error",
    detail: profileOk
      ? `active profile: ${activeProfile}`
      : `must be "mainnet" or "testnet", got ${JSON.stringify(activeProfile)}.`,
  });

  checkNetworkProfile(cfg, "mainnet", checks);
  checkNetworkProfile(cfg, "testnet", checks);

  // -- wallet -------------------------------------------------------------
  const keyring = cfg.wallet?.keyringBackend;
  const keyringOk = typeof keyring === "string" && (KEYRING_BACKENDS as readonly string[]).includes(keyring);
  checks.push({
    name: "wallet.keyringBackend",
    ok: keyringOk,
    severity: "error",
    detail: keyringOk
      ? String(keyring)
      : `must be one of ${KEYRING_BACKENDS.join(", ")}.`,
  });
  if (keyring === "memory") {
    checks.push({
      name: "wallet.keyringBackend.memoryWarning",
      ok: false,
      severity: "warning",
      detail:
        'keyring backend "memory" does not persist keys — every process start requires re-import. Use "os_keychain" or "encrypted_file".',
    });
  }

  const autoLock = cfg.wallet?.autoLockMinutes;
  checks.push({
    name: "wallet.autoLockMinutes",
    ok: isFiniteNumber(autoLock) && autoLock > 0 && autoLock <= 60 * 24,
    severity: "warning",
    detail:
      isFiniteNumber(autoLock) && autoLock > 0 && autoLock <= 60 * 24
        ? `${autoLock} min`
        : "should be a positive number of minutes (≤ 1440).",
  });

  // -- trading ------------------------------------------------------------
  const slippage = cfg.trading?.defaultSlippagePct;
  checks.push({
    name: "trading.defaultSlippagePct",
    ok: isFiniteNumber(slippage) && slippage > 0 && slippage <= 50,
    severity: "error",
    detail:
      isFiniteNumber(slippage) && slippage > 0 && slippage <= 50
        ? `${slippage}%`
        : "must be a number in (0, 50] — 0 or negative disables slippage protection; absurd values silently defeat it.",
  });

  const maxImpact = cfg.trading?.maxPriceImpactPct;
  checks.push({
    name: "trading.maxPriceImpactPct",
    ok: isFiniteNumber(maxImpact) && maxImpact > 0 && maxImpact <= 100,
    severity: "error",
    detail:
      isFiniteNumber(maxImpact) && maxImpact > 0 && maxImpact <= 100
        ? `${maxImpact}%`
        : "must be a number in (0, 100].",
  });

  // -- agent trust --------------------------------------------------------
  const singleTx = cfg.agent_trust?.maxSingleTxUsd;
  const dailyCap = cfg.agent_trust?.dailyVelocityCapUsd;
  checks.push({
    name: "agent_trust.maxSingleTxUsd",
    ok: isFiniteNumber(singleTx) && singleTx > 0,
    severity: "error",
    detail: isFiniteNumber(singleTx) && singleTx > 0 ? `$${singleTx}` : "must be a positive number.",
  });
  checks.push({
    name: "agent_trust.dailyVelocityCapUsd",
    ok: isFiniteNumber(dailyCap) && dailyCap > 0,
    severity: "error",
    detail: isFiniteNumber(dailyCap) && dailyCap > 0 ? `$${dailyCap}` : "must be a positive number.",
  });
  checks.push({
    name: "agent_trust.singleTxWithinDailyCap",
    ok: isFiniteNumber(singleTx) && isFiniteNumber(dailyCap) && singleTx <= dailyCap,
    severity: "error",
    detail:
      isFiniteNumber(singleTx) && isFiniteNumber(dailyCap) && singleTx <= dailyCap
        ? `$${singleTx} ≤ $${dailyCap}`
        : "maxSingleTxUsd exceeds dailyVelocityCapUsd — the per-transaction cap is unenforceable.",
  });

  const anomaly = cfg.agent_trust?.anomalyThreshold;
  checks.push({
    name: "agent_trust.anomalyThreshold",
    ok: isFiniteNumber(anomaly) && anomaly > 0 && anomaly <= 1,
    severity: "error",
    detail:
      isFiniteNumber(anomaly) && anomaly > 0 && anomaly <= 1
        ? String(anomaly)
        : "must be a number in (0, 1].",
  });

  // -- ui ------------------------------------------------------------------
  const refresh = cfg.ui?.refreshIntervalMs;
  checks.push({
    name: "ui.refreshIntervalMs",
    ok: isFiniteNumber(refresh) && refresh >= 100,
    severity: "warning",
    detail:
      isFiniteNumber(refresh) && refresh >= 100
        ? `${refresh} ms`
        : "should be ≥ 100 ms — lower values busy-loop the terminal.",
  });

  const errors = checks.filter((c) => c.severity === "error" && !c.ok);
  return { valid: errors.length === 0, checks };
}

/**
 * Mainnet readiness gate (mainnet-readiness project, 2026-11-17).
 *
 * Read-only. Nothing here signs, submits, or moves anything. Three surfaces:
 *
 *   readiness — every prerequisite for CONTROLLED mainnet execution, each
 *               labeled PASS / FAIL / BLOCKED / NOT_VERIFIED with evidence.
 *               Verdict "ready" requires every execution-blocking check to be
 *               PASS — a NOT_VERIFIED blocking check is still not-ready
 *               ("not enabled" is not "ready").
 *   status    — environment snapshot: which network each surface targets,
 *               which are read-only vs mutating vs simulated.
 *   dry-run   — a hypothetical order pushed through the REAL pre-trade risk
 *               engine (metadata, book, peg, margin, caps) with the exchange
 *               response shape shown, and a loud NOT SIGNED / NOT SUBMITTED.
 *               A dry run never signs, never submits, never records turnover.
 *
 * Semantics this module is strict about:
 * - FAIL   = configured but broken (blocks execution).
 * - BLOCKED = a safety condition cannot be established right now (blocks).
 * - NOT_VERIFIED = absent/optional prerequisite (blocks when it is required).
 * - Evidence is data (latency, counts, medians) — never secret values.
 */

import { loadConfig } from "../config";
import { validateConfig } from "../config/validate";
import { HyperliquidClient } from "../hyperliquid/client";
import { UsdcPegFeed } from "../hyperliquid/peg-feed";
import { OraclePriceAggregator } from "../oracles/aggregator";
import { SolanaRpcClient } from "../solana/rpc";
import {
  HyperliquidRiskEngine,
  defaultTurnoverLedgerPath,
} from "../hyperliquid/risk-engine";
import { AgentKeyService } from "../wallet/agentKey";
import { ledgerDir } from "../services/persistentLedger";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";

export type CheckStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_VERIFIED";

export interface MainnetCheck {
  id: string;
  area: string;
  title: string;
  status: CheckStatus;
  /** Human-readable evidence. Never contains secret values. */
  detail: string;
  /** FAIL/BLOCKED/NOT_VERIFIED on a blocking check makes the verdict not-ready. */
  blocksExecution: boolean;
}

export interface MainnetReadinessReport {
  command: "mainnet readiness";
  generatedAt: string;
  verdict: "ready" | "not-ready";
  summary: { pass: number; fail: number; blocked: number; notVerified: number; total: number };
  checks: MainnetCheck[];
}

export interface MainnetGateDeps {
  fetchImpl?: typeof fetch;
  /** Timeout per network probe (ms). */
  timeoutMs?: number;
  /** Risk engine turnover ledger path (tests use temp dirs). */
  turnoverLedgerPath?: string;
  /** HLP lockup ledger path (tests use temp dirs). */
  lockupLedgerPath?: string;
}

const HTTPS_OK = /^https:\/\//;

function classify(results: MainnetCheck[]): MainnetReadinessReport {
  const summary = {
    pass: results.filter((c) => c.status === "PASS").length,
    fail: results.filter((c) => c.status === "FAIL").length,
    blocked: results.filter((c) => c.status === "BLOCKED").length,
    notVerified: results.filter((c) => c.status === "NOT_VERIFIED").length,
    total: results.length,
  };
  const blockingBad = results.some(
    (c) => c.blocksExecution && (c.status === "FAIL" || c.status === "BLOCKED" || c.status === "NOT_VERIFIED")
  );
  return {
    command: "mainnet readiness",
    generatedAt: new Date().toISOString(),
    verdict: blockingBad ? "not-ready" : "ready",
    summary,
    checks: results,
  };
}

/** Probe helper: resolves to {ok, latencyMs, data?} or {ok:false, error}. Never throws. */
async function probe<T>(fn: () => Promise<T>): Promise<{ ok: true; latencyMs: number; data: T } | { ok: false; error: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const data = await fn();
    return { ok: true, latencyMs: Date.now() - start, data };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: String(err?.message ?? err).slice(0, 200) };
  }
}

export class MainnetGate {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly turnoverLedgerPath: string;
  private readonly lockupLedgerPath: string;

  constructor(deps: MainnetGateDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? 6_000;
    this.turnoverLedgerPath = deps.turnoverLedgerPath ?? defaultTurnoverLedgerPath();
    this.lockupLedgerPath = deps.lockupLedgerPath ?? join(ledgerDir(), "hlp-lockup.json");
  }

  /** All readiness checks. Network probes run in parallel; one outage never blanks the report. */
  async readiness(): Promise<MainnetReadinessReport> {
    const env = process.env;
    const results: MainnetCheck[] = [];

    // 1. Runtime
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const nodeMinor = Number(process.versions.node.split(".")[1]);
    const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
    results.push({
      id: "runtime.node",
      area: "runtime",
      title: "Node.js ≥ 22.19.0",
      status: nodeOk ? "PASS" : "FAIL",
      detail: `running Node ${process.versions.node}`,
      blocksExecution: true,
    });

    // 2. Local config structure
    const cfg = loadConfig();
    const cfgCheck = validateConfig(cfg);
    const cfgErrors = cfgCheck.checks.filter((c) => c.severity === "error" && !c.ok);
    results.push({
      id: "config.validate",
      area: "config",
      title: "Local config structural validation",
      status: cfgCheck.valid ? "PASS" : "FAIL",
      detail: cfgCheck.valid
        ? `${cfgCheck.checks.length} structural checks passed`
        : `${cfgErrors.length} error(s): ${cfgErrors.map((c) => c.detail.slice(0, 120)).join("; ").slice(0, 400)}`,
      blocksExecution: true,
    });

    // 3. Live master gate
    const liveGate = env.FURLPAY_LIVE === "1";
    results.push({
      id: "gate.live-master",
      area: "gate",
      title: "FURLPAY_LIVE master gate",
      status: liveGate ? "PASS" : "NOT_VERIFIED",
      detail: liveGate
        ? "enabled — signing surfaces may execute (each still behind its own credential + risk checks)"
        : "not enabled — every signing surface stays inert (assertLiveAllowed refuses); required before any execution",
      blocksExecution: true,
    });

    // 4. Hyperliquid signer presence (never printed)
    const hlKey = (env.HYPERLIQUID_PRIVATE_KEY || env.ETH_PRIVATE_KEY || "").trim();
    results.push({
      id: "hyperliquid.signer",
      area: "hyperliquid",
      title: "Hyperliquid signer configured",
      status: hlKey ? "PASS" : "NOT_VERIFIED",
      detail: hlKey
        ? "signer key present in environment (value never displayed)"
        : "HYPERLIQUID_PRIVATE_KEY / ETH_PRIVATE_KEY unset — orders, HLP transfers and the kill-switch fail closed",
      blocksExecution: true,
    });

    // 5. Hyperliquid mainnet /info reachability (read-only)
    const hlClient = new HyperliquidClient("mainnet", { fetchImpl: this.fetchImpl as any });
    const metaProbe = await probe(() => hlClient.getAllMids());
    results.push({
      id: "hyperliquid.mainnet-info",
      area: "hyperliquid",
      title: "Hyperliquid mainnet /info reachability",
      status: metaProbe.ok ? "PASS" : "FAIL",
      detail: metaProbe.ok
        ? `meta answered in ${metaProbe.latencyMs}ms (${Object.keys(metaProbe.data).length} mid prices)`
        : `mainnet /info unreachable in ${metaProbe.latencyMs}ms: ${metaProbe.error}`,
      blocksExecution: true,
    });

    // 6. USDC peg feed — a safety condition, not a convenience
    const peg = new UsdcPegFeed({ fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    const pegProbe = await probe(() => peg.fetchReadings());
    if (pegProbe.ok && pegProbe.data.length > 0) {
      const median = pegProbe.data.map((r) => r.priceUsd).sort((a, b) => a - b);
      const mid = median.length % 2 ? median[(median.length - 1) / 2] : (median[median.length / 2 - 1] + median[median.length / 2]) / 2;
      const driftBps = Math.abs((mid - 1) * 10_000);
      results.push({
        id: "hyperliquid.peg-feed",
        area: "hyperliquid",
        title: "USDC/USD peg feed sanity",
        status: driftBps > 25 ? "BLOCKED" : "PASS",
        detail: `${pegProbe.data.length} source(s) answered in ${pegProbe.latencyMs}ms; median $${mid.toFixed(4)} (${driftBps.toFixed(1)} bps from peg)`,
        blocksExecution: true,
      });
    } else {
      results.push({
        id: "hyperliquid.peg-feed",
        area: "hyperliquid",
        title: "USDC/USD peg feed sanity",
        status: "BLOCKED",
        detail: "no source answered sanely — the peg guard cannot establish its safety condition; the risk engine will refuse risk-increasing orders",
        blocksExecution: true,
      });
    }

    // 7. Oracle cross-source agreement (informational family, same safety spirit)
    const oracle = new OraclePriceAggregator({ fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
    const oracleQuote = await probe(() => oracle.getQuote("USDC"));
    if (oracleQuote.ok) {
      const q = oracleQuote.data;
      results.push({
        id: "oracle.agreement",
        area: "oracle",
        title: "Oracle cross-source agreement (USDC)",
        status: q.status === "LIVE" ? "PASS" : q.status === "DISAGREEMENT" ? "BLOCKED" : "NOT_VERIFIED",
        detail:
          q.status === "LIVE"
            ? `median $${q.priceUsd?.toFixed(4)} across ${q.readings.length} agreeing source(s)`
            : q.status === "DISAGREEMENT"
              ? `sources disagree beyond ±${q.maxDeviationPct}% (${q.readings.map((r) => r.source).join(", ")}) — no blended price exists`
              : "no source answered",
        blocksExecution: false,
      });
    }

    // 8. Stellar Horizon (read-only lookups family)
    const horizonUrl = (process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org").trim();
    if (HTTPS_OK.test(horizonUrl)) {
      const hProbe = await probe(async () => {
        const res = await this.fetchImpl(`${horizonUrl}/ledgers?order=desc&limit=1`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ _embedded?: { records?: Array<{ sequence?: number }> } }>;
      });
      results.push({
        id: "networks.horizon",
        area: "networks",
        title: "Stellar Horizon reachability (tx verify / faucet family)",
        status: hProbe.ok ? "PASS" : "FAIL",
        detail: hProbe.ok
          ? `latest ledger sequence ${hProbe.data._embedded?.records?.[0]?.sequence ?? "unknown"} (${hProbe.latencyMs}ms)`
          : `unreachable: ${hProbe.error}`,
        blocksExecution: false,
      });
    } else {
      results.push({
        id: "networks.horizon",
        area: "networks",
        title: "Stellar Horizon reachability",
        status: "FAIL",
        detail: `STELLAR_HORIZON_URL must be https (got "${horizonUrl.slice(0, 12)}…")`,
        blocksExecution: false,
      });
    }

    // 9. Solana RPC (read-only family)
    try {
      const sol = new SolanaRpcClient({ fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
      const solProbe = await probe(() => sol.getEpochInfo());
      results.push({
        id: "networks.solana",
        area: "networks",
        title: "Solana RPC reachability (read-only surface)",
        status: solProbe.ok ? "PASS" : "FAIL",
        detail: solProbe.ok
          ? `epoch ${solProbe.data.epoch}, slot ${solProbe.data.absoluteSlot} (${solProbe.latencyMs}ms)`
          : `unreachable: ${solProbe.error}`,
        blocksExecution: false,
      });
    } catch (err: any) {
      results.push({
        id: "networks.solana",
        area: "networks",
        title: "Solana RPC reachability",
        status: "FAIL",
        detail: String(err?.message ?? err).slice(0, 160),
        blocksExecution: false,
      });
    }

    // 10. Risk limits (always resolvable — defaults exist)
    const riskEngine = new HyperliquidRiskEngine(undefined, { turnoverLedgerPath: this.turnoverLedgerPath });
    const lim = riskEngine.getLimits();
    results.push({
      id: "risk.limits",
      area: "risk",
      title: "Pre-trade risk limits configured",
      status: "PASS",
      detail: `max single $${lim.maxSingleOrderUsd.toLocaleString()} · daily turnover $${lim.dailyTurnoverCapUsd.toLocaleString()} · max leverage ${lim.maxLeverage}x · fat-finger ${lim.maxFatFingerPct}% — tune with "furlpay trading limits"`,
      blocksExecution: true,
    });

    // 11. Durable ledgers writable
    const probePath = join(ledgerDir(), `readiness-probe-${Date.now()}.tmp`);
    const storage = await probe(async () => {
      writeFileSync(probePath, "readiness", { flag: "w" });
      rmSync(probePath, { force: true });
      return true;
    });
    results.push({
      id: "storage.ledgers",
      area: "storage",
      title: "Local ledger directory writable",
      status: storage.ok ? "PASS" : "FAIL",
      detail: storage.ok ? `${ledgerDir()} writable (atomic-write probe cleaned up)` : `write probe failed: ${storage.error}`,
      blocksExecution: true,
    });

    // 12. Binance credentials (optional surface)
    const binanceSet = Boolean((env.BINANCE_API_KEY || "").trim() && (env.BINANCE_API_SECRET || "").trim());
    const binanceEnv = env.FURLPAY_BINANCE_ENV?.trim() || "testnet";
    results.push({
      id: "binance.credentials",
      area: "binance",
      title: "Binance spot credentials (optional surface)",
      status: binanceSet ? "PASS" : "NOT_VERIFIED",
      detail: binanceSet
        ? `credentials present (never displayed); FURLPAY_BINANCE_ENV=${binanceEnv} — withdrawals are structurally absent from the adapter`
        : "BINANCE_API_KEY/SECRET unset — the Binance surface stays unavailable (optional)",
      blocksExecution: false,
    });

    // 13. MCP execution policy (informational)
    let policyDetail = "no agent policies configured — MCP execution mode refuses to start (exit 47) by design";
    let policyStatus: CheckStatus = "NOT_VERIFIED";
    try {
      const agentKeys = new AgentKeyService();
      const anyPolicy = agentKeys.listAgentKeys().some((k) => !k.revoked);
      if (anyPolicy) {
        policyStatus = "PASS";
        policyDetail = "agent policy files present (names not enumerated here)";
      }
    } catch {
      policyDetail = "agent policy directory unreadable — MCP execution stays fail-closed";
    }
    results.push({
      id: "mcp.policy",
      area: "mcp",
      title: "MCP agent policy presence (informational)",
      status: policyStatus,
      detail: policyDetail,
      blocksExecution: false,
    });

    return classify(results);
  }

  /** Environment snapshot: network, capability, and read/mutate classification per family. */
  status(): {
    command: "mainnet status";
    generatedAt: string;
    masterGate: { enabled: boolean; note: string };
    surfaces: Array<{ family: string; network: string; mode: string; status: string }>;
  } {
    const env = process.env;
    const hlTestnet = env.FURLPAY_HL_TESTNET === "1";
    const binanceEnv = env.FURLPAY_BINANCE_ENV?.trim() || "testnet";
    return {
      command: "mainnet status",
      generatedAt: new Date().toISOString(),
      masterGate: {
        enabled: env.FURLPAY_LIVE === "1",
        note: env.FURLPAY_LIVE === "1"
          ? "signing surfaces may execute behind their own credentials and risk checks"
          : "signing surfaces are inert (assertLiveAllowed refuses everything)",
      },
      surfaces: [
        { family: "Hyperliquid perps / HLP", network: hlTestnet ? "testnet (FURLPAY_HL_TESTNET=1)" : "mainnet", mode: "mutating (signed)", status: "LIVE" },
        { family: "Hyperliquid market data", network: hlTestnet ? "testnet" : "mainnet", mode: "read-only", status: "LIVE" },
        { family: "Oracle quotes", network: "public price sources", mode: "read-only", status: "LIVE" },
        { family: "Solana", network: env.SOLANA_RPC_URL?.trim() || "mainnet-beta (public RPC)", mode: "read-only (no signing path exists)", status: "LIVE (read-only)" },
        { family: "Stellar tx verify / faucet", network: env.STELLAR_HORIZON_URL?.trim() || "mainnet horizon", mode: "read-only / testnet funding", status: "LIVE (lookup)" },
        { family: "Stellar SDEX / Soroban", network: "local simulation", mode: "simulated — nothing broadcast", status: "SIMULATED" },
        { family: "Binance spot", network: binanceEnv === "mainnet" ? "mainnet (explicit)" : "testnet.binance.vision", mode: "mutating (signed, gated)", status: "IMPLEMENTED, TESTNET-BLOCKED" },
        { family: "x402 settlement", network: "local", mode: "simulated settlement", status: "SIMULATED" },
        { family: "Escrow (ETSS)", network: "local ledger", mode: "local state machine", status: "LOCAL" },
        { family: "Finance ledger", network: "local ledger", mode: "local double-entry", status: "LOCAL" },
        { family: "MCP servers", network: "stdio", mode: "read-only default; two-phase when enabled", status: "LIVE (tooling)" },
        { family: "Quant engines", network: "offline", mode: "analysis only — plans never placed", status: "IMPLEMENTED (offline)" },
      ],
    };
  }

  /**
   * Dry-run: push a hypothetical order through the REAL pre-trade risk
   * engine. Fetches live metadata + book + (optionally) account state — all
   * read-only — and evaluates the caps, fat-finger, peg and margin checks.
   * NEVER signs, NEVER submits, NEVER records turnover consumption.
   */
  async dryRun(params: {
    coin: string;
    side: "buy" | "sell";
    size: number;
    leverage: number;
    userAddress?: string;
  }): Promise<{
    command: "mainnet dry-run";
    generatedAt: string;
    order: { coin: string; side: string; size: number; leverage: number; limitPrice: string | null };
    evaluated: boolean;
    risk: { passed: boolean; reason?: string; warnings?: string[] };
    notSigned: true;
    notSubmitted: true;
  }> {
    const client = new HyperliquidClient("mainnet", { fetchImpl: this.fetchImpl as any });
    const riskEngine = new HyperliquidRiskEngine(undefined, { turnoverLedgerPath: this.turnoverLedgerPath });
    const meta = await client.getAssetMeta(params.coin);
    const book = await client.getL2Book(params.coin);
    const mid = (Number(book.levels[0][0]?.px) + Number(book.levels[1][0]?.px)) / 2;
    if (!Number.isFinite(mid)) {
      throw new Error(`DRY_RUN_NO_MARKET: no valid mid for ${params.coin} — refusing to evaluate against a broken book.`);
    }
    // Reference price = mid; a dry run never invents a limit price the user did not state.
    const check = await riskEngine.evaluatePreTrade({
      coin: params.coin,
      side: params.side,
      size: params.size,
      price: mid,
      leverage: params.leverage,
      client,
    });
    return {
      command: "mainnet dry-run",
      generatedAt: new Date().toISOString(),
      order: {
        coin: params.coin,
        side: params.side,
        size: params.size,
        leverage: params.leverage,
        limitPrice: null,
      },
      evaluated: true,
      risk: { passed: check.passed, reason: check.reason, warnings: (check as { riskWarnings?: string[] }).riskWarnings },
      notSigned: true,
      notSubmitted: true,
    };
  }
}

/**
 * Hyperliquidity Provider (HLP) Vault Management Service
 * 
 * Production integration with Hyperliquid's native backstop liquidity vault:
 * - Live vault state, equity, and APR from the /info validator network.
 * - Authenticated vault deposits & withdrawals signed via EIP-712 Phantom Agent.
 * - Enforcement of the mandatory 4-day (345,600 second) capital withdrawal lockup rule.
 * - STRICT POLICY: Zero fabricated transaction hashes in production execution paths.
 */

import { HlpVaultInfo, HlpDepositResult } from "../types";
import { HyperliquidClient } from "./client";
import { HyperliquidSigner } from "./signer";
import { HyperliquidNetwork, HyperliquidVaultDetails } from "./types";
import { DecimalMath } from "../precision/decimal-math";
import { assertLiveAllowed } from "../capabilities/registry";
import { ledgerDir, withLedgerLock, readLedger, writeLedger } from "../services/persistentLedger";
import { join } from "path";

interface HlpLockupStore {
  schema: "furlpay-hlp-lockup-v1";
  /** signer address (lowercase) → last successful deposit timestamp (ms). */
  lastDepositMs: Record<string, number>;
}

/**
 * Hyperliquid's vaultTransfer wire field is INTEGER micro-USDC (1e6 scale —
 * the same unit as ERC-20 6-decimal USDC), never a float. `usd: 50` on the
 * wire means $0.00005, not $50 (mainnet-readiness audit Gap 2). Convert here,
 * once, and refuse anything unrepresentable instead of silently rounding:
 * a silently-rounded deposit moves different money than the user asked to move.
 */
function toWireMicroUsd(amountUsd: number, kind: "deposit" | "withdrawal"): number {
  if (!Number.isFinite(amountUsd)) {
    throw new Error(`HLP ${kind} amount must be a finite number (got ${amountUsd}).`);
  }
  if (amountUsd <= 0) {
    throw new Error(`HLP ${kind} amount must be positive.`);
  }
  const asStr = String(amountUsd);
  const decimals = asStr.includes(".") ? asStr.split(".")[1].length : 0;
  if (decimals > DecimalMath.USDC_DECIMALS) {
    throw new Error(
      `HLP ${kind} amount has more than ${DecimalMath.USDC_DECIMALS} decimal places ` +
        `(${asStr}); sub-micro-cent amounts cannot be represented on the Hyperliquid wire. ` +
        `Round to a 6-decimal value and retry.`
    );
  }
  const micro = DecimalMath.parseUnits(asStr, DecimalMath.USDC_DECIMALS);
  // Absurdity bound, not a policy cap: protects against unit-conversion bugs
  // producing a billion-dollar transfer from a typo. Policy caps are the risk
  // engine's job.
  if (micro > 100_000_000_000_000n) {
    throw new Error(`HLP ${kind} amount exceeds the $100,000,000 per-transfer sanity bound.`);
  }
  const wire = Number(micro);
  if (!Number.isSafeInteger(wire)) {
    throw new Error(`HLP ${kind} amount does not convert to a safe integer micro-USDC value.`);
  }
  return wire;
}

export class HlpVaultService {
  private client: HyperliquidClient;
  private signer: HyperliquidSigner | null = null;
  private vaultAddress = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"; // Canonical HLP Vault Address
  private readonly LOCKUP_PERIOD_MS = 4 * 24 * 60 * 60 * 1000; // 4-day protocol lockup
  /** Lockup ledger path (external audit 2026-11-17b H-04): the 4-day rule
   *  is enforced from PERSISTED deposit timestamps — in-memory state dies
   *  with the process and never protected a cross-invocation withdrawal. */
  private readonly lockupLedgerPath = join(ledgerDir(), "hlp-lockup.json");

  constructor(network: HyperliquidNetwork = "mainnet", signer?: HyperliquidSigner) {
    this.client = new HyperliquidClient(network);
    if (signer) {
      this.signer = signer;
    } else {
      const key = process.env.HYPERLIQUID_PRIVATE_KEY || process.env.ETH_PRIVATE_KEY;
      if (key) {
        this.signer = new HyperliquidSigner(key, network === "testnet");
      }
    }
  }

  setSigner(signer: HyperliquidSigner): void {
    this.signer = signer;
  }

  /** Record a successful deposit's timestamp for the lockup clock (H-04). */
  private recordDepositForLockup(signerAddress: string, atMs = Date.now()): void {
    withLedgerLock(this.lockupLedgerPath, () => {
      const store = readLedger<HlpLockupStore>(this.lockupLedgerPath) ?? {
        schema: "furlpay-hlp-lockup-v1",
        lastDepositMs: {},
      };
      store.lastDepositMs[signerAddress.toLowerCase()] = atMs;
      writeLedger(this.lockupLedgerPath, store);
    });
  }

  /**
   * Client-side 4-day lockup enforcement (external audit 2026-11-17b H-04):
   * refuse to even SIGN a premature withdrawal. The exchange enforces its
   * own lockup; this is the client's own guardrail — fail closed when the
   * ledger is unreadable rather than guessing.
   */
  private assertWithdrawalUnlocked(signerAddress: string): void {
    const store = withLedgerLock(this.lockupLedgerPath, () =>
      readLedger<HlpLockupStore>(this.lockupLedgerPath)
    );
    if (!store) {
      // No deposit on record through this client: nothing to enforce.
      return;
    }
    const last = store.lastDepositMs[signerAddress.toLowerCase()];
    if (last === undefined) return;
    const unlockAt = last + this.LOCKUP_PERIOD_MS;
    if (Date.now() < unlockAt) {
      const remainingMs = unlockAt - Date.now();
      const hours = Math.ceil(remainingMs / 3_600_000);
      throw new Error(
        `HLP_LOCKUP_ACTIVE: last deposit was ${new Date(last).toISOString()}; the 4-day withdrawal ` +
          `lockup lifts at ${new Date(unlockAt).toISOString()} (~${hours}h remaining). ` +
          `Refusing to sign a premature vaultTransfer.`
      );
    }
  }

  getVaultAddress(): string {
    return this.vaultAddress;
  }

  /**
   * Query real-time metrics for the community HLP liquidity vault from Hyperliquid validators.
   *
   * Data provenance (2026-11-12 audit P1 #7): every figure is derived from the
   * live /info response or reported as null. No benchmark/benchmark fallbacks —
   * a fabricated equity, APY, share price, or PnL previously shipped here.
   */
  async getHlpStats(userAddress?: string): Promise<HlpVaultInfo & { rawVault: HyperliquidVaultDetails }> {
    const vault = await this.client.getVaultDetails(this.vaultAddress, userAddress);

    // Live equity: latest account value from the vault portfolio history.
    let totalEquityUsd: number | null = null;
    // Live all-time PnL: latest cumulative PnL point from the portfolio history.
    let allTimePnlUsd: number | null = null;

    if (vault.portfolio && Array.isArray(vault.portfolio)) {
      for (const period of ["allTime", "month", "day"] as const) {
        const slice = vault.portfolio.find((p: any) => p[0] === period);
        if (!slice || !slice[1]) continue;
        if (totalEquityUsd === null && Array.isArray(slice[1].accountValueHistory) && slice[1].accountValueHistory.length) {
          const hist = slice[1].accountValueHistory;
          const latest = parseFloat(hist[hist.length - 1][1]);
          if (isFinite(latest) && latest > 0) totalEquityUsd = latest;
        }
        if (allTimePnlUsd === null && period === "allTime" && Array.isArray(slice[1].pnlHistory) && slice[1].pnlHistory.length) {
          const pnlHist = slice[1].pnlHistory;
          const latestPnl = parseFloat(pnlHist[pnlHist.length - 1][1]);
          if (isFinite(latestPnl)) allTimePnlUsd = latestPnl;
        }
        if (totalEquityUsd !== null) break;
      }
    }

    // Live APY: only from the vault's own reported APR. The previous 28.5%
    // "benchmark" fallback fabricated performance data and was removed.
    const rawApr = typeof vault.apr === "number" && isFinite(vault.apr) ? vault.apr : null;
    const aprFraction = rawApr === null ? undefined : Number(rawApr.toFixed(6));
    const aprPercent = rawApr === null ? undefined : Number((rawApr * 100).toFixed(4));
    const trailingApyPct: number | null = rawApr === null ? null : Number((rawApr * 100).toFixed(2));

    return {
      vaultAddress: this.vaultAddress,
      totalEquityUsd: totalEquityUsd === null ? null : Number(totalEquityUsd.toFixed(2)),
      // Share price (NAV/share) is not part of the public vaultDetails payload.
      // The old hardcoded 1.4285 was removed — callers must treat it as
      // exchange-determined instead of a made-up normalized value.
      sharePriceUsd: null,
      aprFraction,
      aprPercent,
      trailing30dApyPct: trailingApyPct,
      allTimePnlUsd: allTimePnlUsd === null ? null : Number(allTimePnlUsd.toFixed(2)),
      // Open position count is not reported by public vaultDetails; the old
      // hardcoded 142 was removed.
      activePositionsCount: null,
      lockingPeriodSeconds: 345_600, // 4-day protocol lockup
      lockupNotice: "Mandatory 4-day (345,600s) withdrawal lockup enforced by Hyperliquid L1 protocol.",
      rawVault: vault,
    };
  }

  /**
   * Deposit USDC collateral into the HLP liquidity vault.
   * Prominently notifies user of the mandatory 4-day lock-up period before withdrawal is unlocked.
   */
  async deposit(
    amountUsd: number,
    overrideSigner?: HyperliquidSigner
  ): Promise<HlpDepositResult & { lockupExpiry: string }> {
    if (amountUsd <= 0) {
      throw new Error("HLP deposit amount must be positive.");
    }

    const activeSigner = overrideSigner || this.signer;
    if (!activeSigner) {
      throw new Error("No signer configured for HLP vault deposit. Provide private key or API wallet.");
    }

    const stats = await this.getHlpStats(activeSigner.getAddress());
    // The exchange computes actual minted shares at settlement; a client-side
    // estimate is only shown when a live share price is genuinely available.
    // Exact division via DecimalMath (no float in the estimate).
    const sharesMinted = stats.sharePriceUsd === null
      ? null
      : Number(
          DecimalMath.div(
            amountUsd,
            stats.sharePriceUsd,
            6
          )
        );

    const action = {
      type: "vaultTransfer",
      vaultAddress: this.vaultAddress,
      isDeposit: true,
      usd: toWireMicroUsd(amountUsd, "deposit"),
    };

    // Capability registry live gate (readiness P1) — signed value movement.
    assertLiveAllowed("hyperliquid.hlp-deposit");

    const nonce = Date.now();
    const signature = await activeSigner.signL1Action(action, nonce, this.vaultAddress);
    
    const res = await this.client.submitAction(action, signature, nonce, this.vaultAddress);
    // Fail closed: a CONFIRMED result requires the exchange's own transaction
    // hash. The old `hlp_dep_<nonce>` fallback fabricated an audit token for
    // a deposit the response never actually confirmed (audit P11).
    if (res?.status !== "ok") {
      throw new Error(`Hyperliquid HLP Error: Deposit was not accepted by the exchange (${JSON.stringify(res)})`);
    }
    const txHash = res?.response?.data?.txHash;
    if (!txHash || typeof txHash !== "string") {
      throw new Error(
        "Hyperliquid HLP Error: exchange accepted the vaultTransfer but returned no transaction hash — " +
          "deposit state is UNCONFIRMED. Query the vault/leaderboard directly before retrying; " +
          "retrying blindly risks a double deposit."
      );
    }

    const lockupExpiry = new Date(Date.now() + this.LOCKUP_PERIOD_MS).toISOString();

    // Durable lockup clock starts HERE (external audit H-04): the confirmed
    // deposit is what the 4-day withdrawal guard will enforce against.
    this.recordDepositForLockup(activeSigner.getAddress());

    return {
      status: "CONFIRMED",
      txHash,
      amountDepositedUsd: amountUsd,
      sharesMinted,
      effectiveSharePrice: stats.sharePriceUsd,
      currentApyPct: stats.trailing30dApyPct,
      venue: "HYPERLIQUID_L1",
      lockupExpiry,
    };
  }

  /**
   * Withdraw unlocked capital from HLP vault.
   */
  async withdraw(
    amountUsd: number,
    overrideSigner?: HyperliquidSigner
  ): Promise<{ status: "CONFIRMED"; usdReceived: number; txHash: string }> {
    if (amountUsd <= 0) {
      throw new Error("HLP withdrawal amount must be positive.");
    }

    const activeSigner = overrideSigner || this.signer;
    if (!activeSigner) {
      throw new Error("No signer configured for HLP vault withdrawal.");
    }

    // Client-side lockup gate BEFORE signing (external audit H-04).
    this.assertWithdrawalUnlocked(activeSigner.getAddress());

    const action = {
      type: "vaultTransfer",
      vaultAddress: this.vaultAddress,
      isDeposit: false,
      usd: toWireMicroUsd(amountUsd, "withdrawal"),
    };

    // Capability registry live gate (readiness P1) — signed value movement.
    assertLiveAllowed("hyperliquid.hlp-withdraw");

    const nonce = Date.now();
    const signature = await activeSigner.signL1Action(action, nonce, this.vaultAddress);
    const res = await this.client.submitAction(action, signature, nonce, this.vaultAddress);
    // Fail closed — same contract as deposit: no exchange-issued hash means
    // no CONFIRMED status and never a synthetic `hlp_wd_` token (audit P11).
    if (res?.status !== "ok") {
      throw new Error(`Hyperliquid HLP Error: Withdrawal was not accepted by the exchange (${JSON.stringify(res)})`);
    }
    const txHash = res?.response?.data?.txHash;
    if (!txHash || typeof txHash !== "string") {
      throw new Error(
        "Hyperliquid HLP Error: exchange accepted the vaultTransfer but returned no transaction hash — " +
          "withdrawal state is UNCONFIRMED. Do not treat the withdrawal as complete."
      );
    }

    return {
      status: "CONFIRMED",
      usdReceived: amountUsd,
      txHash,
    };
  }
}

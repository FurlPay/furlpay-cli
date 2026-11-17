/**
 * Spend Controls — budget enforcement over the financial ledger.
 *
 * The Grok-Bot-inspired capability, adapted to FurlPay's reality: limits are
 * enforced against the LOCAL ledger of record, not a vendor's meter.
 *
 * Enforcement properties:
 * - Fail-closed: any internal error while evaluating a claim refuses the
 *   spend (the caller treats a thrown check as a refusal, never as a pass).
 * - Pending counts: authorized-but-not-settled movement consumes budget —
 *   money in flight is money spent until proven otherwise. Only FAILED /
 *   CANCELLED / REVERSED releases consumption.
 * - No bypass: the payment orchestrator (payments.ts) is the only writer of
 *   payment_* ledger transactions and it always runs this check first; MCP
 *   tools and CLI commands both go through the orchestrator, so no surface
 *   can move payment money without passing these limits.
 * - Windows: UTC day / ISO week / calendar month; totals are cumulative.
 */

import { readJsonStore, writeJsonStoreAtomic, financeDir } from "./store";
import { join } from "path";
import { FinancialLedger } from "./ledger";

export interface SpendLimits {
  /** Maximum cumulative spend, ever. Minor units. */
  totalMinor?: bigint;
  dailyMinor?: bigint;
  weeklyMinor?: bigint;
  monthlyMinor?: bigint;
  /** Scope keys are `${unit}` or `${unit}:${network}` — a limit binds to one unit. */
  perNetworkMinor?: Record<string, bigint>;
  perAssetMinor?: Record<string, bigint>;
  /** Per-counterparty (destination address/handle) caps. */
  perCounterpartyMinor?: Record<string, bigint>;
  /** Single-transaction ceiling. */
  perTransactionMinor?: bigint;
}

interface LimitsStore {
  schema: "furlpay-finance-spend-v1";
  limits: SpendLimits;
  updatedAt: string;
}

export interface SpendClaim {
  /** Minor units claimed. */
  minor: bigint;
  /** Unit (e.g. "USDC"); a network-qualified limit uses "unit:network". */
  unit: string;
  network?: string;
  counterparty?: string;
  /** When the claim is evaluated (injectable for tests). */
  nowMs?: number;
}

export interface SpendDecision {
  allowed: boolean;
  reason?: string;
  usage: {
    total: bigint;
    today: bigint;
    thisWeek: bigint;
    thisMonth: bigint;
    limits: SpendLimits;
  };
}

const ZERO = 0n;

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function startOfUtcWeek(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const dayStart = startOfUtcDay(ms);
  return dayStart - day * 86_400_000;
}
function startOfUtcMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export class SpendManager {
  private limits: SpendLimits = {};
  private readonly limitsPath: string;
  private readonly ledger: FinancialLedger;
  /** Consumption candidates are ledger transactions of these types, EXCLUDING voided states. */
  private static readonly CONSUMING_STATES = new Set(["CREATED", "PENDING", "AUTHORIZED", "SUBMITTED", "CONFIRMED", "SETTLED"]);

  constructor(ledger: FinancialLedger, limitsPath?: string) {
    this.ledger = ledger;
    this.limitsPath = limitsPath || join(financeDir(), "limits.json");
    const stored = readJsonStore<LimitsStore>(this.limitsPath);
    if (stored) {
      if (stored.schema !== "furlpay-finance-spend-v1") {
        throw new Error(`Spend limits file ${this.limitsPath} has an unrecognized format.`);
      }
      this.limits = this.revive(stored.limits);
    }
  }

  /** JSON revives bigint fields as strings — restore them. */
  private revive(l: SpendLimits): SpendLimits {
    const b = (v: unknown): bigint | undefined => (typeof v === "string" ? BigInt(v) : typeof v === "bigint" ? v : undefined);
    return {
      totalMinor: b(l.totalMinor),
      dailyMinor: b(l.dailyMinor),
      weeklyMinor: b(l.weeklyMinor),
      monthlyMinor: b(l.monthlyMinor),
      perTransactionMinor: b(l.perTransactionMinor),
      perNetworkMinor: l.perNetworkMinor ? Object.fromEntries(Object.entries(l.perNetworkMinor).map(([k, v]) => [k, BigInt(String(v))])) : undefined,
      perAssetMinor: l.perAssetMinor ? Object.fromEntries(Object.entries(l.perAssetMinor).map(([k, v]) => [k, BigInt(String(v))])) : undefined,
      perCounterpartyMinor: l.perCounterpartyMinor ? Object.fromEntries(Object.entries(l.perCounterpartyMinor).map(([k, v]) => [k, BigInt(String(v))])) : undefined,
    };
  }

  /** Validates and stores new limits. All values must be positive; 0 removes a limit. */
  setLimits(update: Partial<Record<keyof SpendLimits, bigint | Record<string, bigint>>>): SpendLimits {
    const pos = (v: bigint, name: string) => {
      if (v < 0n) throw new Error(`Spend limit ${name} cannot be negative.`);
    };
    for (const [k, v] of Object.entries(update)) {
      if (typeof v === "bigint" || typeof v === "number") pos(v as bigint, k);
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) pos(BigInt(vv), `${k}.${kk}`);
    }
    this.limits = { ...this.limits, ...(update as SpendLimits) };
    writeJsonStoreAtomic(this.limitsPath, {
      schema: "furlpay-finance-spend-v1",
      // JSON.stringify handles bigint by throwing — serialize as strings.
      limits: this.serialize(this.limits),
      updatedAt: new Date().toISOString(),
    });
    return this.limits;
  }

  private serialize(l: SpendLimits): Record<string, unknown> {
    const s = (v?: bigint) => (v === undefined ? undefined : v.toString());
    return {
      totalMinor: s(l.totalMinor),
      dailyMinor: s(l.dailyMinor),
      weeklyMinor: s(l.weeklyMinor),
      monthlyMinor: s(l.monthlyMinor),
      perTransactionMinor: s(l.perTransactionMinor),
      perNetworkMinor: l.perNetworkMinor ? Object.fromEntries(Object.entries(l.perNetworkMinor).map(([k, v]) => [k, v.toString()])) : undefined,
      perAssetMinor: l.perAssetMinor ? Object.fromEntries(Object.entries(l.perAssetMinor).map(([k, v]) => [k, v.toString()])) : undefined,
      perCounterpartyMinor: l.perCounterpartyMinor ? Object.fromEntries(Object.entries(l.perCounterpartyMinor).map(([k, v]) => [k, v.toString()])) : undefined,
    };
  }

  getLimits(): SpendLimits {
    return this.limits;
  }

  /**
   * Consumption of one scope unit in a window: sums the OUT-side of
   * payment_out / fee / treasury_transfer / refund ledger transactions whose
   * accounts are tagged with the unit. The ledger is the single source of
   * truth — spend state is never kept anywhere else (nothing to drift).
   */
  private consumed(unit: string, windowStartMs: number | null, counterparty?: string): bigint {
    let sum = ZERO;
    for (const tx of this.ledger.listTransactions()) {
      if (!SpendManager.CONSUMING_STATES.has(tx.state)) continue;
      if (windowStartMs !== null && Date.parse(tx.createdAt) < windowStartMs) continue;
      if (tx.type !== "payment_out" && tx.type !== "fee" && tx.type !== "treasury_transfer") continue;
      // OUT-side of a payment_out transaction = the debit on the source
      // (asset) account. For fee/transfer types all entries count via their
      // asset-side accounts. Filter by the account's unit.
      for (const e of tx.entries) {
        const acc = this.ledger.getAccount(e.accountId);
        if (!acc) continue;
        const accUnit = `${acc.unit}${acc.network ? ":" + acc.network : ""}`;
        const assetUnit = acc.unit;
        if (accUnit !== unit && assetUnit !== unit) continue;
        const debitPositive = acc.kind === "asset" || acc.kind === "expense";
        const isOut = (e.direction === "debit") === debitPositive && (tx.type === "payment_out" || tx.type === "fee");
        const isTransferOut = tx.type === "treasury_transfer" && (e.direction === "debit") === debitPositive;
        if (!isOut && !isTransferOut) continue;
        if (counterparty && e.note && e.note !== counterparty) continue;
        sum += e.minor;
      }
    }
    return sum;
  }

  /**
   * Usage snapshot for one unit — no claim evaluated. Read-only reporting
   * (CLI `spend show`, MCP furlpay_finance_spend).
   */
  usage(unit: string, nowMs: number = Date.now()): { total: bigint; today: bigint; thisWeek: bigint; thisMonth: bigint; limits: SpendLimits } {
    return {
      total: this.consumed(unit, null),
      today: this.consumed(unit, startOfUtcDay(nowMs)),
      thisWeek: this.consumed(unit, startOfUtcWeek(nowMs)),
      thisMonth: this.consumed(unit, startOfUtcMonth(nowMs)),
      limits: this.limits,
    };
  }

  /**
   * Evaluate a spend claim. Fail-closed: any internal inconsistency throws,
   * and the caller MUST treat a throw as a refusal.
   */
  check(claim: SpendClaim): SpendDecision {
    const nowMs = claim.nowMs ?? Date.now();
    const usage = {
      total: this.consumed(claim.unit, null),
      today: this.consumed(claim.unit, startOfUtcDay(nowMs)),
      thisWeek: this.consumed(claim.unit, startOfUtcWeek(nowMs)),
      thisMonth: this.consumed(claim.unit, startOfUtcMonth(nowMs)),
      limits: this.limits,
    };

    const deny = (reason: string): SpendDecision => ({ allowed: false, reason, usage });

    if (this.limits.perTransactionMinor !== undefined && claim.minor > this.limits.perTransactionMinor) {
      return deny(`Single-transaction limit ${this.limits.perTransactionMinor} minor exceeded by claim ${claim.minor} minor.`);
    }
    if (this.limits.totalMinor !== undefined && usage.total + claim.minor > this.limits.totalMinor) {
      return deny(`Total spend limit ${this.limits.totalMinor} minor would be breached (consumed ${usage.total}, claiming ${claim.minor}).`);
    }
    if (this.limits.dailyMinor !== undefined && usage.today + claim.minor > this.limits.dailyMinor) {
      return deny(`Daily spend limit ${this.limits.dailyMinor} minor would be breached (consumed today ${usage.today}, claiming ${claim.minor}).`);
    }
    if (this.limits.weeklyMinor !== undefined && usage.thisWeek + claim.minor > this.limits.weeklyMinor) {
      return deny(`Weekly spend limit ${this.limits.weeklyMinor} minor would be breached (consumed ${usage.thisWeek}, claiming ${claim.minor}).`);
    }
    if (this.limits.monthlyMinor !== undefined && usage.thisMonth + claim.minor > this.limits.monthlyMinor) {
      return deny(`Monthly spend limit ${this.limits.monthlyMinor} minor would be breached (consumed ${usage.thisMonth}, claiming ${claim.minor}).`);
    }
    const netKey = claim.network ? `${claim.unit}:${claim.network}` : undefined;
    if (netKey && this.limits.perNetworkMinor?.[netKey] !== undefined) {
      const c = this.consumed(netKey, null);
      if (c + claim.minor > this.limits.perNetworkMinor[netKey]) {
        return deny(`Network limit for ${netKey} would be breached (consumed ${c}, claiming ${claim.minor}).`);
      }
    }
    if (this.limits.perAssetMinor?.[claim.unit] !== undefined) {
      const c = this.consumed(claim.unit, null);
      if (c + claim.minor > this.limits.perAssetMinor[claim.unit]) {
        return deny(`Asset limit for ${claim.unit} would be breached (consumed ${c}, claiming ${claim.minor}).`);
      }
    }
    if (claim.counterparty && this.limits.perCounterpartyMinor?.[claim.counterparty] !== undefined) {
      const c = this.consumed(claim.unit, null, claim.counterparty);
      if (c + claim.minor > this.limits.perCounterpartyMinor[claim.counterparty]) {
        return deny(`Counterparty limit for ${claim.counterparty} would be breached (consumed ${c}, claiming ${claim.minor}).`);
      }
    }
    return { allowed: true, usage };
  }

  /** Breakdown by unit over a window — the `spend breakdown` report. */
  breakdown(windowStartMs: number | null = startOfUtcDay(Date.now())): Array<{ unit: string; minor: bigint; transactions: number }> {
    const byUnit = new Map<string, { minor: bigint; transactions: number }>();
    for (const tx of this.ledger.listTransactions()) {
      if (!SpendManager.CONSUMING_STATES.has(tx.state)) continue;
      if (tx.type !== "payment_out" && tx.type !== "fee" && tx.type !== "treasury_transfer") continue;
      if (windowStartMs !== null && Date.parse(tx.createdAt) < windowStartMs) continue;
      let unitSeen: string | null = null;
      for (const e of tx.entries) {
        const acc = this.ledger.getAccount(e.accountId);
        if (!acc) continue;
        const debitPositive = acc.kind === "asset" || acc.kind === "expense";
        const isOut = (e.direction === "debit") === debitPositive;
        if (!isOut) continue;
        unitSeen = acc.unit;
        const key = unitSeen;
        const cur = byUnit.get(key) ?? { minor: ZERO, transactions: 0 };
        cur.minor += e.minor;
        byUnit.set(key, cur);
      }
      if (unitSeen) {
        const cur = byUnit.get(unitSeen)!;
        cur.transactions += 1;
        byUnit.set(unitSeen, cur);
      }
    }
    return [...byUnit.entries()].map(([unit, v]) => ({ unit, ...v })).sort((a, b) => (a.minor > b.minor ? -1 : 1));
  }

  /** History: consuming transactions, newest first. */
  history(limit = 20): Array<{ id: string; type: string; state: string; minor: bigint; unit: string; at: string }> {
    return this.ledger
      .listTransactions()
      .filter((t) => ["payment_out", "fee", "treasury_transfer"].includes(t.type))
      .reverse()
      .slice(0, limit)
      .map((t) => {
        const outEntry = t.entries.find((e) => {
          const acc = this.ledger.getAccount(e.accountId);
          if (!acc) return false;
          const debitPositive = acc.kind === "asset" || acc.kind === "expense";
          return (e.direction === "debit") === debitPositive;
        });
        return { id: t.id, type: t.type, state: t.state, minor: outEntry?.minor ?? ZERO, unit: outEntry?.unit ?? "?", at: t.createdAt };
      });
  }
}

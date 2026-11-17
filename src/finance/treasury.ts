/**
 * Treasury — balance views and reconciliation derived from the ledger.
 *
 * Treasury state is never stored here; it is computed from the ledger every
 * time (single source of truth, nothing to drift). Balances distinguish:
 *   available   — SETTLED balance
 *   reserved    — committed-but-not-settled movement (authorized, pending,
 *                 submitted, confirmed all reserve until finality)
 * Definitions are honest: "reserved" is a local ledger view, not an on-chain
 * promise, and reconcile() reports only internal consistency.
 */

import { FinancialLedger, LedgerAccount } from "./ledger";

export interface TreasuryBalance {
  accountId: string;
  unit: string;
  network?: string;
  role?: string;
  availableMinor: bigint;
  reservedMinor: bigint;
  totalMinor: bigint;
}

export interface TreasuryStatus {
  balances: TreasuryBalance[];
  inflowMinorByUnit: Record<string, bigint>;
  outflowMinorByUnit: Record<string, bigint>;
  note: string;
}

export class TreasuryManager {
  constructor(private readonly ledger: FinancialLedger) {}

  private treasuryAccounts(): LedgerAccount[] {
    return this.ledger.listAccounts().filter((a) => a.kind === "asset" && (a.role === "operating" || a.role === "reserve" || a.role === "pending_settlement" || !a.role));
  }

  status(): TreasuryStatus {
    const balances: TreasuryBalance[] = this.treasuryAccounts().map((acc) => {
      const b = this.ledger.accountBalance(acc.id);
      return {
        accountId: acc.id,
        unit: acc.unit,
        network: acc.network,
        role: acc.role,
        availableMinor: b.settledMinor,
        reservedMinor: b.pendingMinor,
        totalMinor: b.totalMinor,
      };
    });
    const inflow: Record<string, bigint> = {};
    const outflow: Record<string, bigint> = {};
    for (const tx of this.ledger.listTransactions()) {
      if (tx.state === "FAILED" || tx.state === "CANCELLED" || tx.state === "REVERSED") continue;
      for (const e of tx.entries) {
        const acc = this.ledger.getAccount(e.accountId);
        if (!acc || acc.kind !== "asset") continue;
        const key = `${acc.unit}${acc.network ? ":" + acc.network : ""}`;
        // Asset inflow = debit (increases), outflow = credit (decreases).
        if (e.direction === "debit") inflow[key] = (inflow[key] ?? 0n) + e.minor;
        else outflow[key] = (outflow[key] ?? 0n) + e.minor;
      }
    }
    return {
      balances,
      inflowMinorByUnit: inflow,
      outflowMinorByUnit: outflow,
      note: "Balances are the local ledger of record. reconcile() proves internal consistency only — external on-chain reality is compared via `tx verify` / provider lookups, never asserted here.",
    };
  }

  /** Ledger-internal reconciliation (re-export with treasury framing). */
  reconcile() {
    return this.ledger.reconcile();
  }
}

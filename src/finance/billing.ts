/**
 * Billing & Financial Reporting — derived views over the ledger.
 *
 * Fee accounting distinguishes explicitly: `fee`-type transactions are
 * network/provider fees consumed from asset accounts — the reports never mix
 * them into transfer volume. Export is deterministic (sorted, stable column
 * order, CSV-escaped) so diffs of consecutive exports are meaningful.
 */

import { FinancialLedger, LedgerTransaction } from "./ledger";

export interface BillingSummary {
  windowStartIso?: string;
  volumeOutMinorByUnit: Record<string, bigint>;
  volumeInMinorByUnit: Record<string, bigint>;
  feesMinorByUnit: Record<string, bigint>;
  counts: Record<string, number>;
  failedCount: number;
  pendingCount: number;
  settledCount: number;
}

export class BillingManager {
  constructor(private readonly ledger: FinancialLedger) {}

  summary(windowStartIso?: string): BillingSummary {
    const txs = this.ledger.listTransactions({ sinceIso: windowStartIso }).filter(
      (t) => t.state !== "FAILED" && t.state !== "CANCELLED" && t.state !== "REVERSED"
    );
    const volOut: Record<string, bigint> = {};
    const volIn: Record<string, bigint> = {};
    const fees: Record<string, bigint> = {};
    const counts: Record<string, number> = {};
    let failed = 0, pending = 0, settled = 0;

    for (const tx of this.ledger.listTransactions({ sinceIso: windowStartIso })) {
      counts[tx.state] = (counts[tx.state] ?? 0) + 1;
      if (tx.state === "FAILED") failed++;
      if (["PENDING", "AUTHORIZED", "SUBMITTED"].includes(tx.state)) pending++;
      // Settled volume counts ONLY chain-verified settlements (readiness P23):
      // an operator-asserted hash is a claim, not proof, and never becomes
      // settled volume — even if stale persisted state somehow says SETTLED.
      if (tx.state === "SETTLED" && tx.evidenceLevel === "chain_verified") settled++;
      if (tx.type === "fee") {
        for (const e of tx.entries) {
          const acc = this.ledger.getAccount(e.accountId);
          if (acc?.kind === "asset" && e.direction === "credit") {
            const k = acc.unit;
            fees[k] = (fees[k] ?? 0n) + e.minor;
          }
        }
        continue;
      }
      const isPayment = tx.type === "payment_out" || tx.type === "payment_in";
      if (!isPayment) continue;
      for (const e of tx.entries) {
        const acc = this.ledger.getAccount(e.accountId);
        // Volume is measured on the ASSET side: money leaving an asset
        // account (credit) is outflow, arriving (debit) is inflow. The
        // expense/income counterpart books the "why", not the "how much".
        if (!acc || acc.kind !== "asset") continue;
        const k = acc.unit;
        if (tx.type === "payment_out" && e.direction === "credit") volOut[k] = (volOut[k] ?? 0n) + e.minor;
        if (tx.type === "payment_in" && e.direction === "debit") volIn[k] = (volIn[k] ?? 0n) + e.minor;
      }
    }
    return {
      windowStartIso,
      volumeOutMinorByUnit: volOut,
      volumeInMinorByUnit: volIn,
      feesMinorByUnit: fees,
      counts,
      failedCount: failed,
      pendingCount: pending,
      settledCount: settled,
    };
  }

  /** Deterministic CSV export of transactions. Stable columns, escaped values. */
  exportCsv(): string {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = "ledger_tx_id,seq,type,state,unit,network,minor,direction,tx_hash,created_at";
    const rows: string[] = [];
    for (const tx of this.ledger.listTransactions()) {
      for (const e of tx.entries) {
        const acc = this.ledger.getAccount(e.accountId);
        rows.push(
          [
            tx.id,
            String(tx.seq),
            tx.type,
            tx.state,
            e.unit,
            acc?.network ?? "",
            e.minor.toString(),
            e.direction,
            tx.txHash ?? "",
            tx.createdAt,
          ].map(esc).join(",")
        );
      }
    }
    return [header, ...rows].join("\n") + "\n";
  }

  /** Failed-payment report with decline-ish context from the audit trail. */
  failedPayments(limit = 20): LedgerTransaction[] {
    return this.ledger.listTransactions({ state: "FAILED" }).reverse().slice(0, limit);
  }

  pendingPayments(limit = 20): LedgerTransaction[] {
    return this.ledger
      .listTransactions()
      .filter((t) => ["PENDING", "AUTHORIZED", "SUBMITTED"].includes(t.state))
      .reverse()
      .slice(0, limit);
  }
}

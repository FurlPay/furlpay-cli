/**
 * Financial Operations Manager — the facade every surface (CLI, MCP) uses.
 *
 * One construction site for the whole layer with injectable paths so tests
 * run against temp directories. Guarantees the accounts a payment needs
 * exist (double-entry cannot post against unknown accounts), and emits
 * spend/approval events through the signed event bus.
 */

import { FinancialLedger } from "./ledger";
import { SpendManager } from "./spend";
import { ApprovalEngine } from "./approvals";
import { PaymentOrchestrator } from "./payments";
import { TreasuryManager } from "./treasury";
import { BillingManager } from "./billing";
import { FinancialEventBus } from "./events";

export interface FinanceManagerDeps {
  dir?: string;
  webhookUrl?: string;
}

export class FinanceManager {
  readonly ledger: FinancialLedger;
  readonly spend: SpendManager;
  readonly approvals: ApprovalEngine;
  readonly payments: PaymentOrchestrator;
  readonly treasury: TreasuryManager;
  readonly billing: BillingManager;
  readonly events: FinancialEventBus;

  constructor(deps: FinanceManagerDeps = {}) {
    const dir = deps.dir;
    const p = (f: string) => (dir ? `${dir}/${f}` : undefined);
    this.events = new FinancialEventBus({ journalPath: p("events.jsonl"), webhookUrl: deps.webhookUrl });
    this.ledger = new FinancialLedger(p("ledger.json"));
    this.spend = new SpendManager(this.ledger, p("limits.json"));
    this.approvals = new ApprovalEngine(p("approvals.json"));
    this.payments = new PaymentOrchestrator(this.ledger, this.spend, this.approvals, 50_000_000n, (type, payload) => {
      void this.events.emit(type as never, payload).catch(() => { /* journal already records */ });
    });
    this.treasury = new TreasuryManager(this.ledger);
    this.billing = new BillingManager(this.ledger);
  }

  /**
   * Ensure the standard account skeleton exists. A payment needs a source
   * asset account and expense counterpart; idempotent by account id.
   */
  ensureStandardAccounts(unit: string, network?: string, sourceAccountId?: string) {
    const unitKey = `${unit}${network ? ":" + network : ""}`;
    const src = sourceAccountId ?? `wallet:${unitKey}`;
    const acc = this.ledger.ensureAccount({
      id: src,
      kind: "asset",
      unit,
      network,
      name: `${unit} operating wallet${network ? ` (${network})` : ""}`,
      role: "operating",
    });
    const counter = this.ledger.ensureAccount({
      id: `expense:payments:${unitKey}`,
      kind: "expense",
      unit,
      network,
      name: `${unit} payments out`,
    });
    const income = this.ledger.ensureAccount({
      id: `income:payments:${unitKey}`,
      kind: "income",
      unit,
      network,
      name: `${unit} payments in`,
    });
    const fees = this.ledger.ensureAccount({
      id: `expense:fees:${unitKey}`,
      kind: "expense",
      unit,
      network,
      name: `${unit} network & provider fees`,
      role: "fees",
    });
    return { sourceId: acc.id, counterId: counter.id, incomeId: income.id, feesId: fees.id };
  }
}

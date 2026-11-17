/**
 * Payment Orchestrator — the single writer of payment money.
 *
 * Every surface (CLI commands, MCP tools, future integrations) moves payment
 * money ONLY through this orchestrator, which always:
 *   1. checks spend limits (fail-closed) — no surface can bypass them,
 *   2. requires a human approval when policy says so,
 *   3. posts a balanced double-entry transaction to the ledger,
 *   4. walks the SAME state machine as the ledger (submission ≠ settlement),
 *   5. is idempotent on caller-supplied keys — a retry reuses the record.
 *
 * What this does NOT do: talk to any chain. Settlement adapters are reported
 * honestly via settlementCapability() — in this build there are no live
 * payment-settlement adapters wired into the local ledger; value movement
 * happens through the existing hosted flows (furlpay pay/send) or is
 * reconciled in via attachEvidence() with a real transaction hash. A payment
 * therefore parks in SUBMITTED/CONFIRMED only after evidence — never because
 * this code hoped so.
 */

import * as crypto from "crypto";
import { FinancialLedger, LedgerTxState } from "./ledger";
import { SpendManager } from "./spend";
import { ApprovalEngine, ApprovalParams, ApprovalRequest } from "./approvals";
import { MoneyAmount, formatMoney } from "./money";

export type PaymentState = LedgerTxState;

export interface Payment {
  id: string;
  idempotencyKey?: string;
  direction: "out" | "in";
  /** Display form of the amount (money.ts types carry the real minor value). */
  amount: { minor: string; unit: string; network?: string; decimals: number; kind: "fiat" | "token" };
  destination?: string;
  source?: string;
  state: PaymentState;
  ledgerTxId: string;
  approvalId?: string;
  feeMinor?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
  audit: { at: string; event: string; detail?: string }[];
}

export interface SettlementCapability {
  network: string;
  /** "live" — real signed submission wired; "simulated" — labeled local
   *  simulation only; "none" — nothing wired; recorded-only tracking. */
  mode: "live" | "simulated" | "none";
  note: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;

export class PaymentOrchestrator {
  constructor(
    private readonly ledger: FinancialLedger,
    private readonly spend: SpendManager,
    private readonly approvals: ApprovalEngine,
    private readonly requireApprovalAboveMinor: bigint = 50_000_000n, // $50 in USDC-minor by default
    private readonly emit?: (type: string, payload: Record<string, unknown>) => void,
  ) {}

  private fire(type: string, p: Payment): void {
    this.emit?.(type, { paymentLedgerTxId: p.ledgerTxId, state: p.state, amountMinor: p.amount.minor, unit: p.amount.unit, network: p.amount.network, destination: p.destination, at: p.updatedAt });
  }

  /** Honest capability report — no invented adapters. */
  settlementCapabilities(): SettlementCapability[] {
    return [
      { network: "stellar", mode: "simulated", note: "SDEX/path-payment submission is a labeled local simulation in this build; no broadcast" },
      { network: "base", mode: "none", note: "no local settlement adapter; hosted flows or external evidence only" },
      { network: "solana", mode: "none", note: "no local settlement adapter; hosted flows or external evidence only" },
      { network: "ethereum", mode: "none", note: "no local settlement adapter; hosted flows or external evidence only" },
      { network: "hyperliquid", mode: "none", note: "trading venue, not a payment rail" },
    ];
  }

  /**
   * Create an outbound payment. Fail-closed on spend policy; requires a
   * human-approved ApprovalRequest when the amount crosses the threshold.
   * Idempotent on idempotencyKey.
   */
  createOutPayment(input: {
    amount: MoneyAmount;
    destination: string;
    sourceAccountId: string;
    destinationAccountId: string;
    /** Expense/income counterpart account for double-entry balancing. */
    counterAccountId: string;
    /** Dedicated fee-expense account; defaults to counterAccountId. */
    feeAccountId?: string;
    feeMinor?: bigint;
    idempotencyKey?: string;
    approvalId?: string;
    counterpartyRef?: string;
  }): Payment | ApprovalRequest {
    // Idempotency first: an existing record wins over any re-processing.
    if (input.idempotencyKey) {
      const existing = this.ledger.listTransactions().find((t) => t.idempotencyKey === input.idempotencyKey);
      if (existing) return this.hydrate(existing.id);
    }

    const amount = input.amount;
    const unit = amount.kind === "fiat" ? amount.currency : amount.asset;
    const network = amount.kind === "token" ? amount.network : undefined;
    const feeMinor = input.feeMinor ?? 0n;

    // 1. Spend controls — the gate every surface must pass.
    const decision = this.spend.check({ minor: amount.minor, unit, network, counterparty: input.destination });
    if (!decision.allowed) {
      throw new Error(`SPEND_REFUSED: ${decision.reason}`);
    }

    // 2. Approval when policy requires it — bound to the exact parameters.
    const params: ApprovalParams = { minor: amount.minor, unit, network, destination: input.destination, source: input.sourceAccountId, type: "payment_out", feeMinor };
    let approvalId: string | undefined;
    if (amount.minor > this.requireApprovalAboveMinor) {
      if (!input.approvalId) {
        // No approval supplied: create the request and RETURN it — the caller
        // must show it to a human. Money never moves past this point without
        // a human-approved request id presented back here.
        return this.approvals.create(params, { level: amount.minor > 100_000_000n ? "high" : "medium", notes: `outbound ${formatMoney(amount)} to ${input.destination}` });
      }
      // Consume BEFORE any ledger posting: the burned approval is the
      // authorization. If posting then failed, the approval is spent (fail-
      // closed) — never the reverse, which would post money against an
      // approval that was never consumed.
      this.approvals.consumeForExecution(input.approvalId, params, "pending");
      approvalId = input.approvalId;
    }

    // 3. Ledger posting — balanced double-entry, CREATED state. Paying an
    // external party: the source ASSET goes down (credit), the expense
    // counterpart goes up (debit).
    const tx = this.ledger.commit({
      type: "payment_out",
      state: "CREATED",
      idempotencyKey: input.idempotencyKey,
      refApprovalId: approvalId,
      entries: [
        { accountId: input.sourceAccountId, direction: "credit", minor: amount.minor, note: input.counterpartyRef ?? input.destination },
        { accountId: input.counterAccountId, direction: "debit", minor: amount.minor },
      ],
    });
    if (feeMinor > 0n) {
      // Fees post as their own balanced transaction (fee expense up, source
      // asset down) — separate tx so fee reports stay clean.
      this.ledger.commit({
        type: "fee",
        state: "CREATED",
        idempotencyKey: `${input.idempotencyKey ?? tx.id}:fee`,
        entries: [
          { accountId: input.feeAccountId ?? input.counterAccountId, direction: "debit", minor: feeMinor, note: "network fee" },
          { accountId: input.sourceAccountId, direction: "credit", minor: feeMinor },
        ],
      });
    }

    // Record the real ledger reference on the consumed approval.
    if (approvalId) {
      const consumed = this.approvals.get(approvalId);
      if (consumed) {
        consumed.executedRef = tx.id;
        consumed.audit.push({ at: new Date().toISOString(), event: "EXECUTED_REF", detail: tx.id });
      }
    }

    const p = this.hydrate(tx.id);
    this.fire("payment.created", p);
    return p;
  }

  /** Move forward with real-world evidence. Fabricated hashes are refused by the ledger. */
  markSubmitted(paymentLedgerTxId: string, txHash: string): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    this.ledger.attachTxHash(paymentLedgerTxId, txHash);
    this.ledger.transition(paymentLedgerTxId, "SUBMITTED", `evidence ${txHash.slice(0, 18)}…`);
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.submitted", p);
    return p;
  }

  markConfirmed(paymentLedgerTxId: string, note?: string): Payment {
    this.ledger.transition(paymentLedgerTxId, "CONFIRMED", note);
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.confirmed", p);
    return p;
  }

  /** Settlement. Only CONFIRMED payments settle — submission never settles. */
  markSettled(paymentLedgerTxId: string, note?: string): Payment {
    this.ledger.transition(paymentLedgerTxId, "SETTLED", note);
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.settled", p);
    return p;
  }

  /** Cancel: legal only before SUBMITTED — an in-flight payment cannot be cancelled locally. */
  cancel(paymentLedgerTxId: string, reason: string): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    this.ledger.transition(paymentLedgerTxId, "CANCELLED", reason.slice(0, 200));
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.cancelled", p);
    return p;
  }

  /** Reconcile external reality into the record (from a Horizon/RPC lookup the caller performed). */
  attachEvidence(paymentLedgerTxId: string, txHash: string, confirmed: boolean): Payment {
    this.ledger.attachTxHash(paymentLedgerTxId, txHash);
    return confirmed ? this.markConfirmed(paymentLedgerTxId, "external confirmation") : this.hydrate(paymentLedgerTxId);
  }

  /** Immutable receipt: current state + audit trail + ledger integrity proof. */
  receipt(paymentLedgerTxId: string): string {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    const rec = this.hydrate(paymentLedgerTxId);
    const lines = [
      `FURLPAY PAYMENT RECEIPT`,
      `payment ledger tx : ${tx.id}`,
      `state             : ${tx.state}`,
      `amount            : ${rec.amount.minor} minor ${rec.amount.unit}${rec.amount.network ? ` (${rec.amount.network})` : ""}`,
      ...(rec.destination ? [`destination       : ${rec.destination}`] : []),
      ...(tx.txHash ? [`network tx        : ${tx.txHash}`] : []),
      ...(tx.refApprovalId ? [`approval          : ${tx.refApprovalId} (param-bound, single-use)`] : []),
      `chain hash        : ${tx.chainHash}`,
      `created           : ${tx.createdAt}`,
      `entries:`,
      ...tx.entries.map((e) => `  ${e.direction.padEnd(6)} ${e.minor} ${e.unit}${e.network ? ":" + e.network : ""} → ${e.accountId}`),
      `audit:`,
      ...tx.audit.map((a) => `  ${a.at}  ${a.event}${a.detail ? ` — ${a.detail}` : ""}`),
      ``,
      `This receipt reflects the local ledger of record. It is not an issuer receipt.`,
    ];
    return lines.join("\n");
  }

  get(idOrLedgerTx: string): Payment | undefined {
    const tx = this.ledger.getTransaction(idOrLedgerTx);
    return tx ? this.hydrate(tx.id) : undefined;
  }

  history(limit = 20): Payment[] {
    return this.ledger
      .listTransactions()
      .filter((t) => t.type === "payment_out" || t.type === "payment_in")
      .reverse()
      .slice(0, limit)
      .map((t) => this.hydrate(t.id));
  }

  private hydrate(ledgerTxId: string): Payment {
    const tx = this.ledger.getTransaction(ledgerTxId)!;
    const outEntry = tx.entries.find((e) => e.direction === "debit");
    const acc = outEntry ? this.ledger.getAccount(outEntry.accountId) : undefined;
    return {
      id: tx.id,
      idempotencyKey: tx.idempotencyKey,
      direction: tx.type === "payment_in" ? "in" : "out",
      amount: {
        minor: (outEntry?.minor ?? 0n).toString(),
        unit: acc?.unit ?? "?",
        network: acc?.network,
        decimals: acc?.unit === "USDC" || acc?.unit === "USDT" || acc?.unit === "EURC" ? 6 : acc?.unit === "XLM" ? 7 : 2,
        kind: acc?.network ? "token" : "fiat",
      },
      destination: tx.entries.find((e) => e.note)?.note,
      state: tx.state,
      ledgerTxId: tx.id,
      approvalId: tx.refApprovalId,
      txHash: tx.txHash,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      audit: tx.audit,
    };
  }
}

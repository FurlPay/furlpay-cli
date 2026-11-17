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
import { FinancialLedger, LedgerTxState, validateDestination } from "./ledger";
import { SpendManager } from "./spend";
import { ApprovalEngine, ApprovalParams, ApprovalRequest } from "./approvals";
import { MoneyAmount, formatMoney } from "./money";
import { getCapability } from "../capabilities/registry";

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
  /** How well txHash is known — only chain_verified may settle. */
  evidenceLevel?: "operator_asserted" | "chain_verified";
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

/**
 * Per-unit approval thresholds in MINOR units (readiness P23): a threshold
 * is meaningless without knowing the decimals. Unknown units fail closed —
 * they always require approval rather than guessing a scale.
 */
const APPROVAL_THRESHOLD_MINOR: Record<string, bigint> = {
  USDC: 50_000_000n, // 50 USDC (6 dp)
  USDT: 50_000_000n,
  EURC: 50_000_000n,
  USD: 5_000n, // $50 (2 dp)
  EUR: 5_000n,
  GBP: 5_000n,
};

export class PaymentOrchestrator {
  constructor(
    private readonly ledger: FinancialLedger,
    private readonly spend: SpendManager,
    private readonly approvals: ApprovalEngine,
    private readonly emit?: (type: string, payload: Record<string, unknown>) => void,
  ) {}

  /** Approval threshold for one unit; unknown unit → fail closed (always approve). */
  private thresholdFor(unit: string): bigint | null {
    return APPROVAL_THRESHOLD_MINOR[unit.toUpperCase()] ?? null;
  }

  private fire(type: string, p: Payment): void {
    this.emit?.(type, { paymentLedgerTxId: p.ledgerTxId, state: p.state, amountMinor: p.amount.minor, unit: p.amount.unit, network: p.amount.network, destination: p.destination, at: p.updatedAt });
  }

  /**
   * Honest capability report — derived from the P1 capability registry by
   * construction, never a parallel hardcoded list that can drift from it.
   * Each payment rail maps to its registry surface; a rail with no
   * registered settlement surface reports "none".
   */
  settlementCapabilities(): SettlementCapability[] {
    // network → registry surface that would actually carry the settlement.
    // Only stellar has one today (simulated); the rest are deliberately
    // unregistered ids → "none". Hyperliquid is a trading venue, NOT a
    // payment rail — its live perp-execution mode must never leak into a
    // settlement capability report.
    const SURFACE_BY_NETWORK: Record<string, string> = {
      stellar: "stellar.path-payment",
      base: "finance.payments.settlement.base",
      solana: "finance.payments.settlement.solana",
      ethereum: "finance.payments.settlement.ethereum",
      hyperliquid: "finance.payments.settlement.hyperliquid",
    };
    const FALLBACK_NOTE: Record<string, string> = {
      stellar: "SDEX/path-payment submission is a labeled local simulation in this build; no broadcast",
      base: "no local settlement adapter; hosted flows or external evidence only",
      solana: "no local settlement adapter; hosted flows or external evidence only",
      ethereum: "no local settlement adapter; hosted flows or external evidence only",
      hyperliquid: "trading venue, not a payment rail",
    };
    return Object.entries(SURFACE_BY_NETWORK).map(([network, surfaceId]) => {
      const cap = getCapability(surfaceId);
      // A registry mode of local/analysis is NOT a settlement rail — report
      // "none" rather than dressing a tracker up as settlement.
      const mode = cap && (cap.mode === "live" || cap.mode === "simulated") ? cap.mode : "none";
      return {
        network,
        mode,
        note: cap?.note ?? FALLBACK_NOTE[network],
      };
    });
  }

  /**
   * Create an outbound payment. Fail-closed on spend policy; requires a
   * human-approved ApprovalRequest when amount+fee crosses the per-unit
   * threshold. The execution sequence is binding-assert → reserve (CAS) →
   * atomic commit (payment+fee together) → finalize; any failure releases
   * the reservation and leaves the ledger byte-identical (readiness P23).
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
    const amount = input.amount;
    const unit = amount.kind === "fiat" ? amount.currency : amount.asset;
    const network = amount.kind === "token" ? amount.network : undefined;
    const feeMinor = input.feeMinor ?? 0n;

    // 0. Destination validation BEFORE anything is created — junk like
    // GDEST123 on an EVM network is refused at the door.
    validateDestination(input.destination, network);

    // 1. Idempotency with a parameter fingerprint: the same key with
    // DIFFERENT parameters is a conflict, not a silent success.
    const fingerprint = JSON.stringify({
      minor: amount.minor.toString(),
      unit: unit.toUpperCase(),
      network: network ?? null,
      destination: input.destination.trim(),
      source: input.sourceAccountId,
      feeMinor: feeMinor.toString(),
    });
    if (input.idempotencyKey) {
      const existing = this.ledger.listTransactions().find((t) => t.idempotencyKey === input.idempotencyKey);
      if (existing) {
        const existingFp = existing.audit.find((a) => a.event === "FINGERPRINT")?.detail;
        if (existingFp && existingFp !== fingerprint) {
          throw new Error(
            `IDEMPOTENCY_CONFLICT: key ${input.idempotencyKey} was used for a DIFFERENT payment ` +
              `(stored fingerprint differs). New payment refused — use a fresh key.`
          );
        }
        // A dead original is SURFACED, never silently re-served as success
        // (readiness P23): replaying a key against a cancelled/failed payment
        // returns an error pointing at the original, so the caller knows the
        // money did not move.
        if (existing.state === "CANCELLED" || existing.state === "FAILED") {
          throw new Error(
            `IDEMPOTENCY_KEY_DEAD: key ${input.idempotencyKey} belongs to payment ${existing.id} ` +
              `which is ${existing.state}. The original did not complete — create a NEW payment with a fresh key.`
          );
        }
        return this.hydrate(existing.id);
      }
    }

    // 2. Spend controls — amount AND fee consume budget (readiness P23).
    const decision = this.spend.check({ minor: amount.minor + feeMinor, unit, network, counterparty: input.destination });
    if (!decision.allowed) {
      throw new Error(`SPEND_REFUSED: ${decision.reason}`);
    }

    // 3. Approval when amount+fee crosses the per-unit threshold; unknown
    // units have NO threshold → always require approval (fail closed).
    const params: ApprovalParams = { minor: amount.minor, unit, network, destination: input.destination, source: input.sourceAccountId, type: "payment_out", feeMinor };
    const threshold = this.thresholdFor(unit);
    const needsApproval = threshold === null || amount.minor + feeMinor > threshold;
    let approvalId: string | undefined;
    let reservationToken: string | undefined;
    if (needsApproval) {
      if (!input.approvalId) {
        const level = threshold !== null && amount.minor + feeMinor > threshold * 10n ? "high" : "medium";
        return this.approvals.create(params, { level, notes: `outbound ${formatMoney(amount)} (+fee) to ${input.destination}` });
      }
      // Pure binding assert FIRST — no writes on a mismatch. Advisory only —
      // the authoritative check reruns inside reserveForExecution under the
      // cross-process lock.
      this.approvals.assertBinding(input.approvalId, params);
      // CAS reservation: exactly one execution per approval. The owner token
      // proves THIS execution won it; a concurrent loser holds no token and
      // can neither finalize nor release our reservation.
      const reservation = this.approvals.reserveForExecution(input.approvalId, params);
      approvalId = input.approvalId;
      reservationToken = reservation.ownerToken;
    }

    // 4. ATOMIC ledger posting — payment and fee land together or not at all.
    try {
      const batch = this.ledger.commitMany([
        {
          type: "payment_out",
          state: "CREATED",
          idempotencyKey: input.idempotencyKey,
          refApprovalId: approvalId,
          refDestination: input.destination.trim(),
          entries: [
            { accountId: input.sourceAccountId, direction: "credit", minor: amount.minor, note: input.counterpartyRef ?? input.destination },
            { accountId: input.counterAccountId, direction: "debit", minor: amount.minor },
          ],
        },
        ...(feeMinor > 0n
          ? [{
              type: "fee" as const,
              state: "CREATED" as const,
              idempotencyKey: `${input.idempotencyKey ?? "noid"}:fee`,
              entries: [
                { accountId: input.feeAccountId ?? input.counterAccountId, direction: "debit" as const, minor: feeMinor, note: "network fee" },
                { accountId: input.sourceAccountId, direction: "credit" as const, minor: feeMinor },
              ],
            }]
          : []),
      ]);
      const tx = batch[0];

      // Idempotency fingerprint rides in the audit trail (hash-chained).
      if (input.idempotencyKey) {
        this.ledger.annotate(tx.id, "FINGERPRINT", fingerprint);
      }

      // 5. Finalize the reservation with the real ledger reference.
      if (approvalId && reservationToken) {
        this.approvals.finalizeExecution(approvalId, reservationToken, tx.id);
      }

      const p = this.hydrate(tx.id);
      this.fire("payment.created", p);
      return p;
    } catch (e) {
      // Posting failed: the OWNER releases the reservation so the approval
      // is not stranded, and the ledger stays untouched (commitMany is
      // atomic). A crash between reserve and commit strands the reservation
      // RESERVED — fail-closed (no re-execution); the audit trail shows it.
      if (approvalId && reservationToken) {
        try { this.approvals.releaseReservation(approvalId, reservationToken, `posting failed: ${(e as Error).message?.slice(0, 120)}`); } catch { /* audit trail keeps both */ }
      }
      throw e;
    }
  }

  /** Move forward with real-world evidence. Fabricated hashes are refused by the ledger. */
  markSubmitted(paymentLedgerTxId: string, txHash: string): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    this.ledger.attachTxHash(paymentLedgerTxId, txHash, { network: tx.entries[0]?.network, level: "operator_asserted" });
    this.ledger.transition(paymentLedgerTxId, "SUBMITTED", `evidence ${txHash.slice(0, 18)}… (operator asserted)`);
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.submitted", p);
    return p;
  }

  markConfirmed(paymentLedgerTxId: string, note?: string): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    if (!tx.txHash) {
      throw new Error(`CONFIRM_REQUIRES_EVIDENCE: payment ${paymentLedgerTxId} has no transaction hash — confirm attaches real evidence first (readiness P23).`);
    }
    this.ledger.transition(paymentLedgerTxId, "CONFIRMED", note);
    const p = this.hydrate(paymentLedgerTxId);
    this.fire("payment.confirmed", p);
    return p;
  }

  /**
   * Chain-verified evidence (readiness P23): an injected provider checked
   * the receipt on-chain (success, destination, amount). The verifier's
   * identity is recorded — the ledger labels what was verified and by whom,
   * never manufacturing confidence it does not have.
   */
  attachChainVerifiedEvidence(paymentLedgerTxId: string, txHash: string, verification: { provider: string; receipt: Record<string, unknown> }): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    this.ledger.attachTxHash(paymentLedgerTxId, txHash, { network: tx.entries[0]?.network, level: "chain_verified" });
    this.ledger.annotate(paymentLedgerTxId, "CHAIN_VERIFIED", `provider=${verification.provider} receipt=${JSON.stringify(verification.receipt).slice(0, 180)}`);
    return this.hydrate(paymentLedgerTxId);
  }

  /**
   * Settlement requires CONFIRMED state AND chain-verified evidence — an
   * operator-asserted hash is a claim, not a proof (readiness P23).
   */
  markSettled(paymentLedgerTxId: string, note?: string): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    if (tx.evidenceLevel !== "chain_verified") {
      throw new Error(
        `SETTLE_REQUIRES_CHAIN_VERIFIED: payment ${paymentLedgerTxId} evidence is ${tx.evidenceLevel ?? "absent"}. ` +
          `Only chain-verified payments settle — attach verified evidence first.`
      );
    }
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
  attachEvidence(paymentLedgerTxId: string, txHash: string, confirmed: boolean, level: "operator_asserted" | "chain_verified" = "operator_asserted"): Payment {
    const tx = this.ledger.getTransaction(paymentLedgerTxId);
    if (!tx) throw new Error(`Unknown payment transaction ${paymentLedgerTxId}.`);
    this.ledger.attachTxHash(paymentLedgerTxId, txHash, { network: tx.entries[0]?.network, level });
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
    // Decimals from the central money registry — never a hardcoded fallback
    // that silently misdisplays ETH/SOL/BTC (readiness P23).
    let decimals = 2;
    if (acc) {
      try {
        // Lazy require avoids a cycle: money.ts has no payments imports.
        const money = require("./money") as typeof import("./money");
        decimals = acc.network ? money.tokenDecimals(acc.unit) : money.currencyDecimals(acc.unit);
      } catch {
        decimals = acc.network ? 18 : 2; // display-only fallback; amounts stay raw minor
      }
    }
    return {
      id: tx.id,
      idempotencyKey: tx.idempotencyKey,
      direction: tx.type === "payment_in" ? "in" : "out",
      amount: {
        minor: (outEntry?.minor ?? 0n).toString(),
        unit: acc?.unit ?? "?",
        network: acc?.network,
        decimals,
        kind: acc?.network ? "token" : "fiat",
      },
      destination: tx.refDestination ?? tx.entries.find((e) => e.note)?.note,
      state: tx.state,
      ledgerTxId: tx.id,
      approvalId: tx.refApprovalId,
      txHash: tx.txHash,
      evidenceLevel: tx.evidenceLevel,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      audit: tx.audit,
    };
  }
}

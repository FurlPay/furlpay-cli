/**
 * FurlPay Financial Ledger — durable double-entry accounting.
 *
 * THE most important component of the financial operations layer:
 * - Double-entry: every transaction posts balanced debit/credit entries; a
 *   transaction that does not balance is refused at commit, and a ledger
 *   whose running hash chain does not verify is refused at load.
 * - Precise money: every amount is a BigInt in minor units with explicit
 *   decimals. No float ever touches a balance.
 * - Idempotency: a caller-supplied idempotencyKey returns the existing
 *   transaction — duplicate submission cannot double-post.
 * - Legal state machine: CREATED → PENDING → AUTHORIZED → SUBMITTED →
 *   CONFIRMED → SETTLED, with FAILED / REVERSED / CANCELLED as terminal.
 *   Submission is NOT settlement; the state machine makes that unmissable.
 * - Durability: one JSON store at ~/.furlpay/finance/ledger.json written
 *   atomically (temp+rename, 0600, symlink refusal) with a sha256 chain over
 *   every transaction — tampering with history is detectable on load.
 *
 * Amounts are signed by ACCOUNT KIND at balance time: debits increase asset
 * and expense accounts; credits increase liability, equity and income
 * accounts. A transaction's entries must sum to zero under that sign rule.
 */

import * as crypto from "crypto";
import { readJsonStore, writeJsonStoreAtomic } from "./store";
import { MoneyAmount, formatMoney } from "./money";

export type LedgerTxType =
  | "payment_out" | "payment_in" | "fee" | "fee_income"
  | "treasury_transfer" | "reserve_move" | "refund" | "reversal" | "adjustment";

export type LedgerTxState =
  | "CREATED" | "PENDING" | "AUTHORIZED" | "SUBMITTED" | "CONFIRMED" | "SETTLED"
  | "FAILED" | "REVERSED" | "CANCELLED";

/** Account categories; the sign rule derives from this. */
export type AccountKind = "asset" | "liability" | "equity" | "income" | "expense";

export interface LedgerAccount {
  id: string;
  kind: AccountKind;
  /** e.g. "USDC" / "USD" — accounts never mix units. */
  unit: string;
  /** Network qualifier for token accounts; absent for fiat. */
  network?: string;
  /** Human label. */
  name: string;
  /** Optional treasury/operating/reserve designation for treasury views. */
  role?: "operating" | "reserve" | "pending_settlement" | "fees";
  createdAt: string;
}

export interface LedgerEntry {
  accountId: string;
  direction: "debit" | "credit";
  /** Integer minor units — always positive; direction carries the sign. */
  minor: bigint;
  /** Snapshot of unit + decimals so entries are self-describing. */
  unit: string;
  network?: string;
  note?: string;
}

export interface LedgerTransaction {
  id: string;
  /** Monotonic sequence for ordering and the hash chain. */
  seq: number;
  type: LedgerTxType;
  state: LedgerTxState;
  entries: LedgerEntry[];
  /** Caller-supplied dedup key — unique per store. */
  idempotencyKey?: string;
  /** On-chain reference once submitted (real hash only, never fabricated). */
  txHash?: string;
  /** Cross-reference to the payment/approval that produced this. */
  refPaymentId?: string;
  refApprovalId?: string;
  createdAt: string;
  updatedAt: string;
  /** sha256 chain: hash(prevChainHash + canonicalTxJson). */
  chainHash: string;
  audit: { at: string; event: string; detail?: string }[];
}

interface LedgerStoreShape {
  schema: "furlpay-finance-ledger-v1";
  accounts: LedgerAccount[];
  transactions: LedgerTransaction[];
}

const GENESIS = "0x" + "0".repeat(64);

// ── Persisted/canonical form ────────────────────────────────────────────────
// JSON cannot carry BigInt, so the on-disk and hash-canonical form encodes
// entry.minor as a decimal string. canonicalTx() builds this form from ANY
// in-memory transaction, so a hash computed at commit time equals the hash
// recomputed after a reload.

interface CanonicalEntryJson {
  accountId: string;
  direction: string;
  minor: string;
  unit: string;
  network?: string;
  note?: string;
}

function canonicalTx(tx: Omit<LedgerTransaction, "chainHash">): string {
  const obj = {
    id: tx.id,
    seq: tx.seq,
    type: tx.type,
    state: tx.state,
    entries: tx.entries.map((e) => {
      const j: CanonicalEntryJson = { accountId: e.accountId, direction: e.direction, minor: e.minor.toString(), unit: e.unit };
      if (e.network !== undefined) j.network = e.network;
      if (e.note !== undefined) j.note = e.note;
      return j;
    }),
    idempotencyKey: tx.idempotencyKey ?? null,
    txHash: tx.txHash ?? null,
    refPaymentId: tx.refPaymentId ?? null,
    refApprovalId: tx.refApprovalId ?? null,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    audit: tx.audit.map((a) => ({ at: a.at, event: a.event, ...(a.detail !== undefined ? { detail: a.detail } : {}) })),
  };
  return JSON.stringify(obj);
}

function chainNext(prev: string, tx: Omit<LedgerTransaction, "chainHash">): string {
  return "0x" + crypto.createHash("sha256").update(prev + canonicalTx(tx)).digest("hex");
}

const LEGAL_TRANSITIONS: Record<LedgerTxState, LedgerTxState[]> = {
  // CREATED → SUBMITTED is legal only via the orchestrator with real evidence
  // attached (attachTxHash first); the transition itself never fabricates one.
  CREATED: ["PENDING", "AUTHORIZED", "SUBMITTED", "CANCELLED", "FAILED"],
  PENDING: ["AUTHORIZED", "SUBMITTED", "CANCELLED", "FAILED"],
  AUTHORIZED: ["SUBMITTED", "CANCELLED", "FAILED", "REVERSED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
  CONFIRMED: ["SETTLED", "REVERSED", "FAILED"],
  SETTLED: ["REVERSED"],
  FAILED: ["REVERSED"],
  REVERSED: [],
  CANCELLED: [],
};

export class FinancialLedger {
  private accounts = new Map<string, LedgerAccount>();
  private transactions: LedgerTransaction[] = [];
  private byIdempotency = new Map<string, string>();
  private readonly filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath = filePath || require("path").join(require("os").homedir(), ".furlpay", "finance", "ledger.json");
    // Fail-fast: a tampered or corrupt ledger is refused at construction,
    // not at the first query — an invalid audit ledger must never be usable.
    this.ensureLoaded();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const stored = readJsonStore<LedgerStoreShape>(this.filePath);
    if (stored) {
      if (stored.schema !== "furlpay-finance-ledger-v1" || !Array.isArray(stored.accounts) || !Array.isArray(stored.transactions)) {
        throw new Error(`Ledger at ${this.filePath} has an unrecognized format — refusing to load.`);
      }
      if (stored.transactions.length > 100_000) {
        throw new Error(`Ledger at ${this.filePath} exceeds 100k transactions — compact or archive before continuing.`);
      }
      // Revive persisted string minor values to BigInt BEFORE chain
      // verification: canonicalTx() stringifies minors either way, so the
      // recomputed hashes match commit-time hashes exactly.
      for (const tx of stored.transactions) {
        for (const e of tx.entries) {
          if (typeof e.minor === "string") e.minor = BigInt(e.minor);
        }
      }
      // Verify the hash chain before trusting any of it.
      let prev = GENESIS;
      for (const tx of stored.transactions) {
        const claimed = tx.chainHash;
        const recomputed = chainNext(prev, tx);
        if (claimed !== recomputed) {
          throw new Error(
            `Ledger hash chain INVALID at tx ${tx.id} (seq ${tx.seq}) in ${this.filePath}. ` +
              `History may have been altered — an invalid audit ledger is never extended. Restore or move the file.`
          );
        }
        prev = claimed;
      }
      for (const acc of stored.accounts) this.accounts.set(acc.id, acc);
      for (const tx of stored.transactions) {
        if (tx.idempotencyKey) this.byIdempotency.set(tx.idempotencyKey, tx.id);
      }
      this.transactions = stored.transactions;
    }
    this.loaded = true;
  }

  private persist(): void {
    // JSON cannot carry BigInt — minors serialize as decimal strings, the
    // exact canonical form the hash chain is computed over.
    writeJsonStoreAtomic(this.filePath, {
      schema: "furlpay-finance-ledger-v1",
      accounts: [...this.accounts.values()],
      transactions: this.transactions.map((tx) => ({
        ...tx,
        entries: tx.entries.map((e) => ({ ...e, minor: e.minor.toString() })),
      })),
    });
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  /** Registers an account. Idempotent by id — same fields pass, conflicts throw. */
  ensureAccount(spec: Omit<LedgerAccount, "createdAt">): LedgerAccount {
    this.ensureLoaded();
    const existing = this.accounts.get(spec.id);
    if (existing) {
      const conflicts = (["kind", "unit", "network", "name"] as const).filter((f) => existing[f] !== spec[f]);
      if (conflicts.length) {
        throw new Error(`Account ${spec.id} already exists with different ${conflicts.join(", ")} — account definitions are immutable.`);
      }
      return existing;
    }
    const acc: LedgerAccount = { ...spec, createdAt: new Date().toISOString() };
    this.accounts.set(acc.id, acc);
    this.persist();
    return acc;
  }

  getAccount(id: string): LedgerAccount | undefined {
    this.ensureLoaded();
    return this.accounts.get(id);
  }

  listAccounts(): LedgerAccount[] {
    this.ensureLoaded();
    return [...this.accounts.values()];
  }

  // ── Transaction commit ─────────────────────────────────────────────────────

  /**
   * Commit a new transaction. Throws unless the entries balance to zero
   * under the account-kind sign rule and every account exists. Idempotent on
   * idempotencyKey: the existing transaction is returned unchanged
   * (duplicate detection), never re-posted.
   */
  commit(input: {
    id?: string;
    type: LedgerTxType;
    state?: LedgerTxState;
    entries: Array<Omit<LedgerEntry, "unit" | "network"> & { unit?: string; network?: string }>;
    idempotencyKey?: string;
    txHash?: string;
    refPaymentId?: string;
    refApprovalId?: string;
    audit?: string[];
  }): LedgerTransaction {
    this.ensureLoaded();

    if (input.idempotencyKey && this.byIdempotency.has(input.idempotencyKey)) {
      const existingId = this.byIdempotency.get(input.idempotencyKey)!;
      return this.transactions.find((t) => t.id === existingId)!;
    }

    if (!Array.isArray(input.entries) || input.entries.length < 2) {
      throw new Error("A double-entry transaction needs at least two entries.");
    }

    // Resolve accounts; entries carry the account's unit/network authoritatively.
    const entries: LedgerEntry[] = input.entries.map((e) => {
      const acc = this.accounts.get(e.accountId);
      if (!acc) throw new Error(`Unknown account ${e.accountId} — create it before posting against it.`);
      if (e.minor <= 0n) throw new Error(`Entry against ${e.accountId} must be a positive minor amount.`);
      return { ...e, unit: acc.unit, network: acc.network, minor: e.minor };
    });

    // Balanced check under the sign rule: debit +, credit − on asset/expense;
    // the inverse on liability/equity/income. All entries in one transaction
    // must share one unit (mixing units inside a transaction is undefined).
    const units = new Set(entries.map((e) => `${e.unit}${e.network ? ":" + e.network : ""}`));
    if (units.size !== 1) {
      throw new Error(`Transaction entries mix units (${[...units].join(", ")}) — split them into separate transactions.`);
    }
    let balance = 0n;
    for (const e of entries) {
      const acc = this.accounts.get(e.accountId)!;
      const debitPositive = acc.kind === "asset" || acc.kind === "expense";
      const sign = (e.direction === "debit") === debitPositive ? 1n : -1n;
      balance += sign * e.minor;
    }
    if (balance !== 0n) {
      throw new Error(`Transaction does not balance (signed sum ${balance} minor) — refusing to post.`);
    }

    const now = new Date().toISOString();
    const base: Omit<LedgerTransaction, "chainHash"> = {
      id: input.id || `ltx_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      seq: this.transactions.length + 1,
      type: input.type,
      state: input.state ?? "CREATED",
      entries,
      idempotencyKey: input.idempotencyKey,
      txHash: input.txHash,
      refPaymentId: input.refPaymentId,
      refApprovalId: input.refApprovalId,
      createdAt: now,
      updatedAt: now,
      audit: [
        { at: now, event: "COMMITTED", detail: `balanced ${entries.length} entries` },
        ...(input.audit ?? []).map((d) => ({ at: now, event: d })),
      ],
    };
    const tx: LedgerTransaction = { ...base, chainHash: chainNext(this.lastChainHash(), base) };
    this.transactions.push(tx);
    if (tx.idempotencyKey) this.byIdempotency.set(tx.idempotencyKey, tx.id);
    this.persist();
    return tx;
  }

  private lastChainHash(): string {
    return this.transactions.length ? this.transactions[this.transactions.length - 1].chainHash : GENESIS;
  }

  // ── State machine ──────────────────────────────────────────────────────────

  /** Transition a transaction to a new state. Illegal transitions throw. */
  transition(txId: string, to: LedgerTxState, detail?: string): LedgerTransaction {
    this.ensureLoaded();
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`Unknown ledger transaction ${txId}.`);
    if (tx.state === to) return tx; // idempotent transition
    if (!LEGAL_TRANSITIONS[tx.state].includes(to)) {
      throw new Error(`Illegal ledger transition ${tx.state} → ${to} for ${txId}. Submission is not settlement — follow the state machine.`);
    }
    tx.state = to;
    tx.updatedAt = new Date().toISOString();
    tx.audit.push({ at: tx.updatedAt, event: `STATE:${to}`, detail });
    // Rebuild chain tail from this point (state changes re-hash forward).
    const idx = this.transactions.indexOf(tx);
    let prev = idx === 0 ? GENESIS : this.transactions[idx - 1].chainHash;
    for (let i = idx; i < this.transactions.length; i++) {
      this.transactions[i].chainHash = chainNext(prev, this.transactions[i]);
      prev = this.transactions[i].chainHash;
    }
    this.persist();
    return tx;
  }

  attachTxHash(txId: string, txHash: string): LedgerTransaction {
    this.ensureLoaded();
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`Unknown ledger transaction ${txId}.`);
    if (!/^0x[0-9a-fA-F]{6,128}$|^[0-9a-fA-F]{6,128}$/.test(txHash)) {
      throw new Error(`"${txHash}" does not look like a transaction hash — the ledger never stores fabricated references.`);
    }
    tx.txHash = txHash;
    tx.updatedAt = new Date().toISOString();
    tx.audit.push({ at: tx.updatedAt, event: "TXHASH_ATTACHED" });
    const idx = this.transactions.indexOf(tx);
    let prev = idx === 0 ? GENESIS : this.transactions[idx - 1].chainHash;
    for (let i = idx; i < this.transactions.length; i++) {
      this.transactions[i].chainHash = chainNext(prev, this.transactions[i]);
      prev = this.transactions[i].chainHash;
    }
    this.persist();
    return tx;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  getTransaction(txId: string): LedgerTransaction | undefined {
    this.ensureLoaded();
    return this.transactions.find((t) => t.id === txId);
  }

  listTransactions(filter?: { state?: LedgerTxState; refPaymentId?: string; unit?: string; sinceIso?: string }): LedgerTransaction[] {
    this.ensureLoaded();
    let out = [...this.transactions];
    if (filter?.state) out = out.filter((t) => t.state === filter.state);
    if (filter?.refPaymentId) out = out.filter((t) => t.refPaymentId === filter.refPaymentId);
    if (filter?.unit) out = out.filter((t) => t.entries.every((e) => e.unit === filter.unit));
    if (filter?.sinceIso) out = out.filter((t) => t.createdAt >= filter.sinceIso!);
    return out;
  }

  /**
   * Balance of one account: signed sum over entries of non-voided
   * transactions (SETTLED and AUTHORIZED/PENDING/SUBMITTED/CONFIRMED all
   * count — pending movement is real movement until proven otherwise; only
   * FAILED/CANCELLED/REVERSED entries are excluded).
   */
  accountBalance(accountId: string): { settledMinor: bigint; pendingMinor: bigint; totalMinor: bigint } {
    this.ensureLoaded();
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error(`Unknown account ${accountId}.`);
    const debitPositive = acc.kind === "asset" || acc.kind === "expense";
    let settled = 0n;
    let pending = 0n;
    for (const tx of this.transactions) {
      const voided = tx.state === "FAILED" || tx.state === "CANCELLED" || tx.state === "REVERSED";
      if (voided) continue;
      const isSettled = tx.state === "SETTLED";
      for (const e of tx.entries) {
        if (e.accountId !== accountId) continue;
        const sign = (e.direction === "debit") === debitPositive ? 1n : -1n;
        if (isSettled) settled += sign * e.minor;
        else pending += sign * e.minor;
      }
    }
    return { settledMinor: settled, pendingMinor: pending, totalMinor: settled + pending };
  }

  /**
   * Reconciliation: internal consistency checks. Returns explicit findings —
   * an empty discrepancy list proves the ledger is internally consistent and
   * says nothing about external on-chain reality.
   */
  reconcile(): { balancedTransactions: number; checkedTransactions: number; discrepancies: string[]; chainValid: boolean } {
    this.ensureLoaded();
    const discrepancies: string[] = [];
    let balanced = 0;
    for (const tx of this.transactions) {
      let sum = 0n;
      const units = new Set<string>();
      for (const e of tx.entries) {
        const acc = this.accounts.get(e.accountId);
        if (!acc) { discrepancies.push(`${tx.id}: entry references missing account ${e.accountId}`); continue; }
        const debitPositive = acc.kind === "asset" || acc.kind === "expense";
        const sign = (e.direction === "debit") === debitPositive ? 1n : -1n;
        sum += sign * e.minor;
        units.add(`${e.unit}${e.network ? ":" + e.network : ""}`);
      }
      if (sum !== 0n) discrepancies.push(`${tx.id}: signed sum ${sum} minor ≠ 0`);
      else if (units.size === 1) balanced++;
      if (units.size !== 1) discrepancies.push(`${tx.id}: entries mix units`);
    }
    // Chain verification without throwing (report form).
    let chainValid = true;
    let prev = GENESIS;
    for (const tx of this.transactions) {
      if (tx.chainHash !== chainNext(prev, tx)) { chainValid = false; discrepancies.push(`${tx.id}: chain hash mismatch`); break; }
      prev = tx.chainHash;
    }
    return { balancedTransactions: balanced, checkedTransactions: this.transactions.length, discrepancies, chainValid };
  }

  get filePathUsed(): string {
    return this.filePath;
  }

  /** Formatted view helper for CLI output. */
  static formatTx(tx: LedgerTransaction): string {
    const lines = tx.entries.map((e) => `    ${e.direction.padEnd(6)} ${String(e.minor).padStart(12)} ${e.unit}${e.network ? ":" + e.network : ""} → ${e.accountId}`);
    return [
      `${tx.id}  [${tx.type}]  ${tx.state}  seq=${tx.seq}`,
      ...(tx.txHash ? [`    tx: ${tx.txHash}`] : []),
      ...lines,
    ].join("\n");
  }
}

export { formatMoney };

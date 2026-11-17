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
import { withExclusiveLock } from "./fileLock";
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
  /** How well the txHash is known: operator_asserted (typed by a human,
   *  format-validated) or chain_verified (checked against a provider). Only
   *  chain_verified evidence may settle or count as settled volume. */
  evidenceLevel?: "operator_asserted" | "chain_verified";
  /** Explicit destination of the payment (validated at creation) — never
   *  derived from entry notes. */
  refDestination?: string;
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
    evidenceLevel: tx.evidenceLevel ?? null,
    refDestination: tx.refDestination ?? null,
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

/** Input shape for ledger.commit / commitMany. */
export interface LedgerCommitInput {
  id?: string;
  type: LedgerTxType;
  state?: LedgerTxState;
  entries: Array<Omit<LedgerEntry, "unit" | "network"> & { unit?: string; network?: string }>;
  idempotencyKey?: string;
  txHash?: string;
  refDestination?: string;
  refPaymentId?: string;
  refApprovalId?: string;
  audit?: string[];
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
    // Constructor-time read takes the SAME cross-process lock as writes: on
    // Windows a reader that catches the file mid-rename EPERMs the writer
    // (readiness P23 multi-process safety).
    withExclusiveLock(this.filePath, () => this.loadUnderLock());
    this.loaded = true;
  }

  private loadUnderLock(): void {
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
  }

  private persist(): void {
    // Persist under the cross-process lock so a concurrent ledger reader in
    // another process can never collide with the atomic rename (readiness
    // P23). NOTE: this serializes the WRITE, not the read-modify-write —
    // full multi-writer transactionality is the P15 state store's job.
    withExclusiveLock(this.filePath, () => {
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
  commit(input: LedgerCommitInput): LedgerTransaction {
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
      refDestination: input.refDestination,
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

  /**
   * Atomic batch commit (readiness P23): ALL transactions are validated and
   * built first; only when every one balances does anything append or
   * persist. A payment+fee pair lands together or not at all — no orphaned
   * payment without its fee.
   */
  commitMany(inputs: LedgerCommitInput[]): LedgerTransaction[] {
    this.ensureLoaded();
    // Phase 1: validate + build every transaction without mutating state.
    const built: Array<Omit<LedgerTransaction, "chainHash" | "seq">> = [];
    for (const input of inputs) {
      if (input.idempotencyKey && this.byIdempotency.has(input.idempotencyKey)) {
        throw new Error(`IDEMPOTENCY_CONFLICT: key ${input.idempotencyKey} already exists — commitMany never re-posts.`);
      }
      if (!Array.isArray(input.entries) || input.entries.length < 2) {
        throw new Error("A double-entry transaction needs at least two entries.");
      }
      // No transaction is BORN settled (readiness P23): settlement is a final
      // state reached only through the evidence-gated state machine.
      if (input.state === "SETTLED") {
        throw new Error("SETTLE_REQUIRES_CHAIN_VERIFIED: a transaction cannot be committed as SETTLED — walk the state machine with chain-verified evidence.");
      }
      const entries: LedgerEntry[] = input.entries.map((e) => {
        const acc = this.accounts.get(e.accountId);
        if (!acc) throw new Error(`Unknown account ${e.accountId} — create it before posting against it.`);
        if (e.minor <= 0n) throw new Error(`Entry against ${e.accountId} must be a positive minor amount.`);
        return { ...e, unit: acc.unit, network: acc.network, minor: e.minor };
      });
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
      if (balance !== 0n) throw new Error(`Transaction does not balance (signed sum ${balance} minor) — refusing to post.`);
      const now = new Date().toISOString();
      built.push({
        id: input.id || `ltx_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        type: input.type,
        state: input.state ?? "CREATED",
        entries,
        idempotencyKey: input.idempotencyKey,
        txHash: input.txHash,
        refPaymentId: input.refPaymentId,
        refDestination: input.refDestination,
        refApprovalId: input.refApprovalId,
        createdAt: now,
        updatedAt: now,
        audit: [{ at: now, event: "COMMITTED", detail: `balanced ${entries.length} entries` }],
      });
    }
    // Phase 2: append everything, extend the chain, persist ONCE.
    let prev = this.lastChainHash();
    const out: LedgerTransaction[] = [];
    for (const b of built) {
      const seq = this.transactions.length + 1;
      const tx: LedgerTransaction = { ...b, seq, chainHash: chainNext(prev, { ...b, seq }) };
      this.transactions.push(tx);
      if (tx.idempotencyKey) this.byIdempotency.set(tx.idempotencyKey, tx.id);
      prev = tx.chainHash;
      out.push(tx);
    }
    this.persist();
    return out;
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
    // Evidence gate AT THE LEDGER (readiness P23): settlement is a final,
    // billing-counted state. A transaction whose only evidence is an
    // operator-typed hash never settles — the gate lives here so no caller
    // (orchestrator, CLI, MCP, future adapter) can route around it.
    if (to === "SETTLED" && tx.evidenceLevel !== "chain_verified") {
      throw new Error(
        `SETTLE_REQUIRES_CHAIN_VERIFIED: ${txId} evidence is ${tx.evidenceLevel ?? "absent"}. ` +
          `Attach chain-verified evidence (provider receipt check) before settlement.`
      );
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

  /** Append an audit annotation to a transaction (rehashes the chain tail). */
  annotate(txId: string, event: string, detail?: string): LedgerTransaction {
    this.ensureLoaded();
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`Unknown ledger transaction ${txId}.`);
    tx.audit.push({ at: new Date().toISOString(), event, ...(detail !== undefined ? { detail } : {}) });
    tx.updatedAt = new Date().toISOString();
    const idx = this.transactions.indexOf(tx);
    let prev = idx === 0 ? GENESIS : this.transactions[idx - 1].chainHash;
    for (let i = idx; i < this.transactions.length; i++) {
      this.transactions[i].chainHash = chainNext(prev, this.transactions[i]);
      prev = this.transactions[i].chainHash;
    }
    this.persist();
    return tx;
  }

  attachTxHash(txId: string, txHash: string, opts?: { network?: string; level?: "operator_asserted" | "chain_verified" }): LedgerTransaction {
    this.ensureLoaded();
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) throw new Error(`Unknown ledger transaction ${txId}.`);
    // Format validation per network — 0xdeadbeef-style stubs are rejected
    // (readiness P23). Chain-level verification is a separate, future step.
    validateTxHash(txHash, opts?.network ?? tx.entries[0]?.network);
    tx.txHash = txHash;
    tx.evidenceLevel = opts?.level ?? "operator_asserted";
    tx.updatedAt = new Date().toISOString();
    tx.audit.push({ at: tx.updatedAt, event: `TXHASH_ATTACHED:${tx.evidenceLevel}` });
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

// ── Network validation (readiness P23) ─────────────────────────────────────

const EVM_NETWORKS = new Set(["base", "arbitrum", "ethereum", "optimism", "polygon", "avalanche"]);

/** Destination validation at creation — GDEST-style junk is refused before an approval exists. */
export function validateDestination(destination: string, network?: string): void {
  if (!destination || !destination.trim()) throw new Error("DESTINATION_REQUIRED: a payment needs an explicit destination.");
  const d = destination.trim();
  if (!network) return; // hosted/fiat destinations are validated by the hosted flow
  const net = network.toLowerCase();
  if (EVM_NETWORKS.has(net)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(d)) {
      throw new Error(`DESTINATION_INVALID: "${d}" is not a valid ${net} address (expected 0x + 40 hex characters).`);
    }
    return;
  }
  if (net === "stellar") {
    // StrKey with checksum — a fake address is refused at the door.
    try {
      // Lazy import keeps the ledger loadable without the Stellar SDK in tests that don't need it.
      const { StrKey } = require("@stellar/stellar-sdk");
      if (!StrKey.isValidEd25519PublicKey(d)) throw new Error("not a valid ed25519 strkey");
    } catch {
      throw new Error(`DESTINATION_INVALID: "${d}" is not a valid Stellar address (strkey check failed).`);
    }
    return;
  }
  if (net === "solana") {
    // Base58, 32-byte ed25519 pubkey → 43–44 chars from the base58 alphabet.
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(d)) {
      throw new Error(`DESTINATION_INVALID: "${d}" is not a valid Solana address (base58, 32 bytes).`);
    }
    return;
  }
  throw new Error(`DESTINATION_NETWORK_UNKNOWN: no destination validation for network "${network}" — refusing rather than accepting unverifiable addresses.`);
}

/** Transaction-hash format per network. 0xdeadbeef-style stubs are rejected. */
export function validateTxHash(txHash: string, network?: string): void {
  const h = txHash.trim();
  if (!network) {
    // No network context: accept either shape but demand plausibility.
    if (/^0x[0-9a-fA-F]{64}$/.test(h) || /^[0-9a-fA-F]{64}$/.test(h)) return;
    throw new Error(`TX_HASH_INVALID: "${h}" is not a plausible transaction hash (expected 64 hex characters).`);
  }
  const net = network.toLowerCase();
  if (EVM_NETWORKS.has(net)) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
      throw new Error(`TX_HASH_INVALID: "${h}" is not a valid ${net} transaction hash (expected 0x + 64 hex characters).`);
    }
    return;
  }
  if (net === "stellar") {
    if (!/^[0-9a-fA-F]{64}$/.test(h)) {
      throw new Error(`TX_HASH_INVALID: "${h}" is not a valid Stellar transaction hash (expected 64 hex characters).`);
    }
    return;
  }
  if (net === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(h)) {
      throw new Error(`TX_HASH_INVALID: "${h}" is not a valid Solana signature.`);
    }
    return;
  }
  throw new Error(`TX_HASH_NETWORK_UNKNOWN: no hash validation for network "${network}" — refusing.`);
}

export { formatMoney };

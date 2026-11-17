/**
 * Race worker (readiness P23 multi-process test).
 *
 * Each worker is a SEPARATE node process pointing at the same finance dir.
 * All of them try to execute the SAME approved payment; the compare-and-swap
 * reservation (APPROVED → RESERVED under the cross-process file lock) must
 * let exactly ONE win. Losers exit non-zero with APPROVAL_ALREADY_RESERVED
 * (or the binding/lock refusal) — never a second ledger posting.
 *
 * The parent pre-creates the standard accounts; workers only reference the
 * deterministic ids (wallet:/expense:/fees:) so no account-creation write
 * races the payment path.
 *
 * argv: node race-worker.js <financeDir> <approvalId> <workerIndex>
 * stdout: one JSON line { worker, outcome, detail } (machine-readable).
 */

const path = require("node:path");
const { FinanceManager } = require(path.join(__dirname, "..", "..", "dist", "finance", "manager"));
const money = require(path.join(__dirname, "..", "..", "dist", "finance", "money"));

const [dir, approvalId, workerIndex] = process.argv.slice(2);

const DEST = "0x" + "d".repeat(40); // valid EVM destination, matches the parent's approval params
const IDS = {
  sourceId: "wallet:USDC:base",
  counterId: "expense:payments:USDC:base",
  feesId: "expense:fees:USDC:base",
};

async function main() {
  const fin = new FinanceManager({ dir });
  const p = fin.payments.createOutPayment({
    amount: money.token("USDC", "base", "75"),
    destination: DEST,
    sourceAccountId: IDS.sourceId,
    destinationAccountId: IDS.sourceId,
    counterAccountId: IDS.counterId,
    feeAccountId: IDS.feesId,
    approvalId,
  });
  // createOutPayment returns either a Payment (executed) or an ApprovalRequest
  // (needs approval) — only the former is a success here.
  if (p && p.ledgerTxId) {
    process.stdout.write(JSON.stringify({ worker: workerIndex, outcome: "EXECUTED", ledgerTxId: p.ledgerTxId }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ worker: workerIndex, outcome: "UNEXPECTED_APPROVAL_REQUEST" }) + "\n");
  process.exitCode = 3;
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ worker: workerIndex, outcome: "REFUSED", error: String(e.message).split("\n")[0] }) + "\n");
  process.exitCode = 1;
});

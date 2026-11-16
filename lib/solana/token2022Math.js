"use strict";

// ---------------------------------------------------------------------------
// Token-2022 institutional math + the SEP-8 ↔ Transfer-Hook compliance
// bridge (audit Module 2). Pure, exact-integer where the chain is exact.
//
// TRANSFER FEE (SPL-exact): fee = floor(amount × bps / 10_000), capped at
//   max_fee. Evaluated in u64/u128 on-chain with integer truncation — the
//   floor here is therefore CORRECT, not an approximation.
//
// INTEREST-BEARING (SPL shape): scaled_ui = raw × (1 + r·t) where
//   r = rate_bps/10⁴ and t = (slot − pre_initialize_slot)/SLOTS_PER_YEAR.
//   SLOTS_PER_YEAR is passed explicitly (Solana's documented default ≈
//   365.25·24·3600/2.5 ≈ 12,542,848 slots at a 2.5 s slot-time assumption);
//   callers pin the value their cluster actually runs. Fees are assessed on
//   RAW token amounts, NOT on the scaled UI amount — the interaction these
//   functions make explicit (and testable).
//
// SEP-8 ↔ TRANSFER-HOOK PARITY: both are "compliance decides, transfer
// obeys". Stellar enforces off-chain (issuer co-signature before broadcast);
// Token-2022 enforces on-chain (hook CPI inside the Token Program's transfer
// instructions). The registry engine below implements the shared decision
// semantics, fail-closed on every unknown/expired/sanctioned state.
// ---------------------------------------------------------------------------

const MAX_BPS = 10_000;

/** SPL transfer-fee calculation, integer-exact, capped at max_fee. */
function calculateTransferFee(amount, { transferFeeBps, maxFee }) {
  const amt = BigInt(amount);
  const max = BigInt(maxFee);
  if (amt < 0n) throw new Error("amount must be non-negative");
  if (!Number.isInteger(transferFeeBps) || transferFeeBps < 0 || transferFeeBps > MAX_BPS) {
    throw new Error(`transferFeeBps must be an integer in [0, ${MAX_BPS}] (got ${transferFeeBps})`);
  }
  if (max < 0n) throw new Error("maxFee must be non-negative");
  const raw = (amt * BigInt(transferFeeBps)) / 10_000n; // integer floor — matches u128 division
  const fee = raw > max ? max : raw;
  return { fee, feeAfter: amt - fee, capped: raw > max };
}

/** Interest-bearing scaled UI amount. */
function scaledUiAmount(rawAmount, { rateBps, slotsElapsed, slotsPerYear = 12_542_848 }) {
  const raw = BigInt(rawAmount);
  if (raw < 0n) throw new Error("rawAmount must be non-negative");
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > MAX_BPS) {
    throw new Error(`rateBps must be an integer in [0, ${MAX_BPS}] (got ${rateBps})`);
  }
  if (!Number.isFinite(slotsElapsed) || slotsElapsed < 0) throw new Error("slotsElapsed must be a non-negative number");
  if (!Number.isFinite(slotsPerYear) || slotsPerYear <= 0) throw new Error("slotsPerYear must be a positive number");
  const r = rateBps / MAX_BPS;
  const years = slotsElapsed / slotsPerYear;
  const factor = 1 + r * years;
  // JS float is the honest tool here: on-chain this is computed in fp64 too.
  return { scaledUiAmount: Number(raw) * factor, factor, years, rateBps };
}

/** Inverse: which RAW amount yields a target UI amount (sweeps/quotes). */
function rawForScaledUi(scaledUi, { rateBps, slotsElapsed, slotsPerYear = 12_542_848 }) {
  if (!Number.isFinite(scaledUi) || scaledUi < 0) throw new Error("scaledUi must be a non-negative number");
  const { factor } = scaledUiAmount(0n, { rateBps, slotsElapsed, slotsPerYear });
  return Math.floor(scaledUi / factor);
}

/**
 * The §4.2 audit's central question: transfer fees are assessed on RAW
 * token amounts while UI balances compound with interest. This returns the
 * full picture for a transfer under both extensions at once.
 */
function transferWithFeeAndInterest(rawAmount, { transferFeeBps, maxFee, rateBps, slotsElapsed, slotsPerYear }) {
  const fee = calculateTransferFee(rawAmount, { transferFeeBps, maxFee });
  const senderRawAfterFee = fee.feeAfter;
  const recipientRaw = fee.feeAfter; // fee withheld; recipient receives net raw
  const senderUi = scaledUiAmount(senderRawAfterFee, { rateBps, slotsElapsed, slotsPerYear });
  const recipientUi = scaledUiAmount(recipientRaw, { rateBps, slotsElapsed, slotsPerYear });
  const uiIfUnfee = scaledUiAmount(rawAmount, { rateBps, slotsElapsed, slotsPerYear }).scaledUiAmount;
  return {
    ...fee,
    withheldFee: fee.fee,
    senderScaledUi: senderUi.scaledUiAmount,
    recipientScaledUi: recipientUi.scaledUiAmount,
    uiDeltaVsUnfee: uiIfUnfee - recipientUi.scaledUiAmount,
    invariant: "fee is assessed on the RAW amount and compounded interest applies to what REMAINS — fee(RAW) ≠ fee(scaled UI)",
  };
}

// ---------------------------------------------------------------------------
// SEP-8 ↔ Transfer-Hook registry engine — the shared decision semantics.
// Fail-closed: unknown investors, expired accreditation, sanctions hits and
// missing records all refuse. `mode` documents which rail enforces.
// ---------------------------------------------------------------------------

const COMPLIANCE_DECISIONS = {
  ALLOW: "allow",
  REJECT_SANCTIONS: "reject_sanctions",
  REJECT_UNACCREDITED: "reject_unaccredited",
  REJECT_KYC_EXPIRED: "reject_kyc_expired",
  REJECT_UNKNOWN: "reject_unknown_record",
};

/**
 * Evaluate a transfer under the accredited-investor registry (both rails).
 * Reg D 506(c): BOTH counterparties must be verified-accredited, KYC-current
 * and sanctions-clear. Reg S: additionally `regS` marks US-restricted.
 */
function evaluateCompliantTransfer({ sender, recipient, registry, offering = { regime: "regD506c" } }) {
  if (!registry || typeof registry !== "object") {
    return { decision: COMPLIANCE_DECISIONS.REJECT_UNKNOWN, party: null, reason: "no registry supplied — compliance fails closed" };
  }
  for (const [role, addr] of [["sender", sender], ["recipient", recipient]]) {
    if (typeof addr !== "string" || !addr) {
      return { decision: COMPLIANCE_DECISIONS.REJECT_UNKNOWN, party: role, reason: `${role} address missing` };
    }
    const rec = registry[String(addr).toLowerCase()];
    if (!rec) {
      return { decision: COMPLIANCE_DECISIONS.REJECT_UNKNOWN, party: role, reason: `${role} '${addr}' has no registry record — fail closed (SEP-8: no approval; Token-2022: hook CPI aborts)` };
    }
    if (rec.sanctionsStatus && rec.sanctionsStatus !== "clear") {
      return { decision: COMPLIANCE_DECISIONS.REJECT_SANCTIONS, party: role, reason: `${role} '${addr}' sanctions status '${rec.sanctionsStatus}' — hard abort` };
    }
    if (rec.kycExpiresAt !== undefined) {
      const exp = typeof rec.kycExpiresAt === "number" ? rec.kycExpiresAt : Date.parse(rec.kycExpiresAt);
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        return { decision: COMPLIANCE_DECISIONS.REJECT_KYC_EXPIRED, party: role, reason: `${role} '${addr}' KYC expired` };
      }
    }
    if (offering.regime === "regD506c" && rec.accredited !== true) {
      return { decision: COMPLIANCE_DECISIONS.REJECT_UNACCREDITED, party: role, reason: `${role} '${addr}' is not verified-accredited (Rule 506(c) requires reasonable steps to verify)` };
    }
    if (offering.regime === "regS" && rec.usPerson === true) {
      return { decision: COMPLIANCE_DECISIONS.REJECT_UNACCREDITED, party: role, reason: `${role} '${addr}' is a US person — Reg S offering restricts US participation` };
    }
  }
  return {
    decision: COMPLIANCE_DECISIONS.ALLOW,
    party: null,
    enforcementRail:
      offering.enforcementRail ??
      "stellar-sep8: issuer co-signature BEFORE broadcast, fail-closed when unreachable | solana-token2022: hook CPI INSIDE the token program's transfer instructions",
  };
}

/**
 * Hook-bypass audit — structured verdicts on the §4.2 attack vectors.
 * These are enforced properties of the Token-2022 program design, surfaced
 * as machine-checkable statements; the residual risks are documented.
 */
function auditHookBypassVectors() {
  return {
    vectors: [
      {
        vector: "direct spl-token instructions instead of the compliant path",
        verdict: "CANNOT BYPASS",
        basis: "the hook CPI lives inside the Token-2022 program's own transfer/transfer_checked instructions — every transfer of this mint, whatever client emits it, crosses the hook",
      },
      {
        vector: "CPI delegate trickery (approve → delegated transfer)",
        verdict: "CANNOT BYPASS",
        basis: "delegated transfers are still Token-2022 transfer instructions — the hook fires identically",
      },
      {
        vector: "account close/recreate laundering",
        verdict: "CANNOT BYPASS",
        basis: "the hook is keyed to the MINT and evaluated per transfer between account owners — account churn does not change the participants",
      },
      {
        vector: "malicious hook program replaced post-mint",
        verdict: "GOVERNANCE-BOUND",
        basis: "the hook program is immutable-per-mint once initialized; changing it requires the mint's transfer-hook authority — a governance compromise, not an instruction-level bypass",
      },
      {
        vector: "hook program crash/panic on unexpected accounts",
        verdict: "RESIDUAL RISK (DoS, not bypass)",
        basis: "a buggy hook can make transfers REVERT (availability), it can never ALLOW a transfer the registry forbids — reverts fail closed",
      },
    ],
    residualRecommendations:
      "pin the hook program by deploy-time hash, verify it against the PDA registry at every " +
      "furlpay release, and monitor withheld-fee accounts for anomalous accrual (a stuck-fee " +
      "signature of a wedged hook).",
  };
}

module.exports = {
  MAX_BPS,
  calculateTransferFee,
  scaledUiAmount,
  rawForScaledUi,
  transferWithFeeAndInterest,
  evaluateCompliantTransfer,
  auditHookBypassVectors,
  COMPLIANCE_DECISIONS,
};

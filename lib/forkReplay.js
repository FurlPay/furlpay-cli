"use strict";

// ---------------------------------------------------------------------------
// Fork Replay Audit — OFFLINE, deterministic safety analysis.
//
// What an address CAN be audited for WITHOUT touching any network: its
// script-type class, and what that class means for each fork's replay
// protection protocol. This is the Phase-1 "eligibility / security-check"
// surface — a risk ASSESSMENT, never a proof of eligibility, and never a
// claim that funds exist. Live balance/sweep verification is Phase 3 and is
// NOT IMPLEMENTED here; the audit says so on every result.
//
// Address classes (Bitcoin, pre-fork UTXOs):
//   P2PKH  — "1…"          legacy pay-to-pubkey-hash
//   P2SH   — "3…"          script hash (incl. multisig)
//   P2WPKH/P2WSH — "bc1q…" native segwit
//   P2TR   — "bc1p…"       taproot
// Invalid strings fail closed with a named reason.
// ---------------------------------------------------------------------------

const ADDRESS_CLASSES = {
  p2pkh: { prefixes: ["1"], label: "Legacy Pay-to-PubKey-Hash" },
  p2sh: { prefixes: ["3"], label: "Script Hash (P2SH)" },
  bech32: { prefixes: ["bc1q"], label: "SegWit v0 (P2WPKH/P2WSH)" },
  taproot: { prefixes: ["bc1p"], label: "Taproot (P2TR)" },
};

function classifyAddress(address) {
  const a = String(address || "").trim();
  if (!a) return { ok: false, reason: "address is required" };
  for (const [kind, def] of Object.entries(ADDRESS_CLASSES)) {
    if (def.prefixes.some((p) => a.startsWith(p))) {
      return { ok: true, kind, label: def.label, address: a };
    }
  }
  return {
    ok: false,
    reason:
      "unrecognized address format — expected a pre-fork Bitcoin address " +
      "(1…, 3…, bc1q…, bc1p…); bech32m and non-BTC encodings are refused",
  };
}

/**
 * Replay-risk audit for ONE address against ONE declared fork.
 *
 * Returns a deterministic verdict shaped for both the CLI and the MCP tool:
 *   { riskLevel, requiresMitigation, mitigation, notes, disclaimer }
 * Risk levels: "low" (native protection) | "high" (mitigation REQUIRED).
 * Everything is computed from the registry declaration + the address class —
 * zero network calls, zero randomness, same input ⇒ same verdict.
 */
function auditReplayRisk(address, fork) {
  const cls = classifyAddress(address);
  if (!cls.ok) {
    return { ok: false, reason: cls.reason, address: String(address || "") };
  }
  const proto = fork.replayProtocol;
  let riskLevel;
  let requiresMitigation;
  let mitigation = proto.mitigation;
  let notes;

  switch (proto.kind) {
    case "built-in-two-way":
      riskLevel = "low";
      requiresMitigation = false;
      notes =
        "Native two-way replay protection: sweeps cannot replay on the parent " +
        "chain regardless of address class.";
      break;
    case "opt-in-sighash":
      riskLevel = "high";
      requiresMitigation = true;
      notes =
        "Replay protection is OPT-IN. Unmitigated sweep transactions can be " +
        "replayed to the parent chain. Every post-split output must be tainted " +
        "(mixed with a post-split-only input) before broadcast.";
      break;
    case "soft-fork-rules":
      riskLevel = "high";
      requiresMitigation = true;
      notes =
        "Protection derives from soft-fork rules and requires an explicit " +
        "OP_RETURN payload barrier (>83 bytes) on every sweep transaction.";
      break;
    default:
      // Unknown protocol in the registry fails closed.
      riskLevel = "high";
      requiresMitigation = true;
      notes = "Unknown replay protocol — fail closed, treat as requiring mitigation.";
  }

  return {
    ok: true,
    address: cls.address,
    addressClass: cls.kind,
    addressClassLabel: cls.label,
    fork: fork.symbol,
    replayProtocol: proto.kind,
    riskLevel,
    requiresMitigation,
    mitigation: requiresMitigation ? mitigation : "none-required",
    notes,
    disclaimer:
      "OFFLINE RISK ASSESSMENT ONLY — this audit proves nothing about whether " +
      "funds exist at this address, the snapshot balance, or on-chain " +
      "eligibility. Live verification is Phase 3 and is NOT IMPLEMENTED in " +
      "this build.",
  };
}

module.exports = { classifyAddress, auditReplayRisk, ADDRESS_CLASSES };

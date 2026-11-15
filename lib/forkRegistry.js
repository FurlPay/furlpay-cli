"use strict";

// ---------------------------------------------------------------------------
// Fork Registry — declared metadata for supported 2026 Bitcoin fork networks.
//
// HONESTY CONTRACT. Every entry below is a DECLARATION from the integration
// blueprint, NOT an independently verified on-chain fact: snapshot heights
// and venue lists are recorded as `unverified-declaration` until a live RPC
// or exchange API confirms them. Nothing here moves money, queries a network,
// or implies an exchange integration exists — Phase 3 (venue adapters,
// settlement) is NOT IMPLEMENTED in this build and every capability flag
// below says so explicitly.
//
// The registry is data, deliberately dependency-free, so both the CLI
// (`furlpay fork …`) and the MCP read-only tools serve identical facts.
// ---------------------------------------------------------------------------

const FORKS = [
  {
    symbol: "BTCB2",
    name: "Bitcoin BLAKE2b",
    snapshotBlocks: [961631, 961640],
    replayProtocol: {
      kind: "opt-in-sighash",
      description:
        "Replay protection is opt-in via SIGHASH flags; without mitigation, " +
        "transactions can replay on the parent chain. Requires post-split output tainting.",
      mitigation: "psbt-tainter",
    },
    tooling: "PSBT Tainter (mixes post-split outputs)",
    venues: ["AltQuick", "NonLogs"],
    settlementRail: "cex-spot-to-usdc",
    capabilities: {
      registry: true,
      replayAudit: true,
      marketIntel: false,
      execution: false,
      settlement: false,
    },
    verification: "unverified-declaration",
  },
  {
    symbol: "BTC1",
    name: "Bitcoin Purity",
    snapshotBlocks: [961637],
    replayProtocol: {
      kind: "soft-fork-rules",
      description:
        "Protection comes from soft-fork consensus rules; a payload barrier " +
        "(OP_RETURN, >83 bytes) is still required on sweep transactions.",
      mitigation: "opreturn-payload",
    },
    tooling: "OP_RETURN Payload Generator (>83B)",
    venues: ["Solo OTC Desks"],
    settlementRail: "otc-desk-to-usdc",
    capabilities: {
      registry: true,
      replayAudit: true,
      marketIntel: false,
      execution: false,
      settlement: false,
    },
    verification: "unverified-declaration",
  },
  {
    symbol: "ECX",
    name: "eCash",
    snapshotBlocks: [973728],
    replayProtocol: {
      kind: "built-in-two-way",
      description:
        "Native two-way replay protection: no cross-chain tainting is needed " +
        "and sweep transactions cannot replay on either chain.",
      mitigation: "none-required",
    },
    tooling: "Native signing (zero tainting)",
    venues: ["Orca DEX (wECX)"],
    settlementRail: "solana-amm-to-usdc",
    capabilities: {
      registry: true,
      replayAudit: true,
      marketIntel: false,
      execution: false,
      settlement: false,
    },
    verification: "unverified-declaration",
  },
];

/** All declared fork networks, sorted by symbol. */
function listNetworks() {
  return FORKS.slice().sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** One fork by symbol (case-insensitive), or null. */
function inspectNetwork(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  return FORKS.find((f) => f.symbol === sym) || null;
}

module.exports = { FORKS, listNetworks, inspectNetwork };

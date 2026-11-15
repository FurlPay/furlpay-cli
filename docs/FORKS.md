# Fork Asset Operations (BTCB2, BTC1, ECX)

> Phase 1 (read-only intelligence + safety auditing) is implemented. Phase 2
> (offline sweep artifact utilities) is implemented. Phase 3 (venue adapters,
> execution, settlement) is **NOT IMPLEMENTED** — every Phase-3 command
> refuses with `NOT_IMPLEMENTED` and exit 1; nothing is simulated.

## Phase 1 — registry & replay audit

```bash
# Declared networks (registry metadata — unverified-declaration)
furlpay fork networks
furlpay fork inspect BTCB2

# Offline replay-risk audit of a pre-fork Bitcoin address
furlpay fork eligibility BTCB2 --address <pre-fork-btc-address>
furlpay fork security-check BTC1 --address <pre-fork-btc-address>
```

| Fork | Snapshot blocks | Replay protocol | Mitigation |
|---|---|---|---|
| BTCB2 (Bitcoin BLAKE2b) | 961631 / 961640 | Opt-in SIGHASH | **PSBT tainter required** — unmitigated sweeps can replay to the parent chain |
| BTC1 (Bitcoin Purity) | 961637 | Soft-fork rules | **OP_RETURN payload barrier (≥83 bytes) required** |
| ECX (eCash) | 973728 | Built-in two-way | None required — native protection |

**Audit semantics:** the replay audit is an OFFLINE risk assessment of the
address class × the fork's replay protocol. It proves nothing about whether
funds exist at the address, the snapshot balance, or on-chain eligibility —
live verification is Phase 3 and does not exist in this build. Unrecognized
address formats (including EVM encodings) fail closed.

## Phase 2 — sweep artifact utilities (offline)

```bash
# Slippage simulation over a SUPPLIED depth snapshot (no live venue data)
furlpay fork simulate BTCB2 --book depth.json --amount 2 --side buy --max-slippage-bps 400

# BIP-174 PSBT wire review (magic, input/output counts — review only)
furlpay fork psbt-inspect <psbt-hex>

# BTC1 OP_RETURN payload barrier script (≥83 bytes enforced)
furlpay fork opreturn <payload-hex>

# BTCB2 per-output taint plan (mitigation steps for your wallet software)
furlpay fork taint-plan <psbt-hex>
```

**Artifact semantics:** the OP_RETURN scriptHex and taint plans are INPUTS to
your wallet software (which builds and signs the actual transaction). This
CLI never broadcasts, never holds keys, and never claims a transaction
happened. The taint plan maps every PSBT output to
`mix-with-post-split-input` — the mitigation that makes the composite tx
invalid on the parent chain.

**Slippage simulation semantics:** integer-minor math (BigInt), deterministic
regardless of file ordering, depth refusals name the fillable amount,
slippage-cap refusals fire before any fill claim, boundary at exactly-cap
passes. The simulator NEVER fetches live market data — `fork market` remains
NOT_IMPLEMENTED.

## Phase 3 — NOT IMPLEMENTED

`fork market / plan / liquidate / status / report` refuse with
`NOT_IMPLEMENTED` (exit 1): venue adapters (AltQuick, NonLogs, Orca),
staged-limit execution and USDC settlement do not exist in this build. No
price, plan or receipt is available to show — nothing is simulated.

## MCP exposure (read-only)

AI agents get Phase-1 research via three read-only tools:
`fork_list_networks`, `fork_inspect_network`, `fork_replay_check` — all
`readOnlyHint: true`. Per the architectural axiom, agents have research
rights only; execution requires human-authorized, risk-engine-gated paths.

## Registry verification status

All registry metadata (snapshot blocks, venues, settlement rails) carries
`verification: "unverified-declaration"` — declared by the integration
blueprint, not yet confirmed against live fork RPCs. Snapshot heights and
venue lists will move to `verified` only after an RPC/exchange check lands.

# Fork Assets & Replay Risk (`furlpay fork`)

Read-only tooling for declared Bitcoin fork assets — an offline replay-risk auditor and a declared registry. Phase-3 surfaces (market, simulate-and-broadcast, plan, liquidate, settlement) **refuse with `NOT_IMPLEMENTED`** — nothing is simulated and nothing is broadcast.

## Commands

```bash
# Declared fork registry (BTCB2, BTC1, ECX — unverified declarations)
furlpay fork networks
furlpay fork inspect --network BTCB2

# Offline replay-risk audit + eligibility
furlpay fork replay-check --network BTCB2 --utxo-set utxos.json
```

## What "unverified declaration" means

The registry records what the fork projects *declare* about themselves. The CLI does not endorse chain identities — the replay-risk audit exists precisely because a declared fork can reorg, replay or double-count balances. Treat registry entries as claims, not facts.

## Sweep artifacts (Phase 2, offline)

When you are ready to plan a sweep *on paper*, the artifact builders in [Market Data & Microstructure](/guide/market-data) produce review-only PSBT inspections, OP_RETURN barriers and per-output taint plans — with the BIP-62 minimal-push and little-endian varint rules enforced.

## MCP exposure

Read-only: `fork_list_networks`, `fork_inspect_network`, `fork_replay_check`. No mutating fork tool exists.

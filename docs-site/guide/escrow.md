# Escrow — the ETSS Protocol (`furlpay escrow`)

A deterministic escrow state machine persisted across invocations in a durable local ledger at `~/.furlpay/escrows.json` — atomic writes, `0600` on POSIX, symlink refusal.

```
CREATED → FUNDED → DELIVERY_PENDING → PROOF_SUBMITTED → RELEASED
                    ↘ DISPUTED → REFUND_PENDING → REFUNDED ↗
```

::: warning Honesty label
This is a **local escrow ledger** (state machine + audit log on disk). No on-chain escrow contract is deployed, and no funds move except the transactions you reference via `--tx-hash`. The CLI never fabricates a transaction hash.
:::

## Full lifecycle

```bash
# 1. Create an escrow with a pre-agreed SHA-256 delivery proof commitment
furlpay escrow create \
  --seller 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  --arbiter 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  --amount 5000 \
  --timeout-days 7 \
  --proof-hash 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

# 2. Buyer funds (requires the real funding transaction hash)
furlpay escrow fund --escrow-id escrow_1710000000000 --tx-hash 0x<your funding tx>

# 3. Seller starts delivery, then submits the cryptographic delivery proof
furlpay escrow start-delivery --escrow-id escrow_1710000000000
furlpay escrow proof --escrow-id escrow_1710000000000 --hash 0x<sha256> --signature <sig>

# 4. Release funds to the seller (buyer approval; auto-release timer also supported)
furlpay escrow release --escrow-id escrow_1710000000000 --tx-hash 0x<settlement tx>

# Dispute path
furlpay escrow dispute --escrow-id escrow_1710000000000 --reason "delivery did not match spec"

# Inspect the ledger (--verbose shows the immutable transition audit log)
furlpay escrow status [--escrow-id escrow_1710000000000] [--verbose]
```

## Cryptographic proof verification

A delivery proof is only accepted when **all three** hold:

1. **Seller signature** — the proof must carry a real ECDSA signature, verified by `ethers.verifyMessage` against the escrow's seller of record. Legacy attestation strings like `sim:local-cli-attestation` are refused outright.
2. **Spec hash equality** — the proof hash must equal the `deliverySpecHash` locked at creation. A seller cannot substitute an arbitrary hash.
3. **Ledger clock** — `submittedAt` is replaced by the local ledger clock at submission. A caller-supplied `submittedAt: 0` (which would trigger immediate auto-release) is discarded.

## Failure modes that fail closed

- Unauthorized actors at every transition (`Only buyer`, `Only seller`, `counterparties` errors)
- Malformed proof hashes (must be 32-byte hex)
- Double-release and any mutation after a terminal state (`Invalid state transition`)
- A funding or release attempt without a real `--tx-hash`
- Corrupt or unrecognized store files refuse loudly (`corrupt`, `unrecognized format`)
- Symlinked store files are refused (path-traversal hardening)

# Use Cases & Workflows

End-to-end recipes for the things people actually do with the CLI. Each one composes the surfaces documented in the Guide — nothing here requires a feature the CLI doesn't honestly have.

## 1. Pay a vendor from a headless server

*You run invoicing automation on a Linux box and need scheduled stablecoin payouts with an audit trail.*

```bash
# One-time setup: authenticate (email OTP — no browser needed)
furlpay login --email ops@company.com

# Pre-flight: everything the script will rely on
furlpay doctor && furlpay config validate

# The payout — stable idempotency key means a cron re-run can't double-pay
furlpay pay '@acme-supplier' 2500 USD --yes --json \
  --idempotency-key inv-2026-11-0042 \
  | tee -a /var/log/furlpay/payments.jsonl
```

Why it's safe on a server: the session cookie is read-only; the payment requires explicit `--yes`; a transport fault returns `status: "unknown"` with the idempotency key for reconciliation — **never** an automatic retry under a fresh key.

## 2. First live perp trade with training wheels

*You want real Hyperliquid execution with the smallest possible blast radius.*

```bash
# Delegated agent key — master key stays cold
furlpay wallet agent-keygen --name hl-trader-01
export HYPERLIQUID_PRIVATE_KEY=0x<agent_key>
export FURLPAY_HL_TESTNET=0

# Caps first, always
furlpay trading limits --max-single-order 25 --max-leverage 3

# Read the market before touching it
furlpay hyperliquid status
furlpay market BTC --slippage 0.5 --side buy

# Micro limit order at the bid, then verify it's resting
furlpay hyperliquid trade --symbol BTC --side buy --size 0.001 --leverage 2 --limit <bid>
furlpay account orders

# Cancel, then a market fill with an immediate reduce-only close
furlpay trade cancel <order_id> --symbol BTC
furlpay hyperliquid trade --symbol BTC --side buy --size 0.001 --leverage 2
furlpay account positions
furlpay hyperliquid close BTC
```

## 3. Let Claude manage a trading wallet — safely

*You want an AI agent that can trade while you're away, without giving it the keys to everything.*

```bash
# 1. The mandate: $50/day, $10/transaction, whitelisted assets, 7-day expiry
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --single-tx-cap 10.00 \
  --allowed-assets USDC,BTC,ETH,HYPE \
  --expiry 7d
```

```json
// 2. claude_desktop_config.json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "furlpay",
      "args": ["mcp", "--wallet", "agent-alpha"]
    }
  }
}
```

```text
3. In Claude: "Check my Hyperliquid balance and place a $5 long on BTC-PERP."
   → every mutating tool call hits the file-locked policy ledger first,
   → and requiresUserInteraction prompts you [y/N] before anything signs.
```

If the model gets prompt-injected into "send $100k", the policy gate refuses before an HTTP request exists, and the refused attempt lands in the spend ledger under the agent's name.

## 4. Escrow a freelance delivery

*Designer delivers assets; you release funds on proof — without a platform's escrow fee.*

```bash
# Agree on the deliverable's SHA-256 up front (the "deliverySpecHash")
furlpay escrow create --seller 0x7099… --arbiter 0x3C44… \
  --amount 5000 --timeout-days 7 \
  --proof-hash 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

# Fund with your real on-chain tx
furlpay escrow fund --escrow-id <id> --tx-hash 0x<fund_tx>

# Seller: start delivery, then submit the ECDSA-signed proof over the spec hash
furlpay escrow start-delivery --escrow-id <id>
furlpay escrow proof --escrow-id <id> --hash 0x2cf2… --signature <seller_sig>

# You: verify, then release
furlpay escrow release --escrow-id <id> --tx-hash 0x<payout_tx>

# Anywhere along the way: the immutable audit log
furlpay escrow status --escrow-id <id> --verbose
```

A forged signature, a substituted hash, or a backdated `submittedAt: 0` — all fail closed (see [Escrow](/guide/escrow)).

## 5. Due diligence on a Bitcoin fork airdrop

*Twitter says BTCB2 will snapshot soon. Check whether claiming is even sane before touching keys.*

```bash
furlpay fork networks                 # the declared registry — claims, not facts
furlpay fork inspect --network BTCB2
furlpay fork replay-check --network BTCB2 --utxo-set utxos.json

# Paper-plan the sweep — review-only, never broadcast
furlpay fork simulate --network BTCB2 --depth depth.json --size 0.5
furlpay fork taint-plan --network BTCB2 --utxo utxo.json
```

If a Phase-3 surface is ever invoked it refuses with `NOT_IMPLEMENTED` — the CLI will not simulate having claimed or moved fork funds.

## 6. Treasury yield sweep with monitoring

*Idle USDC on Hyperliquid should earn, in sized steps, with eyes on the vault.*

```bash
furlpay earn hlp stats                      # live equity/APY/PnL — no fabrication
furlpay earn hlp deposit 1000               # real signed vaultTransfer (4-day lockup!)
furlpay account balance                     # watch margin state
# Later:
furlpay earn hlp withdraw 100
```

Or from an agent: `furlpay_sweep_treasury` with an explicit `amountUsd` (a missing amount is **refused**, never defaulted) under the same policy ledger as trading.

## 7. Verify a payment actually settled

*Someone sends you a tx hash. Confirm it independently.*

```bash
furlpay tx verify <64-hex-hash> --network mainnet
```

The output distinguishes `CONFIRMED_SUCCESS` from `CONFIRMED_FAILED`, and a `NOT_FOUND` explicitly says it is *not proof of absence* — an outage (`UNAVAILABLE`) is never evidence about the transaction either.

## 8. Research desk: microstructure before every trade

```bash
furlpay market BTC                        # live L2, OFI, micro-price
furlpay microstructure analytics --book btc_depth.json
furlpay microstructure vpin --tape btc_trades.json --bucket 1000
furlpay microstructure quotes --book btc_depth.json --inventory +0.5 --risk 0.1
```

The same three indicators gate `furlpay short signal` — analysis informs, the risk engine decides.

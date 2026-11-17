# MAINNET TESTING RUNBOOK

**Rule zero:** a general request to prepare the system is **not** authorization to trade. Every real-money order requires its own explicit, transaction-specific human confirmation — in an interactive terminal, for that exact asset/side/size. Nothing in this CLI trades autonomously.

## Stage A — Offline (run any time; no credentials)

```bash
npm run typecheck
npm test
```

Gate: full chain green (typecheck + every suite incl. `mainnet-gate`, `mcp-hardening`, `audit-2026-11-17b`). The HLP wire format, lockup guard, ETSS rehydration, turnover persistence, agent-key containment and redaction are all pinned here.

## Stage B — Testnet sandbox (real testnet auth, no mainnet money)

```bash
export FURLPAY_HL_TESTNET=1
export HYPERLIQUID_PRIVATE_KEY=0x...      # testnet API wallet (pip into a file? no — env only)
furlpay mainnet status                    # confirms network: testnet for the HL family
furlpay account balance
furlpay hyperliquid trade --symbol BTC --side buy --size 0.001 --leverage 1
furlpay account positions
furlpay trading kill-switch --symbol BTC
```

Gate: auth accepted, order submitted, position visible, cancel/kill-switch clean, blotter row appended (`~/.furlpay/blotter/`). **Never silently fall back:** `furlpay mainnet status` must say testnet before you proceed, and mainnet commands must say mainnet.

## Stage C — Mainnet read-only (no signer needed for most checks)

```bash
furlpay mainnet readiness          # exit 0 only when every blocking check passes
furlpay mainnet readiness --output json
furlpay mainnet status
furlpay hyperliquid status && furlpay hyperliquid markets
furlpay oracle price USDC          # cross-source agreement gate
furlpay solana status && furlpay tx verify <hash> --network mainnet
```

Gate: `readiness` verdict `ready` — meaning runtime, config, master gate, signer, mainnet reachability, peg sanity, oracle agreement, risk limits and ledger writability all PASS. A peg `BLOCKED` or oracle disagreement stops here by design.

**Dry run (still Stage C — never signs):**

```bash
furlpay mainnet dry-run BTC --side buy --size 0.001 --leverage 1
furlpay mainnet dry-run BTC --side buy --size 1 --leverage 1     # must REFUSE: > $50k single-order cap
```

The first evaluates clean; the second must print the risk-engine refusal. If a dry run ever claims to have signed anything, stop — that would be a defect.

## Stage D — Controlled live execution (requires everything below)

Pre-flight, in order:

1. `furlpay mainnet readiness` → verdict `ready` (exit 0).
2. Funded mainnet account **you control**; USDC already in it. Minimum practical size ($50–$100).
3. Risk caps set deliberately: `furlpay trading limits` — for a first validation set the single-order cap ≤ $20.
4. `FURLPAY_LIVE=1` exported, signer key in the environment (never argv).
5. Exact preview shown by the command output (asset, network, side, size, leverage). If any material field differs from what you approved, abort.

Execution:

```bash
furlpay hyperliquid trade --symbol BTC --side buy --size 0.0002 --leverage 1
```

Only run this when **you** have decided on that exact order. Do not automate it. Do not let an agent do it.

Post-trade verification (all three, before considering anything done):

```bash
furlpay account positions                          # position must exist at expected size
furlpay account balance                            # equity moved by ~notional + fee
furlpay hyperliquid close BTC                     # de-risk immediately after validation
```

A `200` from the exchange is not proof of fill — reconcile by order id and positions. An ambiguous submission is **never** retried blindly; reconcile by `cloid`/order id first.

## Emergency stop

```bash
furlpay trading kill-switch --symbol BTC     # scoped (M-05)
furlpay trading kill-switch                  # account-wide
unset FURLPAY_LIVE                           # master gate: every signing surface goes inert
```

## Incident note

If a submission's outcome is unknown (timeout, disconnect), do not resubmit. Query `furlpay account positions` and `furlpay account orders`; reconcile by client order id; only then decide. Record the outcome in the blotter (`~/.furlpay/blotter/`).

## What this runbook deliberately does not cover

- HLP deposits/withdrawals are **not** part of first trading validation (4-day lockup).
- Binance mainnet: same staged protocol with testnet first; withdrawals are structurally absent.
- Stellar mainnet orders: blocked on funded account + trustlines + SEP-8 approvals; fail-closed.
- No legal/geo eligibility is granted by passing these gates.

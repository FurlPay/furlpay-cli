# Hyperliquid L1 Perpetuals & the HLP Vault

Hyperliquid perp execution and vault transfers are **LIVE and cryptographically signed** on Layer 1 via EIP-712 Phantom Agent envelopes. Orders serialize to MessagePack, get an 8-byte big-endian uint64 nonce, hash with Keccak-256 and sign over Chain ID `1337`. Zero private keys leave the machine.

## Configure a signer

```bash
export HYPERLIQUID_PRIVATE_KEY=0x...   # or ETH_PRIVATE_KEY
export FURLPAY_HL_TESTNET=0            # 1 for testnet, 0 for mainnet
```

::: danger Never the master key on a trading box
Generate a delegated **API Agent Wallet** (`furlpay wallet agent-keygen`), approve it with your master key on Hyperliquid (`approveAgent` L1 action), and export the *agent* key. Top desks never put master withdrawal keys on trading servers. A missing signer fails closed — every signed surface refuses.
:::

## Pre-trade risk engine (set these first)

```bash
# Hard caps enforced before any order is built
furlpay trading limits --max-single-order 25 --max-leverage 3

# Emergency stop for one symbol
furlpay trading kill-switch --symbol BTC
```

## Market data (no signer needed)

```bash
# Validator connectivity, active universe, canonical HLP vault
furlpay hyperliquid status

# Tradeable contracts: mark price, funding, open interest
furlpay hyperliquid markets

# Realtime L2 book, depth bands (10/25/50 bps), OFI, micro-price, slippage
furlpay market BTC
furlpay market BTC --slippage 0.5 --side buy
```

## Execute

```bash
# Micro limit order (recommended first live trade)
furlpay hyperliquid trade --symbol BTC --side buy --size 0.001 --leverage 2 --limit <bid_price>

# Market order (IOC; default slippage buffer 50 bps — institutional default,
# widen explicitly with --slippage if you must)
furlpay hyperliquid trade --symbol BTC --side buy --size 0.001 --leverage 2

# Inspect equity, margin ratio, unrealized PnL, positions, resting orders
furlpay account balance
furlpay account positions
furlpay account orders

# Cancel / close
furlpay trade cancel <order_id> --symbol BTC
furlpay hyperliquid close BTC   # reduce-only market close
```

## HLP vault (4-day protocol lockup!)

```bash
furlpay earn hlp stats       # live equity/APY/PnL from the /info vault response
furlpay earn hlp deposit 10  # real signed vaultTransfer
furlpay earn hlp withdraw 100
```

**Data provenance:** `earn hlp stats` derives equity, APY and all-time PnL from the live `vaultDetails` payload. Fields the public API does not report (share price, open position count) render as *unavailable* — never fabricated benchmarks. If the exchange ever omits a transaction hash, the operation reports `PENDING_CONFIRMATION` instead of inventing an `hlp_dep_` id.

## Negative numbers are real

PnL, funding and fees flow through fixed-point decimal math that handles fractional negatives correctly (`-0.50` stays minus fifty cents). A liquidation-price or margin check will never see an inverted sign.

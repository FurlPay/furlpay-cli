# Examples — trading & market data (11–18)

## 11. Two-phase transaction confirmation (MCP)

```jsonc
// Step 1 — preview (executes nothing, binds the args to a hash)
{ "tool": "furlpay_preview_execution",
  "args": { "tool": "furlpay_trade",
            "args": { "side": "buy", "asset": "USDC", "amount": 25, "price": 1.00 } } }
// → { executionHash: "…", netEffect: … }

// Step 2 — confirm with the hash, within 10 minutes, exactly once
{ "tool": "furlpay_confirm_execution", "args": { "executionHash": "<from step 1>" } }
```

Semantics: the policy gate re-runs on the **stored** amount at confirm time;
the hash is single-use; attempts and refusals both land in
`~/.furlpay/mcp-audit.jsonl` (args hash only, never raw arguments).

## 12. x402 payment challenge (SIMULATED)

```bash
furlpay x402 pay \
  --challenge-header 'WWW-Authenticate: x402 recipient="GBLX99API", amount="0.0005", token="USDC"' \
  --max-cost 0.005
```

Status: **SIMULATED / LOCAL_SIMULATION** — no live facilitator exists in this
build, and the response says so on every field. Replay protection runs
against a file-locked nonce ledger. Nothing here moves value.

## 13. Stellar SDEX trading (labeled simulation)

```bash
furlpay trade limit \
  --side buy \
  --asset JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ \
  --against USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  --amount 25 \
  --price 104.20
```

Status: **SIMULATED** — a deterministic local simulation of Horizon
submission; no transaction is broadcast. Results carry the simulated label
(audit H-03: the CLI prints the simulation status rather than a checkmark).
Regulated-asset trades report `sep8Status: "not_performed"` — compliance is
never claimed.

## 14. Hyperliquid market data (LIVE)

```bash
furlpay hyperliquid status
furlpay hyperliquid markets
furlpay market BTC --slippage 0.5 --side buy
```

Real `/info` responses from Hyperliquid validators: validator connectivity,
mark price, funding, open interest, L2 depth bands, OFI and micro-price.
No credentials needed — this plane is read-only.

## 15. Hyperliquid signed perp order (LIVE — real funds)

> **Risk: this places a real, signed order on Hyperliquid L1.** Size it as
> if it were your money, because it is.

```bash
export HYPERLIQUID_PRIVATE_KEY=0x...   # API wallet recommended
furlpay hyperliquid trade --symbol BTC --side buy --size 0.05 --leverage 5 --limit 75000
```

The pre-trade risk engine runs **fail-closed**: asset metadata, L2 book and
clearinghouse-state fetch failures refuse the order instead of skipping the
guard; the USDC peg guardrail ingests USDC/USD (a feed outage is a warning,
never depeg evidence); notional/turnover/margin math is scaled-BigInt.
Without `FURLPAY_LIVE=1` the master gate keeps the surface inert.

## 16. Hyperliquid shorting (LIVE — real funds)

```bash
export HYPERLIQUID_PRIVATE_KEY=0x...
furlpay hyperliquid trade --symbol BTC --side sell --size 0.05 --leverage 5
furlpay account positions          # watch the short
furlpay hyperliquid close BTC      # market buy-back
```

Readiness research before entry (read-only, over **your supplied** data —
never an execution trigger):

```bash
furlpay short signal --book depth.json --tape trades.json --bucket 1000
```

Binance futures shorts are NOT IMPLEMENTED (declared false in the capability
registry — there is no method on the surface).

## 17. HLP vault information (LIVE)

```bash
furlpay earn hlp stats
```

Equity/APY/PnL derived from the live `/info` vault response. Fields the
public API does not report (share price, open position count) print as
**unavailable** — never fabricated benchmarks.

## 18. HLP deposit / withdraw (LIVE — real funds)

> **Risk: these are real signed `vaultTransfer` actions.** Deposits and
> withdrawals carry Hyperliquid's 4-day withdrawal lockup; the CLI checks
> lockup eligibility client-side before signing (durable deposit timestamps —
> audit H-04 fix).

```bash
export HYPERLIQUID_PRIVATE_KEY=0x...
furlpay earn hlp deposit 1000
furlpay earn hlp withdraw 100
```

Fail-closed without a configured signer: the CLI refuses rather than
simulating.

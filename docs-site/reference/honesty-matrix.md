# Honesty Matrix — Live vs. Simulated

Every execution surface in this CLI is **labeled at runtime**. This table is the authoritative summary; where code and marketing ever disagree, the runtime label wins.

| Surface | Status | Notes |
|---|---|---|
| Hyperliquid market data (`market`, `hyperliquid markets/status`) | **LIVE** | Real `/info` responses from Hyperliquid validators |
| Live trade terminal (`furlpay live <SYM>`) | **LIVE (data) + LOCAL (render)** | Real Hyperliquid WebSocket (`l2Book` + `trades`) through the streaming state machines: feed regression freezes the book (never renders stale as current), disconnect renders DISCONNECTED — never a fake book. Gauges (OBI, micro-price, rolling VPIN, optional GLFT quotes) computed on the live feed. The terminal NEVER places, signs or broadcasts: [Space] PANIC prints the signed kill-switch command and only spawns it with `--allow-panic` (that command still runs the risk engine and fails closed without a signer) |
| Transaction verification (`tx verify`) | **LIVE (lookup)** | Real Horizon `GET /transactions/{hash}`; distinguishes confirmed-success / confirmed-failed / not-found / invalid / unavailable; explicitly an API lookup, never claimed as cryptographic re-verification |
| Testnet faucet (`faucet`) | **LIVE** | Real Friendbot funding on testnet/futurenet only (mainnet refused); `FUNDED` requires the Friendbot's own successful response + independent Horizon balance check |
| Config validation (`config validate`) | LOCAL | Structural checks on the local config; no network calls |
| Diagnostics (`doctor`) | LIVE checks | Real connectivity/registry checks; exits non-zero when the API liveness check fails |
| HLP vault stats (`earn hlp stats`) | **LIVE** | Equity/APY/PnL derived from live `vaultDetails`; unreported fields → unavailable, never fabricated |
| HLP deposit / withdraw | **LIVE (signed)** | Real EIP-712 `vaultTransfer` actions; fail closed without `HYPERLIQUID_PRIVATE_KEY`/`ETH_PRIVATE_KEY`; missing tx hash → `PENDING_CONFIRMATION`, never a synthetic id |
| Hyperliquid perp execution (`hyperliquid trade`) | **LIVE (signed)** | Requires configured signer; pre-trade risk engine enforced |
| Bitcoin shorting (execution via `hyperliquid trade --side sell`) | **LIVE (execution)** / ANALYSIS (signals) | Short execution is the same signed EIP-712 path as any Hyperliquid order. `short signal` is read-only OBI/microprice/VPIN research over supplied data — never an execution trigger |
| Escrow (`furlpay escrow`) | LOCAL LEDGER | Deterministic state machine + audit log at `~/.furlpay/escrows.json`; fund/release require real `--tx-hash` (never fabricated); cryptographic seller-signature proof verification; no on-chain contract deployed |
| Streaming engine (`L2DeltaBook` / `RollingVpin` / `WsConnectionManager`) | IMPLEMENTED (state machines, transport-agnostic) | Sequence-gap poisoning forces REST resync; rolling VPIN emits on bucket completion; exponential backoff + heartbeat staleness + subscription dedup/cap. Wire a real socket into `connect()` to go live |
| Binance spot adapter | IMPLEMENTED, TESTNET-BLOCKED | Full unit battery against stubbed transport (14 tests: signing determinism, secret redaction, env separation, error surfacing, gate ordering); live/testnet end-to-end requires API credentials with withdrawals disabled. Exchange errors surface code+message+HTTP status — never a synthetic success |
| Sweep artifact utilities (`fork simulate` / `psbt-inspect` / `opreturn` / `taint-plan`) | IMPLEMENTED (offline) | Integer-minor deterministic math, depth+cap refusals; BIP-174 inspector; BIP-62 minimal-push OP_RETURN; all artifacts review-only — never broadcast. Live venue data: NOT IMPLEMENTED |
| Market microstructure analytics | IMPLEMENTED (offline) | EW-OBI, Stoikov microprice, Easley-VPIN, Avellaneda-Stoikov quotes — pure math over supplied snapshots/tapes |
| Fork operations (`fork networks/inspect/replay-check`) | IMPLEMENTED (read-only) | Offline replay-risk audit + declared registry (BTCB2, BTC1, ECX — unverified declarations). Phase-3 surfaces refuse with `NOT_IMPLEMENTED` — nothing simulated |
| x402 settlement (`x402 pay`, MCP `furlpay_settle_invoice`) | **SIMULATED** | No live TigerBeetle facilitator in this build; responses say `SIMULATED` / `LOCAL_SIMULATION` |
| Stellar SDEX order flow / SEP-8 KYC / Soroban swaps | **SIMULATED** | Deterministic local simulation of Horizon/Soroban submission — no network transactions broadcast. `rwa kyc` reports `NOT_IMPLEMENTED` (exit 1); regulated-asset trade results carry `sep8Status: "not_performed"` — compliance never claimed. Registry carries no hardcoded APY and no invented approval-server URLs |
| MCP `furlpay_balance` (unauthenticated mode) | **SIMULATED** | Sample fixture balances, flagged `simulated: true` |
| FOBXX sweep (`furlpay_sweep_treasury` target FOBXX) | **SIMULATED** | No Stellar Benji contract call in this build; APY is `null` with an explanatory note |

## Environment-key honesty

HLP/perp execution reads `HYPERLIQUID_PRIVATE_KEY` (or `ETH_PRIVATE_KEY`) from the environment — never from argv. Private keys and mnemonics for `wallet import` / `login --key` are accepted on stdin only.

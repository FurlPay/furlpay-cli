# Architecture

All diagrams describe the actual source implementation (audited 2026-11-17).
Module paths are clickable truth: if a box names `src/...`, that file exists
and behaves as drawn.

## 1. Entry point & dispatcher

`bin/furlpay.js` routes by command; the TS execution surface is lazy-loaded
from `dist/` only for the commands that need it.

```mermaid
flowchart TD
    argv["furlpay <command> …"] --> BIN["bin/furlpay.js<br/>(JS dispatcher, parseFlags)"]
    BIN -->|hyperliquid, trade, escrow,<br/>finance, oracle, solana, wallet…| TS["dist/cli.js<br/>(FurlPayStellarCli, src/cli.ts)"]
    BIN -->|pay, send, balance, travel,<br/>card, invest, dashboard…| JS["lib/commands.js<br/>(hosted-app surface)"]
    BIN -->|mcp without --wallet| JMCP["lib/mcp.js<br/>(research server, 29 tools)"]
    BIN -->|mcp --wallet X| TMCP["src/mcp/server.ts<br/>(execution server, 35 tools)"]
    BIN -->|microstructure, algo, fork,<br/>short, live| LIBS["lib/ engines<br/>(offline analysis / live feed)"]
    BIN -->|update, doctor, completion,<br/>docs| MISC["lib/update, doctor, completion"]
```

## 2. Hosted API vs local vs chain boundaries

```mermaid
flowchart LR
    subgraph FurlPayCLI ["furlpay process"]
        CMDS["commands"]
        KEYSTORE["~/.furlpay<br/>keystore (PBKDF2+AES-256-GCM)"]
        LEDGERS["ledgers<br/>finance · escrow · turnover · blotter"]
    end
    CMDS -->|session cookie, TLS-pinned| HOSTED["furlpay.com /api/*"]
    CMDS -->|EIP-712 signed actions| HL["Hyperliquid L1"]
    CMDS -->|Horizon lookups / Friendbot| STELLAR["Stellar"]
    CMDS -->|JSON-RPC reads only| SOL["Solana"]
    CMDS -->|public price endpoints| ORACLES["Coinbase · Kraken ·<br/>Binance · Jupiter · (Pyth gateway)"]
    KEYSTORE --> SIGNER["wallet signers<br/>(keystore / Ledger / agent keys)"]
    SIGNER --> CMDS
    LEDGERS --> AUDIT["audit logs<br/>(hash-chained, append-only)"]
```

Nothing signs inside the hosted-API plane; chain signatures are produced
locally from the keystore or hardware and only *relayed* where a platform
feature does so explicitly.

## 3. MCP read-only vs execution surfaces (readiness P7)

```mermaid
flowchart TD
    START["furlpay mcp [--wallet name]"] --> GATE{"--enable-execution<br/>AND agent policy on disk?"}
    GATE -->|No| RO["READ-ONLY server<br/>mutating tools ABSENT from tools/list;<br/>direct call → EXECUTION_MODE_REQUIRED"]
    GATE -->|Yes| EX["EXECUTION server (mode: execution)"]
    EX -->|direct mutating call| TP["TWO_PHASE_REQUIRED"]
    EX --> PREVIEW["furlpay_preview_execution<br/>sanitize → bind args → executionHash<br/>(TTL 10 min, single-use)"]
    PREVIEW --> CONFIRM["furlpay_confirm_execution {executionHash}"]
    CONFIRM --> POLICY["agent-policy gate re-run on STORED amount<br/>(OS file lock, atomic record)"]
    POLICY -->|allowed| RUN["execute tool → audit line<br/>(args hash only) → response"]
    POLICY -->|refused| DENY["policy refusal → audit line<br/>counts against 30/min rate limit"]
```

## 4. Pre-trade risk gate (Hyperliquid execution)

```mermaid
flowchart TD
    ORDER["hyperliquid trade / earn hlp deposit"] --> LIVE["assertLiveAllowed()<br/>FURLPAY_LIVE=1 master gate"]
    LIVE --> SIGNER{"signer configured?"}
    SIGNER -->|No| REFUSE1["refuse: fail closed"]
    SIGNER -->|Yes| META["asset metadata + L2 book +<br/>clearinghouse state (fail-closed fetches)"]
    META --> PEG["USDC peg feed (≤30s cadence)<br/>>25bps drift → halt risk-increasing orders<br/>outage → PEG_FEED_UNAVAILABLE warning, never depeg evidence"]
    PEG --> ENGINE["HyperliquidRiskEngine<br/>notional / turnover / margin (scaled-BigInt)<br/>durable daily-turnover ledger"]
    ENGINE -->|pass| SIGN["EIP-712 Phantom Agent →<br/>exchange endpoint"]
    ENGINE -->|fail| REFUSE2["refuse with reason"]
```

## 5. Oracle aggregation & disagreement handling

```mermaid
flowchart LR
    REQ["getQuote(asset)"] --> FAN["fan out to every<br/>supporting provider"]
    FAN --> BAND["sanity band per asset<br/>(e.g. SOL $1–$2000)"]
    BAND --> MED["median of survivors"]
    MED --> DEV{"max pairwise deviation<br/>≤ asset budget (±1–3%)?"}
    DEV -->|Yes| LIVEQ["LIVE — median price"]
    DEV -->|No| DIS["DISAGREEMENT — priceUsd = null,<br/>per-source readings returned<br/>(never blended)"]
    BAND -->|zero survivors| UNA["UNAVAILABLE — priceUsd = null<br/>(nothing guessed)"]
```

## 6. x402 challenge lifecycle (labeled SIMULATED)

```mermaid
flowchart TD
    HDR["WWW-Authenticate: x402 …"] --> PARSE["X402Engine.parseChallenge"]
    PARSE --> GATE{"agent policy loaded?"}
    GATE -->|Yes| POLICY["validateAndRecordSpend<br/>(atomic under policy lock)"]
    POLICY -->|refused| X1["refusal — nothing built"]
    GATE -->|No / pass| SETTLE["settleChallenge →<br/>SIMULATED / LOCAL_SIMULATION<br/>(no TigerBeetle facilitator in this build)"]
    SETTLE --> REPLAY["nonce ledger (file-locked, atomic)<br/>replayed authorizations rejected"]
```

## 7. Escrow state machine (local ledger)

```mermaid
stateDiagram-v2
    [*] --> CREATED: escrow create (proof-hash committed)
    CREATED --> FUNDED: fund --tx-hash (real hash required)
    FUNDED --> PROOF_SUBMITTED: seller submits SHA-256 proof
    PROOF_SUBMITTED --> RELEASED: buyer approves / auto-release timer
    FUNDED --> DISPUTED: dispute
    PROOF_SUBMITTED --> DISPUTED: dispute
    DISPUTED --> RELEASED: arbiter resolves
    CREATED --> REFUNDED: expiry (rehydration-safe: C-01 fix)
    FUNDED --> REFUNDED: expiry / finalizeRefund
    note right of FUNDED
        Persisted in ~/.furlpay/escrows.json
        (atomic writes, 0600, symlink refusal).
        No on-chain escrow contract exists;
        funds move only via the --tx-hash
        transactions you reference.
    end note
```

## 8. Two-plane honesty model

Every surface carries a runtime label backed by the
[Honesty Matrix](/reference/honesty-matrix): **LIVE** (real network, real
signatures where applicable), **LOCAL**, **SIMULATED**, **IMPLEMENTED**
(offline/stub), **BLOCKED**, **NOT IMPLEMENTED**. The label is data on the
result object, not prose — tests pin the labels, and the CLI prints them
alongside every result.

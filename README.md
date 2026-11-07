# @furlpay/cli

FurlPay CLI — Stellar Tokenized Equities & RWAs, SDEX/Soroban Trading, x402 Micropayments & MCP Server.

[![npm](https://img.shields.io/npm/v/%40furlpay%2Fcli?logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@furlpay/cli)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-ES2022-3178C6?logo=typescript&logoColor=white)](src/index.ts)
[![Stellar](https://img.shields.io/badge/Stellar-Protocol_26-black?logo=stellar&logoColor=white)](https://stellar.org)
[![MCP](https://img.shields.io/badge/MCP-server_mode-6E56CF?logo=anthropic&logoColor=white)](#model-context-protocol-mcp-ai-agents)
[![License](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

High-performance terminal execution layer written in TypeScript for connecting Stellar hardware wallets, executing limit orders on the **Stellar Decentralized Exchange (SDEX)**, routing cross-asset liquidity through **Soroban AMMs**, verifying **SEP-8 compliance** on regulated tokenized equities (JQQQ, Securitize NVDA) and money market funds (FOBXX, USTBL), settling **x402 micropayments**, and running autonomous **Model Context Protocol (MCP)** agent trading runtimes.

```bash
npm install -g @furlpay/cli
furlpay wallet connect ledger
furlpay trade terminal --pair JQQQ/USDC
```

---

## System Architecture

### 1. End-to-End System Architecture

```mermaid
graph TD
    subgraph ClientAndRuntimes["Client and Agent Runtimes"]
        TUI["Interactive Terminal UI (ratatui/crossterm style ANSI)"]
        Headless["Headless Scripting and CI Automation"]
        AgentRuntime["Autonomous AI Agent (Claude, Cursor, Gemini MCP)"]
    end

    subgraph CoreEngine["FurlPay CLI Core (TypeScript Engine)"]
        WalletLayer["Wallet Connector Layer (Ledger, SEP-7, Loopback, Keystore, AgentKey)"]
        SOR["Smart Order Router (SDEX CLOB + Soroban AMM + Path Payments)"]
        Compliance["SEP-8 and Compliance Engine (KYC Whitelist and Co-Signer)"]
        AgentTrust["Agent Trust Engine (OFAC/SDN, Velocity and Spend Limits)"]
    end

    subgraph RelayerAndGateway["FurlPay Relayer and Settlement Gateway"]
        Sponsor["Fee-Bump Relayer (Gasless Zero-XLM Trading UX)"]
        TigerBeetle["TigerBeetle Internal Netting Sub-Ledger (x402 Micropayments)"]
    end

    subgraph SettlementLayer["Stellar Network (Protocol 26 Settlement)"]
        SDEX["SDEX Central Limit Order Books (MEV-Free SCP Shuffling)"]
        Soroban["Soroban Smart Contract AMMs (SEP-41 Token Pools)"]
        SAC["Soroban SAC RWA Contracts (FOBXX Benji, JQQQ, USTBL)"]
    end

    TUI --> WalletLayer
    Headless --> WalletLayer
    AgentRuntime --> AgentTrust
    AgentTrust --> WalletLayer

    WalletLayer --> SOR
    SOR --> Compliance
    Compliance --> Sponsor
    AgentTrust --> TigerBeetle

    Sponsor --> SDEX
    Sponsor --> Soroban
    Sponsor --> SAC
```

---

### 2. Multi-Interface Wallet Connectivity Topology

```mermaid
graph TD
    subgraph CustodyAndInterfaces["Wallet Custody and Interface Layer"]
        Ledger["1. Ledger Hardware Wallet (Nano S / X / Stax via APDU USB HID)"]
        Mobile["2. Mobile Wallets via SEP-0007 and WalletConnect v2 (Terminal ASCII QR)"]
        Loopback["3. Browser Extension Loopback (Freighter and Albedo on 127.0.0.1:4024)"]
        Keystore["4. Local Encrypted Keystore (BIP-39 / PBKDF2 / AES-256-GCM)"]
        AgentKey["5. Delegated Agent Session Key (Ephemeral Ed25519 with Policy Limit)"]
    end

    subgraph SignerAbstractionLayer["Signer Abstraction Layer (ISigner)"]
        Signer["Signer Trait Interface: getPublicKey, signTransaction, clearSignVerification"]
    end

    subgraph TradePipeline["Transaction and Execution Pipeline"]
        Builder["Stellar Transaction and Fee-Bump Envelope Builder"]
    end

    Ledger --> Signer
    Mobile --> Signer
    Loopback --> Signer
    Keystore --> Signer
    AgentKey --> Signer

    Signer --> Builder
```

---

### 3. Trade Execution, Smart Order Routing & SEP-8 Compliance Lifecycle

```mermaid
flowchart TD
    UserReq["Trade Request: furlpay trade buy/limit/swap"] --> SOR["Smart Order Router (SOR)"]
    
    SOR --> SDEX_Check["Evaluate SDEX Central Limit Order Book"]
    SOR --> AMM_Check["Evaluate Soroban AMM Pools (SEP-41)"]
    SOR --> Path_Check["Evaluate Cross-Asset Path Payment Multi-Hop Graph"]

    SDEX_Check --> BestRoute["Select Optimal Route with Minimum Slippage"]
    AMM_Check --> BestRoute
    Path_Check --> BestRoute

    BestRoute --> RegCheck{"Regulated Asset? (e.g. JQQQ, FOBXX)"}

    RegCheck -- "Yes (AUTHORIZATION_REQUIRED)" --> SEP8_Query["Query Issuer stellar.toml Approval Server"]
    SEP8_Query --> SEP8_Submit["Pre-flight submit partially signed XDR"]
    SEP8_Submit --> KYC_Gate{"KYC Whitelist Verified?"}
    KYC_Gate -- "Approved" --> SEP8_Attach["Attach Issuer Multi-Sig Co-Signature"]
    KYC_Gate -- "Action Required" --> KYC_Prompt["Return Interactive KYC Onboarding URL"]

    RegCheck -- "No (Standard SAC)" --> SponsorCheck{"--sponsor flag passed?"}
    SEP8_Attach --> SponsorCheck

    SponsorCheck -- "Yes" --> FeeBump["Wrap into Stellar FeeBumpTransaction (Paid by FurlPay Vault)"]
    SponsorCheck -- "No" --> UserFee["User Pays Native XLM Inclusion Fee"]

    FeeBump --> StellarCore["Stellar Core Consensus (SCP 5s Block)"]
    UserFee --> StellarCore

    StellarCore --> Settlement["Finalized Settlement: Randomized Execution and Uniform Price"]
```

---

### 4. Autonomous Agent MCP & x402 Micropayments Workflow

```mermaid
sequenceDiagram
    autonumber
    actor Agent as Autonomous AI Agent (Claude / Cursor / Gemini)
    participant MCP as FurlPay MCP Server (stdio)
    participant Trust as Agent Trust Engine
    participant TB as TigerBeetle Sub-Ledger
    participant Stellar as Stellar Network (Protocol 26)

    Note over Agent,MCP: Machine-to-Machine Commerce / x402 Resolution
    Agent->>MCP: tools/call: furlpay_settle_invoice { challengeHeader, maxCost }
    MCP->>Trust: Validate Policy (OFAC/SDN check, singleTxCap, dailyVelocity)
    Trust-->>MCP: Policy Approved (Clean sanctions score, budget available)
    MCP->>TB: Internal Netting Ledger Transfer (<$0.0001 cost, <1ms)
    TB-->>MCP: Settle Tx furlpay_net_991823
    MCP-->>Agent: { status: "SETTLED", authHeader: "Authorization: x402 ..." }

    Note over Agent,MCP: Automated Idle Treasury Yield Sweeping
    Agent->>MCP: tools/call: furlpay_sweep_treasury { amountUsd: 450.00 }
    MCP->>Stellar: Soroban SAC Deposit into Franklin FOBXX (Benji) Contract
    Stellar-->>MCP: Shares Minted (4.85% APY On-Chain Yield)
    MCP-->>Agent: { status: "SUCCESS", shares_minted: "450.00", apy: "4.85%" }
```

---

## Stellar Commands Reference

### 1. Stellar Wallet & Hardware Custody (`furlpay wallet`)

```bash
# Connect Ledger Nano S/X/Stax over USB HID (derivation: m/44'/148'/0')
furlpay wallet connect ledger --derivation-index 0

# Connect mobile wallets via SEP-0007 / WalletConnect v2 (displays high-contrast ASCII QR)
furlpay wallet connect walletconnect --qr
furlpay wallet connect sep7

# Browser loopback bridge on 127.0.0.1:4024 for Freighter & Albedo extension
furlpay wallet connect extension --port 4024

# Generate delegated session key for autonomous AI agent with spending policy cap
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --allowed-assets USDC,JQQQ,FOBXX \
  --expiry 7d

# Import private key or 12/24-word mnemonic into PBKDF2/AES-256-GCM encrypted keystore
furlpay wallet import --name desk-primary --mnemonic
furlpay wallet list
```

### 2. SDEX & Soroban Trading Execution (`furlpay trade`)

```bash
# SDEX Central Limit Buy Order for Janus Henderson Nasdaq-100 (JQQQ) with gasless sponsorship
furlpay trade limit \
  --side buy \
  --asset JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ \
  --against USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  --amount 25 \
  --price 104.20 \
  --sponsor

# Path payment strict send (market buy) with guaranteed dest_min and zero MEV
furlpay trade market-buy \
  --asset JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ \
  --with USDC \
  --spend 1000.00 \
  --slippage 0.5 \
  --sponsor

# Soroban AMM SEP-41 liquidity pool swap with pre-flight gas simulation
furlpay trade swap \
  --pool-id 7c8e99...SOROBAN_AMM \
  --sell-asset USDC \
  --sell-amount 500 \
  --min-receive 4.88 \
  --asset FOBXX

# Interactive real-time ASCII depth chart & order book
furlpay trade terminal --pair JQQQ/USDC
```

### 3. Order Management (`furlpay order`)

```bash
# List resting open limit orders
furlpay order list --pair JQQQ/USDC

# Inspect specific SDEX order
furlpay order inspect --offer-id 8829104

# Gasless cancellation via Fee-Bump Relayer
furlpay order cancel --offer-id 8829104 --sponsor

# Batch cancel all resting offers for a pair
furlpay order cancel-all --pair NVDA/USDC
```

### 4. Tokenized Stocks & RWAs (`furlpay rwa`)

```bash
# List institutional tokenized equities and money market funds
furlpay rwa list --category equities,treasuries

# Inspect SEP-8 compliance parameters and SEC CIK registry details
furlpay rwa inspect --asset JQQQ
furlpay rwa inspect --asset FOBXX

# Initiate or refresh accredited investor KYC verification
furlpay rwa kyc --asset FOBXX --interactive
```

### 5. HTTP 402 Micropayments (`furlpay x402`)

```bash
# Settle an HTTP 402 payment challenge via TigerBeetle sub-ledger (<$0.0001 cost)
furlpay x402 pay \
  --challenge-header 'WWW-Authenticate: x402 recipient="GBLX99API", amount="0.0005", token="USDC"' \
  --max-cost 0.005
```

---

### 6. Hyperliquid L1 Perpetuals & Microstructure (`furlpay hyperliquid`, `furlpay market`)

```bash
# Check Hyperliquid validator connectivity, active universe, and canonical HLP vault
furlpay hyperliquid status

# List tradeable perpetual contracts with mark price, funding rate, and open interest
furlpay hyperliquid markets

# Realtime L2 order book, depth bands (10/25/50 bps), OFI, micro-price, and slippage
furlpay market BTC
furlpay market BTC --slippage 0.5 --side buy

# Execute authenticated L1 perpetual order via EIP-712 Phantom Agent
furlpay hyperliquid trade --symbol BTC --side buy --size 0.05 --leverage 5 --limit 75000

# Inspect account equity, margin ratio, unrealized PnL, and open positions
furlpay account balance
furlpay account positions

# Manage pre-trade risk controls and emergency kill-switch
furlpay trading limits --max-single-order 50000 --max-leverage 20
furlpay trading kill-switch --symbol BTC

# Inspect and deposit into HLP clearinghouse vault (with 4-day lockup notification)
furlpay earn hlp stats
furlpay earn hlp deposit 1000
```

---

### 7. Escrow & Time-Locked Settlement Scheme (`furlpay escrow`)

```bash
# Create deterministic cryptographic delivery escrow with SHA-256 proof hash
furlpay escrow create \
  --seller 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  --arbiter 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  --amount 5000 \
  --timeout-days 7 \
  --proof-hash 0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

# Fund escrow
furlpay escrow fund --id escrow_1710000000000

# Submit delivery proof and release funds
furlpay escrow release --id escrow_1710000000000 --preimage "invoice_fulfillment_secret_123"
```

---

## Model Context Protocol (MCP) AI Agents

The CLI provides a standardized STDIO MCP server for Claude, Cursor, Gemini, and autonomous AI trading agents:

```bash
furlpay mcp --wallet agent-alpha
```

Add to your MCP configuration (`claude_desktop_config.json` / Cursor):

```json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "furlpay",
      "args": ["mcp", "--wallet", "agent-alpha"]
    }
  }
}
```

### Exposed MCP Tools:
- `furlpay_settle_invoice`: Settle x402 payment challenges with Agent Trust Engine policy checks (OFAC/SDN check, velocity limit, spend caps).
- `furlpay_sweep_treasury`: Detect idle USDC and sweep into Franklin Templeton FOBXX (Benji) yield on Soroban or Hyperliquid HLP.
- `furlpay_trade`: Execute limit orders, path payments, or AMM swaps with delegated budget enforcement on Stellar.
- `furlpay_trade_perp`: Execute perpetual futures orders on Hyperliquid L1 (BTC-PERP, ETH-PERP, NVDA-PERP, HYPE-PERP).
- `furlpay_get_hlp_yield`: Query live performance, share price, and 30-day trailing APY for Hyperliquid HLP vault.
- `furlpay_balance`: Query balances across Stellar native assets, USDC, and tokenized RWAs.
- `furlpay_get_quote`: Retrieve optimal multi-hop quotes across SDEX and Soroban AMMs.

---

## Multi-Chain Payments & Banking (Original Suite)

```bash
# Session & Account
furlpay login               # email OTP login
furlpay whoami              # active session and Safe address
furlpay balance             # token balances across Arbitrum, Base, Optimism, Ethereum

# A2A Transfers & Payments
furlpay pay @recipient 10 usd   # instant zero-fee transfer to verified handle
furlpay send 25 0xAbc... --token USDC --chain arbitrum
furlpay swap USDT USDC 100
furlpay bridge 100 --from eth --to arb

# Fractional Stocks & Travel
furlpay invest buy AAPL 50
furlpay travel search --city Tokyo --min-stars 4
furlpay dashboard
```

---

## License

MIT © FurlPay Protocol & Systems Engineering Group.

# FurlPay CLI (`@furlpay/cli`)

> **Institutional x402 v2 Payment Facilitation, Mainnet CLOB Market Data, and Autonomous AI-Agent Settlement Infrastructure**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-emerald.svg)](package.json)
[![Standard: x402 v2](https://img.shields.io/badge/standard-x402_v2-purple.svg)](https://www.x402.org)
[![CAIP-2](https://img.shields.io/badge/spec-CAIP--2-orange.svg)](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)

---

```
  ╔═══════════════════════════════════════════════╗
  ║   ___         _  ___                          ║
  ║  | __|  _ _ _| || _ \ __ _  _  _             ║
  ║  | _| || | '_| ||  _// _` || || |            ║
  ║  |_| \_,_|_| |_||_|  \__,_| \_, |            ║
  ║                              |__/             ║
  ║  Institutional x402 Payment Infrastructure    ║
  ║  v0.4.0                                       ║
  ╚═══════════════════════════════════════════════╝
```

## Overview

**FurlPay CLI** is the institutional command-line interface and TypeScript SDK for programmatic machine-to-machine (M2M) payments, Layer 1 Central Limit Order Book (CLOB) market data ingestion, and autonomous agent treasury management.

Built for the **$5.27+ Trillion** tokenization and autonomous AI-agent economy, FurlPay bridges:
1. **HTTP 402 Payment Required Protocol (x402 v2):** Machine-readable headers, CAIP-2 multi-chain identifiers (`eip155:8453`, `eip155:42161`, `solana:mainnet`, `hyperliquid:999`), and gasless EIP-3009 transfer authorizations.
2. **Mainnet CLOB Market Data:** Sub-millisecond Order Flow Imbalance (OFI), volume-weighted Micro-Price ($P_{\text{micro}}$), and Level 2 depth streaming directly from the Hyperliquid L1 consensus engine.
3. **Escrow & Time-Locked Settlement Scheme (ETSS):** Two-phase commit escrow with cryptographic proof-of-delivery receipts, preventing payment-service decoupling.
4. **Agentic Runtime Governance (MAS SAFR Alignment):** Spending velocity limiters, hardware key enclaves, and Know-Your-Agent (KYA) cryptographic attestation.

---

## Installation

### Prerequisites
- Node.js $\ge 18.0.0$
- npm or pnpm

```bash
# Clone the repository
git clone https://github.com/FurlPay/furlpay-cli.git
cd furlpay-cli

# Install dependencies
npm install

# Build TypeScript
npm run build

# Link globally (optional)
npm link
```

---

## Quick Start & CLI Usage

### 1. Initialize Configuration & Wallet
Walk through interactive network selection, wallet setup, and facilitator configuration:
```bash
node dist/cli.js init
```

Or generate a standalone agent wallet:
```bash
node dist/cli.js wallet generate --save
```

Check wallet balance across supported networks:
```bash
node dist/cli.js wallet balance --network eip155:8453
```

---

### 2. Live Mainnet CLOB Market Data & Microstructure
Inspect the live L2 order book on Hyperliquid Layer 1 consensus:
```bash
node dist/cli.js market orderbook BTC --depth 10
```

*Output includes:*
- **Bid / Ask Depth Bars** rendered in real time.
- **Mid-Price & Micro-Price:**
  $$P_{\text{micro}} = \frac{P_{\text{bid}} \cdot V_{\text{ask}} + P_{\text{ask}} \cdot V_{\text{bid}}}{V_{\text{bid}} + V_{\text{ask}}}$$
- **Spread in Basis Points (bps)**
- **Order Flow Imbalance (OFI)**

Stream live continuous order book updates via WebSocket:
```bash
node dist/cli.js market stream BTC
```

---

### 3. x402 v2 Payment Facilitation

#### A. Create a 402 Payment Challenge (Server/API Provider)
```bash
node dist/cli.js pay create \
  --to 0x9A4b123456789012345678901234567890123456 \
  --amount 2500000 \
  --scheme exact \
  --network eip155:8453
```
*Generates RFC-compliant HTTP 402 challenge with UUIDv4 nonce, expiry, and CAIP-2 network parameters.*

#### B. Sign an Authorization (AI Agent / Payer)
```bash
node dist/cli.js pay sign @challenge.json
```
*Signs an EIP-3009 gasless `transferWithAuthorization` message.*

#### C. Verify an Authorization (Facilitator)
```bash
node dist/cli.js pay verify @challenge.json @authorization.json
```

---

### 4. Empirical Latency Benchmarks
Execute the automated quantitative latency benchmark suite directly against the production Layer 1 state machine:
```bash
npm run benchmark
# or: node dist/cli.js benchmark --coin BTC --iterations 15
```

```
  ⚡  GENESIS 2.0 — Latency Benchmark Report
┌───────────────────────────────────┬─────────────────────────┐
│ Metric                            │ Value                   │
├───────────────────────────────────┼─────────────────────────┤
│ Instrument                        │ BTC                     │
│ Iterations                        │ 15                      │
│                                   │                         │
│ Latency                           │                         │
│   REST L2 Snapshot (mean)         │ 136.56 ms               │
│   REST L2 Snapshot (p50)          │ 125.05 ms               │
│   REST L2 Snapshot (p95)          │ 196.30 ms               │
│   REST L2 Snapshot (p99)          │ 225.82 ms               │
│   REST L2 Snapshot (min)          │ 110.88 ms               │
│   REST L2 Snapshot (max)          │ 233.20 ms               │
│                                   │                         │
│ Market Data Quality               │                         │
│   Book crossed                    │ NO                      │
│   Avg spread (bps)                │ 0.13                    │
└───────────────────────────────────┴─────────────────────────┘
```

---

## Programmatic TypeScript SDK

FurlPay CLI also functions as an enterprise TypeScript/Node.js library:

```typescript
import { MarketDataService, X402Facilitator, WalletService } from '@furlpay/cli';

// 1. Ingest L2 market depth from Layer 1 CLOB
const market = new MarketDataService();
const snapshot = await market.getOrderBook('BTC', 10);
const metrics = market.calculateMicrostructure(snapshot);
console.log(`Micro-Price: $${metrics.microPrice.toFixed(2)} | OFI: ${metrics.ofi}`);

// 2. Issue x402 v2 challenge
const facilitator = new X402Facilitator({ networkId: 'eip155:8453' });
const challenge = facilitator.createChallenge({
  payTo: '0x9A4b...FurlPayOrchestrator',
  amount: '2500000', // 2.50 USDC
  scheme: 'exact',
});

// 3. Agent signs EIP-3009 authorization gaslessly
const wallet = new WalletService(process.env.FURLPAY_PRIVATE_KEY);
const auth = await wallet.signPaymentAuth(challenge);

// 4. Verify signature & settle
const verification = facilitator.verifyAuthorization(challenge, auth);
console.log(`Authorization valid: ${verification.valid}`);
```

---

## Architecture & Specifications

- **Documentation & Status:** [docs/](docs/)
- **x402 Protocol Specification:** [x402-specification-v2.md](https://github.com/x402-rs/x402-rs/blob/main/docs/specs/x402-specification-v2.md)
- **Tokenized Infrastructure Research:** [`GENESIS_2.0_INSTITUTIONAL_RESEARCH_REPORT_2026.md`](file:///c:/Users/ashut/Downloads/trading%20for%20years/GENESIS_2.0_INSTITUTIONAL_RESEARCH_REPORT_2026.md)
- **Tokenized Commodities & PAXG Benchmark:** [`PAXG_TOKENIZED_RWA_TRADING_RESEARCH_REPORT_2026.md`](file:///c:/Users/ashut/Downloads/trading%20for%20years/PAXG_TOKENIZED_RWA_TRADING_RESEARCH_REPORT_2026.md)

---

## License

MIT © [FurlPay Corporate Architecture](https://furlpay.io)

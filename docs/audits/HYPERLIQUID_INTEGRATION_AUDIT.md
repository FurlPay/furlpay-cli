# Hyperliquid L1 Protocol Integration & Technical Audit (2026)
**Document Version**: 2.5.0-PROD  
**Target Architecture**: Hyperliquid Layer 1 (HyperBFT Consensus & HyperCore Execution Engine)  
**Verification Level**: COMPREHENSIVE PROTOCOL PARITY AUDIT

---

## 1. Protocol Architecture & Consensus Overview

Hyperliquid operates a sovereign, purpose-built Layer 1 financial blockchain optimized for high-throughput, low-latency financial state transitions.

### 1.1 Dual-Engine Architecture
1. **HyperCore**: A custom, bare-metal C++ matching engine and clearinghouse running directly within the validator state machine. It processes perpetual futures and spot limit orders with deterministic Price-Time Priority matching.
2. **HyperEVM**: A custom EVM implementation providing general-purpose programmability. HyperEVM interacts with HyperCore via native precompiles (e.g., `CoreWriter`).
   > [!IMPORTANT]
   > HyperEVM smart contract precompiles for trade writing execute with an asynchronous intentional delay to prevent front-running and MEV extraction. **All high-frequency quant execution must connect directly to the HyperCore Layer 1 REST/WebSocket endpoints, not through HyperEVM smart contracts.**

### 1.2 Consensus & Performance Realities
- **Consensus Algorithm**: HyperBFT (a pipelined HotStuff-derived linear Byzantine Fault Tolerant protocol).
- **Finality**: Single-slot deterministic finality ($\approx 0.2\text{s}$ to $0.4\text{s}$ end-to-end confirmation). Claims of "0.07-second blocks" represent optimistic local matching loop intervals, not global network quorum confirmation across the decentralized validator set.
- **Validator Quorum**: Dynamic validator set requiring $> 2/3$ stake weight quorum.

---

## 2. API Specifications & Data Structures

Hyperliquid exposes two primary JSON endpoints:
- **REST Info Endpoint**: `POST https://api.hyperliquid.xyz/info` (or `api.hyperliquid-testnet.xyz/info`)
- **REST Exchange Endpoint**: `POST https://api.hyperliquid.xyz/exchange` (or `api.hyperliquid-testnet.xyz/exchange`)
- **WebSocket Gateway**: `wss://api.hyperliquid.xyz/ws`

### 2.1 Info Endpoint Request Schemas
All `/info` queries are JSON POST requests with a mandatory `type` property:

```json
// L2 Order Book Query
{ "type": "l2Book", "coin": "BTC" }

// User State Query
{ "type": "clearinghouseState", "user": "0xYourWalletAddress" }

// Open Orders Query
{ "type": "openOrders", "user": "0xYourWalletAddress" }

// Meta & Asset Universe
{ "type": "metaAndAssetCtxs" }
```

### 2.2 Exchange Action & EIP-712 Signing Specifications

Hyperliquid separates actions into **L1 Trading Actions** and **Master Admin Actions** using distinct EIP-712 domain definitions:

#### A. L1 Trading Actions (Order, Cancel, Modify)
* **Domain Name**: `"Exchange"`
* **Domain Version**: `"1"`
* **Chain ID**: `1337` (0x539) — Fixed across both Mainnet and Testnet for L1 trading actions
* **Verifying Contract**: `0x0000000000000000000000000000000000000000`
* **Primary Type**: `"Agent"`
* **Payload Structure**:
```json
{
  "action": {
    "type": "order",
    "orders": [
      {
        "a": 0,                     // Asset Index (0 for BTC)
        "b": true,                  // isBuy: true for buy, false for sell
        "p": "92500.0",             // Limit Price (Quantized to tick size)
        "s": "0.1500",              // Size (Quantized to lot size)
        "r": false,                 // Reduce-only
        "t": { "limit": { "tif": "Gtc" } }, // Time-in-Force: Gtc, Ioc, Alo (Post-Only)
        "c": "0x9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c" // 128-bit hex cloid
      }
    ],
    "grouping": "na"
  },
  "nonce": 1773048592000,           // Monotonic millisecond timestamp
  "signature": {
    "r": "0x...",
    "s": "0x...",
    "v": 27
  }
}
```

#### B. Master Administrative Actions (approveAgent, withdraw3, transfer)
* **Domain Name**: `"HyperliquidTransaction"` (or `"HyperliquidTransaction:Testnet"`)
* **Chain ID**: `42161` (Arbitrum One) or `421614` (Arbitrum Sepolia, `0x66eee`)
* **Primary Type**: `"HyperliquidTransaction"`

---

## 3. Rate Limiting Architecture & Weight Formula

Hyperliquid enforces strict sliding-window rate limiting to protect validator nodes:
1. **REST Request Budget**: Base limit of 1,200 weighted requests per minute per IP address.
2. **WebSocket Message Budget**: 100 incoming requests per minute per connection.
3. **Batch Weight Calculation Formula**:
   $$\text{Request Weight} = 1 + \left\lfloor \frac{\text{batch\_length}}{40} \right\rfloor$$
   - A batch of 1 to 39 orders consumes **1 weight point**.
   - A batch of 40 to 79 orders consumes **2 weight points**.
   - Exceeding the rate limit results in HTTP 429 and an escalating IP ban (1 minute $\to$ 10 minutes $\to$ 24 hours).

---

## 4. Margin Mechanics & Exact Liquidation Equations

### 4.1 Maintenance Margin Fraction
The maintenance margin rate $l$ is asset-dependent and derived directly from the maximum allowed leverage:
$$l = \frac{1}{2 \times \text{maxLeverage}}$$
* For BTC (max leverage 50x): $l = \frac{1}{100} = 0.0100$ (1.00%).
* For ETH (max leverage 40x): $l = \frac{1}{80} = 0.0125$ (1.25%).
* For SOL (max leverage 20x): $l = \frac{1}{40} = 0.0250$ (2.50%).

### 4.2 Exact Liquidation Price Formulas
FurlPay implements the exact closed-form liquidation equations:

$$\text{Long Liquidation Price} = P_{\text{entry}} \times \frac{1 - \frac{1}{L}}{1 - l}$$

$$\text{Short Liquidation Price} = P_{\text{entry}} \times \frac{1 + \frac{1}{L}}{1 + l}$$

*Where $L$ is user initial leverage, $l$ is maintenance margin rate, and $P_{\text{entry}}$ is weighted entry price.*

### 4.3 Liquidation Execution Mechanics
Hyperliquid liquidations do NOT dump 100% of the position immediately into the public order book:
1. The position is liquidated in discrete **20% tranches** via a Dutch auction descending-price mechanism.
2. If the public market fails to absorb the liquidated tranche within the allowed slippage window, the position is automatically transferred to the **HLP (Hyperliquid Liquidity Provider) Vault** at the bankruptcy price.

---

## 5. Funding Rate Mechanics

Hyperliquid perpetual contracts settle funding hourly using continuous premium sampling:
1. Every 5 seconds, the engine samples the order book premium:
   $$\text{Premium} = \frac{\text{Impact Mid Price} - \text{Index Price}}{\text{Index Price}}$$
2. The 1-hour funding rate $F$ is calculated as the average premium plus an interest rate component, clamped to protocol safety bounds:
   $$F = \text{Clamp}\left(\text{Avg Premium}, -0.05\%, +0.05\%\right)$$
3. Positive funding means longs pay shorts; negative funding means shorts pay longs.

---

## 6. The USDC Quanto FX Dynamic & Depeg Exposure

A critical finding of this audit concerns collateral valuation:
- **Underlying Index**: Hyperliquid perpetual indexes track USDT/USD prices aggregated from external spot exchanges (Binance, OKX, Bybit).
- **Collateral & P&L**: All balances and margin are held in **USDC**.
- **Accounting Assumption**: The clearinghouse treats $1\text{ USDC} \equiv 1\text{ USD}$ unconditionally. There is no real-time oracle haircut applied to USDC.

> [!CAUTION]
> If USDC experiences a depeg event (e.g., dropping to \$0.95), Hyperliquid positions remain valued at \$1.00 USDC internally. However, an off-ramping desk would face severe real-dollar losses. **FurlPay's risk engine enforces an external USDC peg monitor that halts trading if USDC drifts $> 25\text{ bps}$.**

---

## 7. Hyperliquid Liquidity Provider (HLP) Vault Mechanics

- **Role**: The HLP vault serves as the protocol-level backstop market maker and liquidation absorber.
- **Deposit / Redemption Rules**:
  - Deposits mint pro-rata vault shares.
  - **4-Day Lockup Invariant**: Withdrawals are strictly locked for **4 continuous days (96 hours)** post-deposit. No funds can be withdrawn early under any circumstances.
  - The FurlPay Workstation TUI and CLI explicitly present this lockup notification and mandate interactive user confirmation before routing capital to HLP.

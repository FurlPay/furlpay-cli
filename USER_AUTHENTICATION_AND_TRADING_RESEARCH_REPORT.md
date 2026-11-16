# FurlPay CLI — User Authentication, Multi-Account Architecture & Trading Execution Research Report (2026)

**Target System:** FurlPay Non-Custodial Terminal & Execution Layer (`@furlpay/cli`)  
**Date:** November 16, 2026  
**Auditor / Engineering Research:** Antigravity Autonomous Systems Group  
**Benchmark Reference Architectures:** Stripe CLI & Dashboard SSO, Binance API Management & Sub-Account Framework, Circle Programmable Wallets & Smart Contract Custody, Stellar SEP-10 Web Authentication.  
**Classification:** TECHNICAL ARCHITECTURE & OPERATIONAL RUNBOOK (TLP:CLEAR)  

---

## Executive Summary

This research report establishes the complete architectural framework, identity model, and operational procedures for **how individual users securely log into their individual accounts and execute trades** through the **FurlPay CLI**.

Financial terminal security at tier-1 institutions (Stripe, Binance, Circle) mandates a strict **Dual-Plane Security Architecture**:
1. **The Identity & Profile Plane (Web Session):** Authenticates the individual human user via browser SSO / RFC 8628 Device Authorization, synchronizes KYC/KYB tier compliance, retrieves account balances, and monitors order history. This session is granted `account:read` permissions and **never possesses private cryptographic signing keys**.
2. **The Execution & Custody Plane (Cryptographic Signing):** Non-custodially signs and broadcasts financial mutations (orders, swaps, vault transfers, escrows) using hardware wallets (Ledger), browser extension loopbacks (Freighter/Albedo), EIP-712 Phantom Agent keys, or OS-sealed keystores (DPAPI/Keychain).

By completely decoupling **identity login** from **cryptographic custody**, FurlPay ensures that a compromised web session token can never drain user capital, and stolen API keys cannot bypass exchange withdrawal restrictions.

---

## 1. System Architecture: The Dual-Plane Non-Custodial Model

```
┌────────────────────────────────────────────────────────────────────────┐
│                        USER WORKSTATION / CLI                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   [ PLANE 1: IDENTITY & WEB SESSION ]                                 │
│   - `furlpay login --device` (RFC 8628 Device Grant)                  │
│   - Scoped to `account:read`                                           │
│   - Session stored in `~/.furlpay/config.json` (DPAPI/0600)           │
│   - Accesses: KYC Tier, Safe Smart Account, Order Blotter, History     │
│                                                                        │
│                                │ (Read-only API calls)                 │
│                                ▼                                       │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │               FurlPay Cloud / API Gateway                      │   │
│   │       (Identity, Webhooks, Compliance, Aggregator)              │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│   [ PLANE 2: CRYPTOGRAPHIC SIGNING & EXECUTION ]                       │
│   - Zero key material sent to FurlPay servers                          │
│   - Local signing only via 5 custody options:                          │
│                                                                        │
│     ┌──────────────────────────────────────────────────────────┐       │
│     │ 1. Hardware Wallet: Ledger Nano S/X/Stax (USB HID APDU)  │       │
│     │ 2. Extension Loopback: Freighter / Albedo (127.0.0.1)   │       │
│     │ 3. Encrypted Keystore: PBKDF2 + AES-256-GCM             │       │
│     │ 4. Delegated Agent: EIP-712 Phantom Agent (HL L1)        │       │
│     │ 5. Exchange API: Binance HMAC-SHA256 (Spot only)         │       │
│     └──────────────────────────────────────────────────────────┘       │
│                                │                                       │
│                                │ (Direct Cryptographically Signed Tx)  │
│                                ▼                                       │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │             Decentralized Venues & Clearinghouses              │   │
│   │   - Hyperliquid L1 Validators (Perpetuals & HLP Vault)         │   │
│   │   - Stellar Horizon / Soroban RPC (SDEX & Tokenized RWAs)      │   │
│   │   - Binance Spot REST Gateway (Order Matching Engine)          │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. User Authentication: How Users Sign In to Their Accounts

FurlPay CLI provides three primary authentication methods depending on the environment:

### Method 1: Browser-Based Device Authorization (RFC 8628) — *Recommended for Desktops*
This mirrors the secure login flows of the **Stripe CLI**, **GitHub CLI (`gh auth login`)**, and **Google Cloud SDK (`gcloud auth login`)**.

```bash
furlpay login --device
```

#### Step-by-Step Flow:
1. **Device Code Issuance:** The CLI issues an unauthenticated `POST /api/auth/device/code` to FurlPay with:
   - `client_id: "furlpay-cli"`
   - `scope: "account:read"`
   - `device_name`: Hostname of the operator machine.
2. **Interactive Browser Launch:** The CLI displays an 8-character verification code (e.g. `WDJB-4972`) and automatically opens the user's default browser to:
   ```
   https://furlpay.com/device-auth?user_code=WDJB-4972
   ```
   *Security Guardrail:* The CLI validates the target URL via `browserUrlAllowed()`, strictly rejecting non-HTTPS, arbitrary schemes, credentials in URLs, or non-`furlpay.com` domains (CWE-601).
3. **User Confirmation in Web App:**
   - The user logs in to the FurlPay web dashboard using Passkey / WebAuthn, Google SSO, or Email 2FA.
   - The browser prompts: *"Authorize FurlPay CLI on device: WORKSTATION-01 for read-only account access?"*
   - User clicks **Approve**.
4. **Token Polling & Storage:**
   - The CLI polls `/api/auth/device/token` with exponential backoff and rate-limit handling (`slow_down` / interval management).
   - Once approved, the server returns an account session cookie (`furlpay_session`).
   - The CLI saves the session locally to `~/.furlpay/config.json`.
   - Terminal prints: `✓ Successfully authenticated with FurlPay. Transaction signing was not granted.`

---

### Method 2: Headless Email OTP Authentication — *Recommended for Remote SSH / Servers*
For environments without a web browser (headless Linux servers, Docker containers):

```bash
furlpay login --email trader@institutional-desk.com
```

#### Step-by-Step Flow:
1. The CLI calls `POST /api/auth/otp/start`, triggering a cryptographically generated 6-digit one-time passcode to the user's registered corporate email.
2. The CLI prompts interactively: `Enter code: `.
3. The user inputs the code, and the CLI submits `POST /api/auth/otp/check`.
4. On verification, the authenticated session cookie is minted and stored.

---

### Method 3: Multi-Account & Profile Isolation (Stripe / AWS Pattern)
Institutional traders often operate across multiple entities (e.g., `personal`, `desk-alpha`, `market-maker-staging`).

FurlPay CLI stores credentials per-profile and per-environment:
```bash
# Set active environment
furlpay env sandbox     # Points to mock endpoints & testnets
furlpay env live        # Points to production mainnet APIs

# Inspect currently active session
furlpay whoami
```

The configuration is isolated at:
- **POSIX (Linux/macOS):** `~/.furlpay/config.json` with strict `0700` directory and `0600` file permissions.
- **Windows:** DPAPI encrypted with `DataProtectionScope.CurrentUser` so other OS users cannot read the session.

To switch accounts or terminate access:
```bash
# Revoke current session and remove local credentials
furlpay logout
```

---

## 3. Trading Execution: How Users Trade Through Their Accounts

Once a user is signed in, trading execution requires **local cryptographic custody**. The CLI supports four distinct execution topologies:

---

### Topo 1: Hyperliquid L1 Perpetuals & HLP Vault (Direct Decentralized Custody)

Hyperliquid L1 operates as a standalone Tendermint-based L1 with sub-second finality. FurlPay implements Hyperliquid's official **EIP-712 Phantom Agent** standard.

#### Step 1: Fund the Account
1. From any EVM wallet (MetaMask, Rabby), deposit native USDC on Arbitrum One to the Hyperliquid Bridge:
   `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7`
2. Funds credit automatically to your L1 clearinghouse address within 1 minute.

#### Step 2: Configure the Dedicated Trading Agent Key
Top trading desks (Binance, Wintermute) never put master withdrawal keys on trading servers. Instead, generate a delegated API Agent Wallet:
1. In the Hyperliquid web app, go to **API** → **Create Agent**.
2. Or use FurlPay's built-in key generation:
   ```bash
   # Generates an API keypair and outputs the approval instruction
   furlpay wallet agent-keygen --name hl-trader-01
   ```
3. Set the agent private key in your environment:
   ```bash
   export HYPERLIQUID_PRIVATE_KEY="0x<your_agent_private_key>"
   export FURLPAY_HL_TESTNET="0"  # 1 for testnet, 0 for mainnet
   ```

#### Step 3: Execute Orders with Risk Boundaries
```bash
# Check margin, balance, and account health
furlpay account balance

# Set hard pre-trade risk controls (prevents fat-finger or runaway bots)
furlpay trading limits --max-single-order 5000 --max-leverage 5

# Place limit order on BTC-PERP
furlpay trade perp BTC --side buy --size 0.05 --leverage 5 --limit 92450

# Inspect open orders
furlpay account orders

# Close position instantly via reduce-only IOC
furlpay trade close BTC

# Deposit into HLP community backstop vault (4-day protocol lockup)
furlpay earn hlp deposit 1000
furlpay earn hlp stats
```

*Cryptographic Integrity:* FurlPay serializes every order dictionary into MessagePack, appends an 8-byte big-endian uint64 nonce, hashes with Keccak-256, and produces an EIP-712 signature over Chain ID `1337`. Zero private keys leave the machine.

---

### Topo 2: Stellar SDEX & Soroban AMM (Hardware Custody & Regulated RWAs)

For trading tokenized equities (Janus Henderson JQQQ, Securitize NVDA) and money market funds (Franklin Templeton FOBXX):

#### Option A: Hardware Wallet Clear-Signing (Ledger Nano S/X/Stax)
*The most secure method for high-net-worth treasury execution.*
```bash
# Connect Ledger via USB HID (BIP-44 derivation: m/44'/148'/0')
furlpay wallet connect ledger --derivation-index 0
```
When executing a trade:
```bash
furlpay trade limit \
  --side buy \
  --asset JQQQ:GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ \
  --against USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
  --amount 50 \
  --price 104.20 \
  --sponsor
```
1. The CLI builds the transaction payload.
2. The Ledger device prompts: `Review Transaction`.
3. The operator clear-signs the asset, amount, and price directly on the Ledger's physical screen.
4. The signature returns to the CLI for broadcast.

#### Option B: Browser Extension Bridge (Freighter / Albedo)
For operators who custody keys in Freighter:
```bash
# Launches an authenticated localhost bridge on 127.0.0.1:4024
furlpay wallet connect extension --port 4024
```
1. When a trade command is triggered in the terminal, the CLI dispatches a loopback signing request to `127.0.0.1:4024`.
2. The Freighter extension window pops up in the browser for user PIN/fingerprint approval.
3. The signed XDR is returned to the CLI.

#### Option C: Local Encrypted Keystore (`~/.furlpay/keystore.enc`)
For automated or offline execution:
```bash
# Imports seed phrase into PBKDF2 (100k iterations) + AES-256-GCM keystore
# Input is accepted via stdin to prevent shell history leakage
printf '%s\n' "twelve word mnemonic phrase goes here ..." "keystore_password" | furlpay wallet import --name primary --mnemonic
```

---

### Topo 3: Binance Spot Integration (Exchange API Protocol)

Built to the security specifications of Binance's institutional API framework:

#### Step 1: Generate Restricted API Credentials
1. In Binance Account Settings, create an API key labeled `furlpay-cli`.
2. Enable: **Enable Reading**, **Enable Spot & Margin Trading**.
3. **CRITICAL:** Ensure **Enable Withdrawals** is **DISABLED**.
4. Restrict access to your trusted workstation IP address.

#### Step 2: Inject Credentials via Environment
```bash
export BINANCE_API_KEY="<your_binance_api_key>"
export BINANCE_API_SECRET="<your_binance_api_secret>"
export FURLPAY_BINANCE_ENV="mainnet"  # or testnet
```

#### Step 3: Trading Execution
```bash
# Check real account spot balances
furlpay binance balances

# Inspect live market book
furlpay binance depth BTCUSDT --limit 20

# Execute spot market buy ($50 USDT of BTC)
furlpay binance spot buy BTCUSDT --quote 50

# Inspect open orders
furlpay binance open-orders
```

*Security Guardrail:*
- The `BinanceAdapter` verifies that the API key cannot perform withdrawals (`withdrawals: false` capability check).
- The Agent Trust mandate check runs **before** signing; a declined order never generates an HTTP request.
- Every private endpoint signs parameters using HMAC-SHA256 with injected clock synchronization and strict `recvWindow = 5000ms`.

---

### Topo 4: Autonomous AI Agent Trading (Model Context Protocol / MCP)

For running trading agents in Claude Code, Cursor, or Gemini:

```bash
# Start STDIO MCP Server bound to a specific agent wallet
furlpay mcp --wallet agent-alpha
```

#### The Agent Mandate Safety Lifecycle (Circle & Stripe Standards):
1. **Mandate Creation:** The human owner defines an atomic spending boundary:
   ```bash
   furlpay wallet agent-keygen \
     --name agent-alpha \
     --daily-limit 50.00 \
     --single-tx-cap 10.00 \
     --allowed-assets USDC,BTC,ETH,HYPE \
     --expiry 7d
   ```
2. **Atomic Verification:** Whenever an AI agent calls `furlpay_trade_perp` or `furlpay_settle_invoice`:
   - An exclusive OS file lock (`.lock` via `O_EXCL`) is acquired on the policy file.
   - The daily spend window rolls over automatically at 00:00 UTC.
   - Single-transaction caps, daily limits, and asset whitelists are evaluated.
   - If limits are exceeded or the key is revoked, execution fails closed.
3. **Interactive Human Approval:** All mutating tools are registered with:
   ```json
   "_meta": { "anthropic/requiresUserInteraction": true }
   ```
   Claude / Cursor prompts the human operator with an interactive `[y/N]` confirmation dialog showing order details before any trade is signed.

---

## 4. End-to-End User Journey: From Setup to First Live Trade

```
Step 1: Install
  $ npm install -g @furlpay/cli
       │
Step 2: Identity Login
  $ furlpay login --device
  (Browser opens -> Approve at https://furlpay.com/device-auth -> Read-only session established)
       │
Step 3: Verification
  $ furlpay whoami
  (Shows user name, verified email, KYC tier, and Safe account address)
       │
Step 4: Custody Setup (Non-Custodial)
  $ export HYPERLIQUID_PRIVATE_KEY="0x..."   [For L1 Perps]
  $ furlpay wallet connect ledger            [For Stellar Equities]
       │
Step 5: Pre-Trade Risk Caps
  $ furlpay trading limits --max-single-order 100 --max-leverage 5
       │
Step 6: Live Execution
  $ furlpay trade perp BTC --side buy --size 0.001 --leverage 2
       │
Step 7: Real-Time Position Monitoring
  $ furlpay account positions
       │
Step 8: Position Close & Settlement
  $ furlpay trade close BTC
       │
Step 9: Session Termination
  $ furlpay logout
```

---

## 5. Security Threat Modeling & Institutional Defense Matrix

| Threat Scenario | Attack Vector | FurlPay Defense & Countermeasure |
|---|---|---|
| **Stolen Web Session Cookie** | Attacker extracts `furlpay_session` from disk or memory. | **Session Decoupling:** Web cookies possess only `account:read` scope. No transaction signing keys exist on the API server; attacker cannot move funds. |
| **Malicious Process / Info-Stealer** | Malware scans machine for plaintext `.env` or config files. | **OS-Bound Sealing:** Keys stored on disk are encrypted via Windows DPAPI or macOS Keychain. The raw secret is never written in plaintext. |
| **API Key Leak in Shell History** | User runs `furlpay login --key sk_live_...`. | **Argv Rejection:** Command-line argument keys are explicitly rejected; keys must be piped via stdin (`printf ... \| furlpay login --key`). |
| **AI Agent Prompt Injection** | Adversary tricks LLM into placing $100k leveraged trade. | **Layered Mandate Defense:** Hard OS-locked spending caps ($10 single-tx, $50 daily) reject the order; `requiresUserInteraction` forces human `[y/N]` confirmation. |
| **Exchange API Secret Abuse** | Compromised Binance API key used for unauthorized off-ramping. | **Structural Absence:** FurlPay adapter enforces `withdrawals: false`; IP-whitelisting on Binance blocks third-party IP execution. |
| **Adverse Market Slippage / MEV** | Thin order book or frontrunning bot executes trade 20% off mid. | **Strict Pre-Trade Guardrails:** Orders >15% from mid are rejected as fat-finger; slippage caps prevent executions beyond user tolerance. |

---

## 6. Implementation & Operational Recommendations

To elevate user authentication and trading to institutional tier-1 parity (Circle/Binance/Stripe), the following three engineering upgrades should be prioritized in upcoming sprints:

1. **Named Configuration Profiles (`--profile`):**
   Implement support for multi-tenant profiles:
   ```bash
   furlpay --profile fund-a account balance
   furlpay --profile market-maker-prod trade perp BTC ...
   ```
   Stored under `~/.furlpay/profiles/<profile_name>.json` with independent keystores and sessions.
2. **Stellar SEP-10 Web Authentication Integration:**
   Implement SEP-10 challenge-response authentication for Anchor and SEP-8 approval server interactions:
   - CLI queries anchor `WEB_AUTH_ENDPOINT`.
   - Anchor issues challenge transaction signed by its server key.
   - User signs challenge locally using their Ledger or Keystore.
   - Anchor validates signature and returns a 24-hour scoped JWT token.
3. **Hardware Wallet Support for Hyperliquid L1 (EIP-712 Clear Signing):**
   Extend Ledger support to Ethereum app EIP-712 clear-signing for Hyperliquid L1 actions, allowing cold-storage institutional custody for perpetual trading.

---

## Conclusion

The FurlPay CLI achieves a robust security posture by strictly adhering to the **non-custodial separation of identity and execution**. Users sign into their individual accounts with seamless browser-based SSO (RFC 8628), while keeping complete, uncompromised control of their private signing keys via hardware wallets, L1 agent delegations, and OS-sealed vaults.

# FurlPay CLI — Comprehensive Codebase Security Audit & Real-Money Operational Research Report (2026)

**Target Repository:** `FurlPay/furlpay-cli`  
**Software Version:** v0.4.0  
**Audit Date:** November 16, 2026  
**Auditor:** Antigravity Autonomous Security Research Group  
**Benchmark Standards:** OWASP ASVS 5.0 (Level 3), Crypto-Asset Clearinghouse Security Standard (CCSS Level 3), Circle Developer & Smart Contract Architecture, Binance API & Risk Controls, Stripe Financial Idempotency & Engine Specifications.  
**Classification:** TLP:CLEAR // PUBLIC ASSURANCE & REMEDIATION REPORT  

---

## Executive Summary

A comprehensive source-code and cryptographic audit of the entire **FurlPay CLI (`@furlpay/cli`)** codebase was conducted across its TypeScript core (`src/`), JavaScript runtime (`lib/`), CLI dispatchers (`bin/`), test suites (`test/`), installation vectors (`install.sh`, `install.ps1`), and CI/CD pipelines (`.github/workflows/`).

The audit evaluated the system against the security, financial precision, and operational standards of tier-1 institutional fintechs (**Circle**, **Binance**, **Stripe**). While earlier hardening passes successfully addressed basic plaintext key leakage and introduced honest status disclosures, our audit uncovered **12 critical-to-medium vulnerabilities (P1 through P12)** encompassing:
- Unbounded Autonomous AI Agent MCP Execution on live funds.
- Sign inversion in fixed-point decimal parsing leading to negative PnL / fee corruption.
- Asymmetric slippage calculation rendering sell orders completely unprotected against 100% dumps.
- Advertised Binance CLI command missing from the binary routing table.
- Invalid Stellar Ed25519 CRC checksums on all regulated asset issuers with silent fallback to Circle's master address.
- Flawed ETSS escrow proof verification and vulnerability to backdated auto-release draining.
- Greedy boolean flag argument parsing causing catastrophic parameter shifting in financial commands.
- In-memory ephemeral nonce and daily cap tracking allowing replay attacks and budget evasion across runs.

In addition to vulnerability disclosures and remediation blueprints, Section 3 provides an end-to-end, 2026-verified **Real-Money Testing & Configuration Protocol** covering Hyperliquid L1, Stellar SDEX/Soroban, Binance Spot, x402 Micropayments, and MCP Agent runtimes.

---

## 1. Vulnerability Matrix (P1 to Pn)

| Priority | Identifier | Vulnerability Title | Subsystem / Location | CWE / Standard | Impact |
|---|---|---|---|---|---|
| **P1** | **VULN-MCP-01** | Unbounded AI Agent MCP Execution Bypassing Spending Mandates & Cap Enforcement | `src/mcp/server.ts`, `lib/mcp.js` | CWE-862, CWE-285 | **CRITICAL:** AI agents can drain funds via Hyperliquid L1 perps or HLP vaults without mandate approval. |
| **P2** | **VULN-MATH-01** | `DecimalMath.parseUnits` Sign Inversion on Fractional Negatives & Floating-Point Drift | `src/precision/decimal-math.ts` | CWE-682, CCSS-3.2 | **CRITICAL:** Negative fractional PnL and fees ($-1 < x < 0$) parse as positive gains; math drift in margin checks. |
| **P3** | **VULN-SLIP-01** | Inverted Sell Slippage Calculation Permitting 100% Market Impact & Dump Execution | `lib/forkSlippage.js` | CWE-682, OWASP-ASVS 10.3 | **CRITICAL:** `slippageBps` is negative for sell orders, completely bypassing user-defined slippage caps. |
| **P4** | **VULN-BIN-01** | Missing Binance CLI Command Routing & URL Query Parameter Exposure of Private Orders | `bin/furlpay.js`, `src/binance/` | CWE-598, CWE-434 | **HIGH:** CLI command fails (`Unknown command`); private order parameters exposed in cleartext proxy/HTTP access logs. |
| **P5** | **VULN-SEP8-01** | Invalid Ed25519 Checksums on Regulated Issuers with Silent Fallback to Circle USDC | `src/compliance/sep8.ts`, `src/trade/sdex.ts` | CWE-345, CWE-393 | **HIGH:** Vanity issuer keys fail Stellar CRC16 validation; SDEX trades misattributed to Circle master account. |
| **P6** | **VULN-ESC-01** | ETSS Escrow Missing Seller Signature / Spec Hash Checks & Backdated Auto-Release Drain | `src/settlement/escrow.ts`, `src/cli.ts` | CWE-347, CWE-287 | **HIGH:** Arbitrary strings accepted as proofs; backdated `submittedAt` allows immediate seller collateral extraction. |
| **P7** | **VULN-CLI-01** | Greedy Boolean Flag Parsing Shifting Positional Arguments in Financial Payments | `lib/util.js` | CWE-88, CWE-20 | **HIGH:** Passing `--yes` or `--sponsor` before `@recipient` swallows recipient and shifts amount into destination. |
| **P8** | **VULN-REP-01** | Ephemeral In-Memory Nonce & Spend Tracking Allowing Replay Attacks & Velocity Evasion | `src/services/x402-facilitator.ts`, `src/services/agent-mandate.ts` | CWE-294, CCSS-4.1 | **MEDIUM:** In-memory `Set` / `Map` resets on process restart, permitting EIP-3009 replay and spend cap bypass. |
| **P9** | **VULN-TTY-01** | Plaintext Terminal Echo During Interactive Seed Phrase & Private Key Import | `src/cli.ts` | CWE-522, CWE-532 | **MEDIUM:** Master mnemonics and keys are visibly echoed on screen during interactive TTY input. |
| **P10** | **VULN-BIT-01** | 64-bit Varint Endianness Inversion & Non-Minimal BIP-62 Push in Bitcoin Utilities | `lib/forkSweepUtils.js` | BIP-174, BIP-62 | **MEDIUM:** uint64 varint decodes 1 as 4,294,967,296; OP_RETURN generates non-standard script rejected by nodes. |
| **P11** | **VULN-SIM-01** | Synthetic Fallback Transaction Hashes in HLP Vault & 500 bps Default Market Slippage | `src/hyperliquid/hlp.ts`, `src/hyperliquid/perp.ts` | CWE-392, OWASP-ASVS 13.2 | **MEDIUM:** Generates fake `hlp_dep_` hashes if API omits `txHash`; excessive 5% slippage buffer on perpetual market orders. |
| **P12** | **VULN-TST-01** | Hidden Test Failures via Excluded Test Suites & Unbuilt TypeScript Dependency | `package.json`, `test/payment.test.js` | CWE-703 | **LOW:** `test/payment.test.js` and `test/http.test.js` fail due to unimplemented APIs; `npm test` fails without pre-build. |

---

## 2. In-Depth Vulnerability Analysis & Defensive Remediations

### P1: Unbounded AI Agent MCP Execution Bypassing Spending Mandates & Cap Enforcement
- **Vulnerability Description:** In `src/mcp/server.ts`, tool handlers `furlpay_trade_perp` and `furlpay_execute_trade` (lines 457–467) directly invoke `perpService.executePerpOrder(...)` using the workstation's master private key (`process.env.HYPERLIQUID_PRIVATE_KEY`). Neither `AgentKeyService.validateAndRecordSpend` nor `AgentMandateEngine.authorizeTransaction` is invoked. Any LLM connecting to the MCP stdio interface can place leveraged short or long positions without limitation. Furthermore, `lib/mcp.js` (lines 76–92) implements `requireAgentMandate` using only a regex check `/^(cpm|intm)_[a-zA-Z0-9_-]{16,64}$/` without cryptographic signature verification. Passing `mandateId: "cpm_1234567890123456"` completely bypasses the human approval gate.
- **Industry Standard (Circle / Stripe):** Stripe Agent Toolkit and Circle Developer Services enforce cryptographic delegation tokens where the parent key signs a strict EIP-712 / JWT mandate specifying maximum notional, expiry, and recipient. The tool handler must cryptographically verify the signature, record spend against a persistent lock-protected ledger, and reject any unmandated execution.
- **Defensive Remediation:**
  1. In `src/mcp/server.ts`, route all mutating actions through `AgentKeyService.validateAndRecordSpend` or `AgentMandateEngine.authorizeTransaction`. If no mandate is supplied or validation fails, return an explicit error and require human signoff.
  2. In `lib/mcp.js`, replace regex pattern matching with real EIP-712 mandate signature verification against the master account key.

---

### P2: `DecimalMath.parseUnits` Sign Inversion on Fractional Negatives & Floating-Point Drift
- **Vulnerability Description:** In `src/precision/decimal-math.ts` (lines 18–31):
  ```typescript
  const [integerPart, fractionalPart = ""] = s.split(".");
  const cleanInteger = BigInt(integerPart || "0");
  const fractionBig = BigInt(paddedFraction);
  return cleanInteger < 0n ? cleanInteger * scale - fractionBig : cleanInteger * scale + fractionBig;
  ```
  When `valStr` is a negative fractional number where $-1 < x < 0$ (such as `"-0.50"` or `"-0.0025"`):
  - `integerPart` is `"-0"`.
  - `cleanInteger = BigInt("-0" || "0") = 0n`.
  - `cleanInteger < 0n` evaluates to `false`.
  - The function computes `0n * scale + 500000n = +500000n` (positive).
  A negative PnL or funding loss of `-$0.50` is converted to a positive gain of `+$0.50`!
  Additionally, `roundToTick`, `roundToLot`, `computeProtocolLiquidationPrice`, and `computeLiquidationPrice` rely on standard JavaScript IEEE-754 `Number` floating-point math (`Math.round`, `Math.floor`, `parseFloat`), defying the claim that floating-point math was eliminated.
- **Industry Standard (Binance / CCSS):** All accounting libraries must explicitly check if the input string starts with `"-"` to capture negative zero (`-0.xx`). Furthermore, all division, lot rounding, and tick truncation must use integer BigInt division (`(a * scale) / b`).
- **Defensive Remediation:**
  ```typescript
  const isNegative = s.startsWith("-");
  const absS = isNegative ? s.slice(1) : s;
  const [intPart, fracPart = ""] = absS.split(".");
  const units = BigInt(intPart || "0") * scale + BigInt(fracPart.padEnd(decimals, "0").slice(0, decimals));
  return isNegative ? -units : units;
  ```

---

### P3: Inverted Sell Slippage Calculation Permitting 100% Market Impact & Dump Execution
- **Vulnerability Description:** In `lib/forkSlippage.js` (line 81):
  ```javascript
  const slippageBps = Number(((worst - best) * 10_000n) / best);
  if (opts.maxSlippageBps !== undefined && slippageBps > opts.maxSlippageBps) {
    return { refused: true, reason: ... };
  }
  ```
  On a sell order, bids are consumed descending (`best > worst`). As a result, `(worst - best)` is negative. If an order causes a 90% price collapse (from 100 down to 10), `slippageBps` evaluates to `-9000`. The check `-9000 > 100` evaluates to `false`, and the trade executes with `refused: false`. Sell orders have zero slippage protection.
- **Industry Standard (Uniswap / Binance / Stripe):** Slippage is the absolute relative difference between execution price and expected price:
  $$\text{Slippage}_{\text{buy}} = \frac{P_{\text{worst}} - P_{\text{best}}}{P_{\text{best}}}, \quad \text{Slippage}_{\text{sell}} = \frac{P_{\text{best}} - P_{\text{worst}}}{P_{\text{best}}}$$
- **Defensive Remediation:**
  ```javascript
  const diff = worst > best ? worst - best : best - worst;
  const slippageBps = Number((diff * 10_000n) / best);
  ```

---

### P4: Missing Binance CLI Command Routing & URL Query Parameter Exposure of Private Orders
- **Vulnerability Description:**
  1. The CLI entry points `bin/furlpay.js` and `src/cli.ts` do not contain a case for `binance`. Executing `furlpay binance spot buy BTCUSDT --quote 50` outputs `Unknown command: binance`.
  2. In `src/binance/binance.client.ts` (lines 101–105), private `POST` orders are sent via query strings:
     ```typescript
     const url = `${this.host}${path}?${signed.queryString}`;
     const res = await this.fetchImpl(url, { method, headers: signed.headers });
     ```
     Sending order parameters, client order IDs, and signatures in the URL query string violates RFC 7230 and CWE-598, exposing sensitive parameters in corporate proxy logs, gateway logs, and local debugging tools.
  3. In `src/binance/binance.adapter.ts`, `marketOrder` assumes quote asset is USD and sends `quoteOrderQty: String(intent.notionalUsd)`. On non-USD pairs (e.g. `ETHBTC`), this attempts to buy using 50 BTC instead of 50 USD.
- **Industry Standard (Binance API Architecture):**
  - POST / PUT endpoints must transmit signed parameters in the request body as `application/x-www-form-urlencoded` or `application/json`.
  - Symbol metadata from `/api/v3/exchangeInfo` must be queried to resolve the exact `quoteAsset`, `LOT_SIZE`, and `MIN_NOTIONAL` before constructing an order.
- **Defensive Remediation:**
  - Add `case "binance": return handleBinance(args, flags);` in `bin/furlpay.js`.
  - For POST requests in `BinanceClient.signedRequest`, place `signed.queryString` into the HTTP request body and set `Content-Type: application/x-www-form-urlencoded`.

---

### P5: Invalid Ed25519 Checksums on Regulated Issuers with Silent Fallback to Circle USDC
- **Vulnerability Description:** In `src/compliance/sep8.ts` (lines 28–59), the issuer public keys for all regulated assets (`JQQQ`, `FOBXX`, `USTBL`, `NVDA`, `AAPL`) are vanity strings ending in asset letters (`...QJQQQ`, `...QFOBXX`, `...QSECUR`). Testing these keys with Stellar SDK's `StrKey.isValidEd25519PublicKey(key)` returns `false` for every key because their CRC16 checksums are invalid. In `src/trade/sdex.ts` (lines 58–66), the code catches the failure and silently falls back to:
  ```typescript
  return new Asset(code, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  ```
  `GA5Z...KZVN` is the mainnet issuer of Circle USDC. If submitted to the Stellar network, the CLI would attempt to buy assets supposedly issued by Circle's USDC account that do not exist.
- **Industry Standard (Stellar / Circle):** Asset metadata must never be hardcoded with fake vanity checksums. Assets must be loaded dynamically by resolving the issuer's domain `stellar.toml` file via SEP-1, and the resulting public keys must pass cryptographic CRC16 verification.
- **Defensive Remediation:** Purge vanity strings from `KNOWN_REGULATED_ASSETS`. Require valid Ed25519 addresses or enforce SEP-1 `stellar.toml` resolution.

---

### P6: ETSS Escrow Missing Seller Signature / Spec Hash Checks & Backdated Auto-Release Drain
- **Vulnerability Description:** In `src/settlement/escrow.ts`:
  1. `submitProof` checks `if (!proof.signature)` but never cryptographically verifies the signature against `this.terms.seller`. Any string (or `sim:local-cli-attestation`) is accepted.
  2. `submitProof` never checks whether `proof.proofHash === this.terms.deliverySpecHash`. A seller can submit any arbitrary hash.
  3. In `release`, the auto-release check evaluates `now >= this.deliveryProof.submittedAt + this.terms.autoReleaseSeconds`. Because `submittedAt` is trusted from the caller's input object, a seller can provide `submittedAt: 0`, making the auto-release condition immediately true upon submission and draining the buyer's collateral without buyer consent.
- **Industry Standard (Smart Contract Escrow / Stripe):** Timestamps for time-locks must strictly originate from the server/ledger clock (`Math.floor(Date.now() / 1000)`), never trusted from client payloads. Proof hashes must be strictly matched against the locked `deliverySpecHash`.
- **Defensive Remediation:**
  - Verify seller signature: `ethers.verifyMessage(proof.proofHash, proof.signature) === this.terms.seller`.
  - Validate hash equality: `if (proof.proofHash !== this.terms.deliverySpecHash) throw new Error("Proof hash mismatch");`.
  - Override client timestamp: `this.deliveryProof = { ...proof, submittedAt: Math.floor(Date.now() / 1000) };`.

---

### P7: Greedy Boolean Flag Parsing Shifting Positional Arguments in Financial Payments
- **Vulnerability Description:** In `lib/util.js` (lines 77–109), `parseFlags` and `positionals` inspect arguments naively. If an argument starts with `"--"` and does not contain `"="`, and the next argument does not start with `"--"`, it assumes the next argument is the flag's value. When a user runs:
  ```bash
  furlpay pay --yes @recipient 10 usd
  ```
  1. `parseFlags` sets `flags["yes"] = "@recipient"`.
  2. `positionals` drops `@recipient` and returns `["10", "usd"]`.
  3. `furlpay pay` receives `args = ["10", "usd"]`. The intended amount `"10"` is interpreted as the recipient handle!
- **Industry Standard (Stripe CLI / Cobra / Commander):** Command-line parsers in financial software must declare boolean vs value flags explicitly. Boolean flags must never consume subsequent arguments.
- **Defensive Remediation:** Maintain a set of recognized boolean flags (`yes`, `sponsor`, `quiet`, `agent`, `mfa`, `dry-run`, `device`, `check`, `latest`). Only consume the next argument if the flag is known to require a value.

---

### P8: Ephemeral In-Memory Nonce & Spend Tracking Allowing Replay Attacks & Velocity Evasion
- **Vulnerability Description:**
  - In `src/services/x402-facilitator.ts` (line 69), `consumedNonces` is stored in an ephemeral in-memory `Set<string>`.
  - In `src/services/agent-mandate.ts` (line 40), `dailySpendByAgent` is stored in an ephemeral in-memory `Map`.
  Once the CLI process exits, both collections are discarded. An attacker can repeatedly replay the same signed EIP-712 payment authorization across CLI invocations. Furthermore, an AI agent can execute transactions exceeding its daily velocity cap by simply initiating each transaction in a separate CLI process.
- **Industry Standard (Stripe / Circle EIP-3009):**
  - Circle's USDC smart contract stores `_authorizationStates[authorizer][nonce]` on-chain.
  - Off-chain clearing systems (Stripe) require ACID-backed idempotency stores (Redis, DynamoDB, PostgreSQL) with unique constraints and mandatory TTLs.
- **Defensive Remediation:** Back `consumedNonces` and `dailySpendByAgent` with atomic, disk-persisted stores under `~/.furlpay/` using file-locking and JSON ledgers, matching the security pattern used in `AgentKeyService`.

---

### P9: Plaintext Terminal Echo During Interactive Seed Phrase & Private Key Import
- **Vulnerability Description:** In `src/cli.ts` (lines 51–61), `readStdinSecret()` utilizes `readline.createInterface({ input: process.stdin, output: process.stdout })` with `rl.question("", resolve)`. When a user runs `furlpay wallet import --mnemonic` interactively in a TTY, the 12- or 24-word seed phrase or private key is echoed character-by-character on the terminal screen, exposing it to shoulder surfing, shell history, screen recordings, and session logs.
- **Industry Standard (OpenSSL / GPG / HashiCorp Vault):** Secrets entered in an interactive terminal must disable terminal echo (`termios` / `SetConsoleMode` / masking).
- **Defensive Remediation:** Mask keystrokes or suppress terminal echo using standard masking patterns (`rl._writeToOutput = () => {}` or raw mode `process.stdin.setRawMode(true)`).

---

### P10: 64-bit Varint Endianness Inversion & Non-Minimal BIP-62 Push in Bitcoin Utilities
- **Vulnerability Description:**
  - In `lib/forkSweepUtils.js` (lines 37–39):
    ```javascript
    const hi = bytes.readUInt32LE(offset + 1);
    const lo = bytes.readUInt32LE(offset + 5);
    return [hi * 4294967296 + lo, 9];
    ```
    Bitcoin wire varints are little-endian. In little-endian format, bytes `offset+1..offset+4` are the low 32 bits, and `offset+5..offset+8` are the high 32 bits. The code assigned the low 32 bits to `hi`, decoding `1` as `4,294,967,296`.
  - In `buildOpReturnBarrier`, payloads between 76 and 240 bytes use `OP_PUSHDATA2` (`0x4d`), violating Bitcoin BIP-62 rule 4 (non-minimal push). Standard nodes reject non-minimal pushes as invalid script.
- **Industry Standard (Bitcoin Core / BIP-174):**
  - Use `bytes.readBigUInt64LE(offset + 1)`.
  - Use `0x4c` (`OP_PUSHDATA1`) for lengths between 76 and 255 bytes.
- **Defensive Remediation:** Correct varint decoding to `bytes.readBigUInt64LE(offset + 1)` and use `OP_PUSHDATA1` for payloads $\le 255$ bytes.

---

### P11: Synthetic Fallback Transaction Hashes in HLP Vault & 500 bps Default Market Slippage
- **Vulnerability Description:**
  - In `src/hyperliquid/hlp.ts` (lines 137, 186), if the Hyperliquid validator returns `{ status: "ok" }` without a transaction hash, the code constructs synthetic hashes `hlp_dep_${nonce}` and `hlp_wd_${nonce}` and returns `status: "CONFIRMED"`. This directly contradicts the project's stated invariant: *"STRICT POLICY: Zero fabricated transaction hashes in production execution paths."*
  - In `src/hyperliquid/perp.ts` (line 103), perpetual market orders default to an aggressive `slippageBuffer = 0.05` (500 bps / 5%). On institutional crypto venues, a 5% slippage buffer exposes market orders to catastrophic adverse selection and sandwich MEV.
- **Industry Standard (Hyperliquid / Binance):**
  - Real transaction confirmations must return the validator's actual transaction hash or state update; if absent, return `PENDING_CONFIRMATION` or fail closed.
  - Market order slippage buffers must default to no more than 20–50 bps (0.2%–0.5%), with explicit user configuration required for wider tolerances.
- **Defensive Remediation:** Require genuine exchange execution receipts and reduce default market slippage buffer to 0.005 (50 bps).

---

### P12: Hidden Test Failures via Excluded Test Suites & Unbuilt TypeScript Dependency
- **Vulnerability Description:**
  - In `package.json` (line 58), `test/payment.test.js` and `test/http.test.js` are omitted from the default test runner because they invoke functions on `lib/payTui.js` (`parseAmount`, `validateQuote`, `confirmPayment`) that were never implemented, causing 15 test failures when executed.
  - Running `npm test` after a clean clone fails with `MODULE_NOT_FOUND` because tests require compiled JavaScript in `dist/`, but `package.json`'s test script does not trigger `npm run build` as a prerequisite.
- **Industry Standard (Circle CI / Stripe CI):** CI pipelines and package scripts must enforce clean builds before test runs (`"test": "npm run build && node --test ..."`), and all test files in the repository must be actively executed and passing without exclusion.
- **Defensive Remediation:**
  - Implement missing utility exports in `lib/payTui.js` and un-exclude `payment.test.js` and `http.test.js`.
  - Prepend `npm run build` to `"test"` in `package.json`.

---

## 3. Real-Money Testing & Configuration Protocol (2026 Standards)

This section provides the exact technical guide for deploying and testing the FurlPay CLI with **real funds** across its primary rails: Hyperliquid L1, Stellar SDEX / Soroban, Binance Spot, x402 Micropayments, and the Model Context Protocol (MCP) Agent server.

### 3.1. General Safety & Key Management Architecture
Before testing with real money, implement the institutional **4-Tier Key Hierarchy**:
1. **Master Cold Key (Ledger / Hardware APDU):** Holds primary treasury funds and signs administrative approvals (`Chain ID 0x66eee` on Hyperliquid; master Stellar signing).
2. **Delegated API Agent Key (EIP-712 Phantom Agent):** Ephemeral session key authorized strictly for trade actions (`Chain ID 1337`). Holds zero withdrawal capabilities.
3. **Local Encrypted Keystore (`~/.furlpay/keystore.enc`):** PBKDF2 (100,000 iterations, SHA-512) + AES-256-GCM.
4. **Environment Isolation:** Keys must only be supplied via environment variables (`HYPERLIQUID_PRIVATE_KEY`, `BINANCE_API_KEY`) or piped through stdin. Never pass private keys as CLI arguments.

---

### 3.2. Hyperliquid L1 Perpetuals & HLP Vault Testing (LIVE Rail)

The Hyperliquid L1 perpetual execution and HLP vault transfers in this codebase are **LIVE and cryptographically signed** via EIP-712 Phantom Agent envelopes.

#### A. Funding the Account
1. Connect an EVM wallet to Arbitrum One.
2. Acquire Arbitrum native USDC.
3. Deposit USDC into the canonical Hyperliquid Arbitrum Bridge contract:
   - **Mainnet Bridge Contract:** `0x2df1c51e09aecf9cacb7bc98cb1742757f163df7`
4. Verify your balance on the Hyperliquid L1 Clearinghouse:
   - Within 1–2 minutes, the funds appear in your Hyperliquid L1 account equity.

#### B. Generating an API Trading Agent (Recommended)
Rather than exposing your master private key, create an API Agent Wallet:
1. Generate an ephemeral EVM keypair (API Wallet).
2. Sign an `approveAgent` action using your master wallet on Hyperliquid:
   - Domain: `HyperliquidSignTransaction`, Chain ID: `421614` / `0x66eee`.
3. Set the agent private key in your workstation environment:
   ```bash
   export HYPERLIQUID_PRIVATE_KEY="0x<your_api_agent_private_key>"
   export FURLPAY_HL_TESTNET="0"
   ```

#### C. Step-by-Step Real-Money Test Sequence
```bash
# 1. Verify live validator connectivity and universe latency
furlpay hyperliquid status

# 2. Inspect clearinghouse equity and available margin
furlpay account balance

# 3. Configure strict pre-trade risk guardrails
furlpay trading limits --max-single-order 25 --max-leverage 3

# 4. Inspect live L2 book, depth bands, and microprice for BTC-PERP
furlpay market BTC

# 5. Place a micro-sized perpetual limit order (e.g. 0.001 BTC at 2x leverage)
furlpay trade perp BTC --side buy --size 0.001 --leverage 2 --limit <bid_price>

# 6. Verify resting order in the clearinghouse
furlpay account orders

# 7. Cancel the resting order
furlpay trade cancel <order_id> --symbol BTC

# 8. Test market fill with immediate reduce-only close
furlpay trade perp BTC --side buy --size 0.001 --leverage 2
furlpay account positions
furlpay trade close BTC

# 9. Test HLP Vault deposit ($10 USDC micro-deposit; Note: 4-day lockup!)
furlpay earn hlp stats
furlpay earn hlp deposit 10
furlpay earn hlp stats
```

---

### 3.3. Stellar Network (SDEX & Soroban) Transition to Real Money

*Note: In the current v0.4.0 release, Stellar SDEX order placement and Soroban AMM swaps are locally simulated (`simulated: true`, `sim_` hashes).*

#### A. Transitioning from Simulation to Live Network Execution
To enable real broadcast of Stellar transactions to Horizon mainnet:
1. **Fund a Native Stellar Account:**
   - Fund a public key (`G...`) with at least 5 XLM (base reserve: 0.5 XLM per trustline/offer + transaction fees).
2. **Establish USDC Trustline:**
   - Asset: `USDC`
   - Issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Circle official Stellar issuer).
3. **Configure Environment:**
   ```bash
   export STELLAR_NETWORK="PUBLIC"
   export HORIZON_URL="https://horizon.stellar.org"
   ```
4. **Code Activation:**
   In `src/trade/sdex.ts` and `src/trade/soroban.ts`, replace the synthetic `sim_` hash return with real transaction submission:
   ```typescript
   const server = new Horizon.Server("https://horizon.stellar.org");
   const account = await server.loadAccount(pubkey);
   const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.PUBLIC })
     .addOperation(Operation.manageBuyOffer({ ... }))
     .setTimeout(30)
     .build();
   tx.sign(signer.keypair);
   const response = await server.submitTransaction(tx);
   ```

#### B. Verification Command (Live on Mainnet Today)
You can verify real mainnet transactions immediately using the honest verification engine:
```bash
furlpay tx verify 37ccb558c42b9386c91a7895e54d3da92ddf3e09cb46d5119be0eb4cf49679e4 --network mainnet
```

---

### 3.4. Binance Spot Live Integration Testing

#### A. Prerequisites & Credentials
1. Create API Key and Secret on Binance with **Enable Reading** and **Enable Spot & Margin Trading**.
2. **STRICT REQUIREMENT:** Ensure **Enable Withdrawals** is **UNCHECKED** (disabled).
3. Bind the API key to your static egress IP address.
4. Set credentials in your environment:
   ```bash
   export BINANCE_API_KEY="<your_api_key>"
   export BINANCE_API_SECRET="<your_api_secret>"
   export FURLPAY_BINANCE_ENV="mainnet"
   ```

#### B. Testing Procedure
1. Wire `binance` into `bin/furlpay.js`.
2. Inspect live account spot balances:
   ```bash
   # Verifies HMAC-SHA256 signature and network round-trip
   furlpay binance balances
   ```
3. Inspect 24h ticker and order book depth:
   ```bash
   furlpay binance ticker BTCUSDT
   furlpay binance depth BTCUSDT --limit 10
   ```
4. Place a minimum notional test market buy (e.g. $10 USDT of BTC):
   ```bash
   furlpay binance spot buy BTCUSDT --quote 10
   ```
5. Inspect open orders and cancel:
   ```bash
   furlpay binance open-orders
   ```

---

### 3.5. Model Context Protocol (MCP) AI Agent Real-Money Testing

When configuring FurlPay MCP for Claude Desktop, Cursor, or Gemini:

#### A. Configuration (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "furlpay-execution": {
      "command": "node",
      "args": ["c:/Users/ashut/Downloads/Furlpay cli/bin/furlpay.js", "mcp", "--wallet", "agent-alpha"],
      "env": {
        "HYPERLIQUID_PRIVATE_KEY": "0x<api_agent_key>",
        "FURLPAY_HL_TESTNET": "0"
      }
    }
  }
}
```

#### B. Mandatory Agent Policy Initialization
Before allowing an AI agent to execute trades, generate an atomic spend policy:
```bash
furlpay wallet agent-keygen \
  --name agent-alpha \
  --daily-limit 50.00 \
  --single-tx-cap 10.00 \
  --allowed-assets USDC,BTC,ETH,HYPE \
  --expiry 7d
```

#### C. Human-in-the-Loop Approval Test
1. In Claude / Cursor, prompt: *"Check my Hyperliquid balance and place a $5 long on BTC-PERP."*
2. Verify that the tool call specifies `_meta: { "anthropic/requiresUserInteraction": true }`.
3. Verify that the agent prompts you with an explicit `[y/N]` confirmation dialog showing order size, price, and leverage before any network transmission occurs.

---

## 4. Verification & Regression Matrix

To verify the codebase locally, run the comprehensive verification pipeline:

```bash
# 1. Typecheck the TypeScript codebase
npm run typecheck

# 2. Compile TypeScript to JavaScript in dist/
npm run build

# 3. Execute the 24-file regression test suite
npm test

# 4. Verify live Horizon transaction lookup against Stellar mainnet
node bin/furlpay.js tx verify 37ccb558c42b9386c91a7895e54d3da92ddf3e09cb46d5119be0eb4cf49679e4 --network mainnet

# 5. Verify local configuration structure and security bounds
node bin/furlpay.js config validate --output json

# 6. Execute system diagnostics
node bin/furlpay.js doctor --output json
```

---

## 5. Conclusion & Production Readiness Verdict

**Overall Assessment:** **CONDITIONAL PRODUCTION READINESS**

The FurlPay CLI exhibits sophisticated quantitative and cryptographic capabilities—notably its verified EIP-712 Phantom Agent signing, discrete order lifecycle state machine, real-time L2 order book delta recovery, and honest Horizon verification semantics.

However, **live capital deployment must be gated on remediating vulnerabilities P1 through P4**:
1. Applying atomic spending policy gates to MCP perp execution handlers (`P1`).
2. Correcting negative sign handling in `DecimalMath.parseUnits` (`P2`).
3. Fixing bid-side slippage calculation in `simulateFill` (`P3`).
4. Exposing `furlpay binance` in the CLI dispatch router with request-body signing (`P4`).

Once these remediations are applied and validated against the provided regression test specifications, the system will achieve institutional-grade parity with standards established by Circle, Binance, and Stripe.

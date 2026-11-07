# FurlPay Quant Terminal: Staged Deployment & Operations Guide (2026)
**Document Version**: 2.4.0-PROD  
**Target Systems**: Turborepo Monorepo (`apps/web`, `packages/cli`, `packages/furlpay-quant-mcp`)  
**Deployment Pipeline**: Pre-Deploy Quality Gate + Staged Canary Rollout

---

## 1. Non-Negotiable Pre-Deployment Safety Rules

Before any code deployment or server orchestration:
1. **Never Deploy Directly with Unverified Git Trees**: Production deployment MUST run through `npm run deploy:prod` from the repository root. Pushing to GitHub does not deploy to production.
2. **Pre-Deploy Gate Verification**: `apps/web/scripts/check-deploy-gate.mjs` verifies:
   - Working tree is clean (`git status --porcelain` is empty).
   - HEAD is pushed to origin.
   - GitHub Actions CI workflow reports `success` for the exact commit SHA.
3. **No Secrets in Source**: Secrets must never be prefixed with `NEXT_PUBLIC_`. All environment variables must be declared in `apps/web/src/lib/env.ts` and `.env.example`.
4. **Typecheck Mandate**: `cd apps/web && npx tsc --noEmit` and `npm run typecheck --prefix packages/cli` must pass with exit code 0.

---

## 2. Environment Variables & Keystore Configuration

Ensure the following environment variables are securely provisioned in your runtime secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault, or Vercel Encrypted Secrets):

```bash
# Hyperliquid Configuration
HYPERLIQUID_API_URL="https://api.hyperliquid-testnet.xyz"       # Staging: Testnet
HYPERLIQUID_WS_URL="wss://api.hyperliquid-testnet.xyz/ws"
HYPERLIQUID_CHAIN_ID="1337"                                      # Fixed L1 trading chain
HYPERLIQUID_ADMIN_CHAIN_ID="421614"                              # Arbitrum Sepolia (0x66eee)

# Risk & Mandate Governance
FURLPAY_EXECUTION_MODE="TESTNET_SIMULATION"                      # MUST be TESTNET_SIMULATION initially
FURLPAY_MAX_ORDER_NOTIONAL="50000"                               # $50,000 USD limit
FURLPAY_DAILY_VELOCITY_CAP="250000"                              # $250,000 USD limit
FURLPAY_STALE_QUOTE_THRESHOLD_MS="200"                           # 200ms freshness
FURLPAY_MAX_SLIPPAGE_BPS="50"                                    # 50 bps max slippage
FURLPAY_USDC_DEPEG_TOLERANCE_BPS="25"                            # 25 bps depeg halt

# Keystore & Audit
FURLPAY_KEYSTORE_PATH="/var/furlpay/secure/keystore.enc"
FURLPAY_AUDIT_LOG_PATH="/var/furlpay/logs/audit-chain.jsonl"
```

---

## 3. Staged 4-Phase Deployment Protocol

```
[ Phase 0: Build & Gate ] ──> [ Phase 1: 72h Testnet Soak ] ──> [ Phase 2: Canary Mainnet ] ──> [ Phase 3: Scale ]
```

### Phase 0: Build, Typecheck & Test Suite Execution
Run the complete compilation and test pipeline locally and in CI:

```bash
# 1. Typecheck web application
cd apps/web
npx tsc --noEmit

# 2. Build CLI and Quant packages
cd ../../packages/cli
npm run build
npm test

# Verify all 15 suites pass (106 tests, 0 failures)
```

### Phase 1: 72-Hour Continuous Testnet Staging Soak
Deploy the terminal in `TESTNET_SIMULATION` mode against Hyperliquid Testnet:
1. Start the trading daemon with continuous state reconciliation:
   ```bash
   furlpay quant daemon --venue hyperliquid --network testnet --soak-test
   ```
2. Monitor memory RSS usage, WebSocket reconnect events, and blotter reconciliation deltas.
3. Criteria to advance: 72 hours of uninterrupted execution with zero unhandled exceptions and zero balance drift $> \$0.01$.

### Phase 2: Canary Small-Capital Mainnet Deployment
Upon passing Phase 1 and securing the 2-of-3 multi-sig key ceremony:
1. Configure `FURLPAY_EXECUTION_MODE="MAINNET_CANARY"`.
2. Restrict total deposited capital to **\$500 USDC**.
3. Limit single order size to **\$25 USDC** with maximum 2x leverage.
4. Run for 24 hours under active monitoring by the Risk Officer.

### Phase 3: Full Institutional Production Rollout
1. Expand position sizing limits according to approved treasury mandates.
2. Execute production deployment from repo root:
   ```bash
   npm run deploy:prod
   ```
3. Enable 24/7 PagerDuty surveillance and continuous SHA-256 blotter replication.

---

## 4. Rollback & Disaster Recovery Procedures

If an anomalous execution behavior or reconciliation discrepancy occurs in production:

### 1. Trigger Global Emergency Kill Switch
```bash
furlpay quant kill-switch --halt --reason "Production anomaly detected"
```

### 2. Immediate Deployment Rollback
Revert to the last verified stable release commit:
```bash
git checkout <LAST_KNOWN_STABLE_SHA>
npm run deploy:prod -- --force-incident-rollback
```

### 3. Reconcile Positions Manually
Extract the durable blotter and compare against the Hyperliquid L1 block explorer to account for any unconfirmed in-flight transactions:
```bash
furlpay quant blotter --export --format json > blotter-incident-dump.json
```
Do not unfreeze trading until the Incident Commander and Risk Officer sign the incident resolution log.

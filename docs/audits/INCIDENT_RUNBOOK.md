# FurlPay Quant Terminal: Institutional Incident Runbook & Emergency Operations (2026)
**Document Version**: 2.5.0-PROD  
**Target Systems**: Hyperliquid L1 Connector, FurlPay Core L1, Workstation TUI  
**Classification**: STRICTLY CONFIDENTIAL // OPERATIONS ONLY

---

## 1. Emergency Escalation Matrix

| Role | Designation | Contact Method | Incident Authority |
|:---|:---|:---|:---|
| **Incident Commander** | Lead Systems Architect | PagerDuty Tier 1 / Secure Comms | Full system halt, failover trigger |
| **Risk Officer** | Head of Quant Risk | PagerDuty Tier 1 / Phone | Margin override, liquidation defense |
| **Clearing Lead** | Institutional Treasury Lead | PagerDuty Tier 2 / Hardware Key | Multi-sig key revocation, withdrawal freeze |
| **On-Call Engineer** | Infrastructure Quant | PagerDuty Tier 2 / Slack `#incident-war-room` | Code deployment, service restart |

---

## 2. Emergency Operational Runbooks

### Runbook 1: Global Emergency Kill Switch Activation (Code RED)
* **Trigger Conditions**: Rogue agent behavior, uncontrolled order cascade, unknown execution bug, or market-wide flash crash.
* **Immediate Operational Actions**:
  1. **TUI Hotkey**: Press `Ctrl+K` within the Institutional Workstation to trigger the hardware-level kill switch immediately.
  2. **CLI Command**:
     ```bash
     furlpay quant kill-switch --halt --reason "Emergency halt triggered by Risk Officer"
     ```
  3. **Automated Subsystem Actions**:
     - `ExecutionAuthorizationService` transitions to `HALTED`.
     - All in-flight order routing is instantly blocked ($< 50\mu\text{s}$).
     - Transmits batch cancellation request to Hyperliquid: `{"type": "cancelByCloid", ...}` for all active resting orders.
  4. **Post-Halt Verification**:
     Query open orders via REST to verify zero resting exposure:
     ```bash
     furlpay quant orders --status open --venue hyperliquid
     ```

---

### Runbook 2: In-Flight Order Network Timeout & State Desynchronization
* **Trigger Conditions**: An HTTP POST order submission to `/exchange` times out after 1,000ms due to validator network jitter.
* **Symptoms**: Order status in local blotter is `TIMEOUT_DESYNC`.
* **Prohibited Action**: **DO NOT RE-SUBMIT THE ORDER.** Re-submitting an order without checking exchange state will cause a catastrophic double execution.
* **Resolution Steps**:
  1. The `MarketRecoveryEngine` automatically queries the authoritative Hyperliquid REST `/info` endpoint using the unique 128-bit `cloid`:
     ```json
     { "type": "orderStatus", "user": "0x...", "oid": "0x<cloid>" }
     ```
  2. **Scenario A (Order exists on exchange)**:
     - Update local blotter state to match exchange status (`RESTING` or `FILLED`).
     - Emit `RECONCILED_SUCCESS` event to `DurableEventStore`.
  3. **Scenario B (Order does NOT exist on exchange)**:
     - Transition order state to `FAILED_EXPIRED`.
     - Release reserved initial margin back to available buying power.
  4. If query fails repeatedly, pause automated routing and notify the Incident Commander.

---

### Runbook 3: Exchange Clearinghouse Balance Divergence ($|\Delta| > \$0.01$)
* **Trigger Conditions**: `ExchangeStateReconciler` detects that internal equity or per-asset position size differs from Hyperliquid L1 `clearinghouseState` by more than $\$0.01$ USD.
* **Resolution Steps**:
  1. Reconciler automatically enters `RECONCILIATION_HALT`, rejecting new orders.
  2. Inspect the audit logs to identify the exact diverging transaction:
     ```bash
     furlpay quant blotter --verify-integrity --tail 50
     ```
  3. Common causes:
     - Unrecorded funding rate settlement deduction.
     - Unexpected liquidation tranche fee or borrow interest charge.
     - Delayed fill update from WebSocket dropped packet.
  4. Once root cause is identified, trigger an authoritative state sync:
     ```bash
     furlpay quant sync --force --venue hyperliquid --confirm-reset
     ```
  5. Require dual sign-off from Risk Officer and On-Call Engineer before lifting the halt.

---

### Runbook 4: WebSocket Disconnection, Stale Data & Crossed Book Detection
* **Trigger Conditions**: Market data age exceeds 200ms, or best bid $\ge$ best ask.
* **Automated Defensive Actions**:
  1. `FurlPayInstitutionalRiskEngine` immediately flags quotes as `STALE` or `CROSSED`.
  2. All trading functions fail closed with error code `ERR_STALE_MARKET_DATA` or `ERR_CROSSED_ORDER_BOOK`.
* **Manual Recovery Procedure**:
  1. If connection does not auto-recover within 5 seconds, restart the WebSocket gateway connection:
     ```bash
     furlpay quant feed --reconnect --venue hyperliquid
     ```
  2. Verify that `MarketRecoveryEngine` fetches a full REST snapshot before trading resumes.

---

### Runbook 5: Compromised Delegated Agent Session Key
* **Trigger Conditions**: Unauthorized orders detected from an autonomous agent or suspected API key leak.
* **Resolution Steps**:
  1. **Immediate Revocation**: Using the master hardware wallet, broadcast an `approveAgent` revocation transaction to Hyperliquid L1:
     ```bash
     furlpay quant agent revoke --agent-address 0xCompromisedAgentAddress --hardware-wallet ledger
     ```
  2. **Cancel All Orders**: Cancel all resting orders associated with that agent address:
     ```bash
     furlpay quant orders cancel-all --agent 0xCompromisedAgentAddress
     ```
  3. **Rotate Secrets**: Rotate the local encrypted keystore and generate a new session key pair.
  4. Record the incident and cryptographic proofs in the permanent security register.

---

### Runbook 6: USDC Stablecoin Quanto Depeg Event
* **Trigger Conditions**: External oracle reports USDC/USD price $< \$0.9975$ or $> \$1.0025$ ($> 25\text{ bps}$ depeg).
* **Defensive Actions**:
  1. `FurlPayInstitutionalRiskEngine` enters `SAFE_HARBOR_DEPEG_HALT`.
  2. System refuses to open any new leveraged positions that rely on USDC as collateral.
  3. Monitor open positions closely. If depeg widens beyond 100 bps (\$0.9900), initiate planned hedging or off-market position wind-down to protect treasury assets.

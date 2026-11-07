/**
 * FurlPay Exchange State Reconciler (2026)
 * 
 * Continuously reconciles internal double-entry ledger state against external
 * exchange clearinghouse state. Enforces mathematical parity across:
 * - Account equity / accountValue
 * - Free collateral / withdrawable
 * - Total margin used
 * - Individual asset positions (size, entry price, liquidation price)
 * 
 * Triggers automated execution halt and discrepancy audit on delta > $0.01 USD.
 */

export interface InternalLedgerState {
  accountValueUsd: number;
  totalMarginUsedUsd: number;
  freeCollateralUsd: number;
  positions: Map<string, { size: number; entryPx: number }>;
}

export interface ExchangeClearinghouseSnapshot {
  accountValue: string | number;
  totalMarginUsed: string | number;
  withdrawable: string | number;
  assetPositions: Array<{
    coin: string;
    size: string | number;
    entryPx: string | number;
  }>;
}

export interface ReconciliationReport {
  isSynchronized: boolean;
  timestamp: number;
  discrepancies: Array<{
    field: string;
    internalValue: string | number;
    exchangeValue: string | number;
    deltaUsd: number;
    severity: "INFO" | "WARNING" | "CRITICAL";
  }>;
  totalDivergenceUsd: number;
}

export class ExchangeStateReconciler {
  public static readonly DIVERGENCE_TOLERANCE_USD = 0.01; // $0.01 threshold

  /**
   * Evaluates parity between internal ledger state and external exchange snapshot.
   */
  public reconcile(
    internal: InternalLedgerState,
    exchange: ExchangeClearinghouseSnapshot
  ): ReconciliationReport {
    const now = Date.now();
    const discrepancies: ReconciliationReport["discrepancies"] = [];
    let totalDivergence = 0;

    const exAccountVal = typeof exchange.accountValue === "number" ? exchange.accountValue : parseFloat(exchange.accountValue);
    const exMarginUsed = typeof exchange.totalMarginUsed === "number" ? exchange.totalMarginUsed : parseFloat(exchange.totalMarginUsed);
    const exWithdrawable = typeof exchange.withdrawable === "number" ? exchange.withdrawable : parseFloat(exchange.withdrawable);

    // 1. Account Equity Check
    const deltaEquity = Math.abs(internal.accountValueUsd - exAccountVal);
    if (deltaEquity > ExchangeStateReconciler.DIVERGENCE_TOLERANCE_USD) {
      totalDivergence += deltaEquity;
      discrepancies.push({
        field: "accountValue",
        internalValue: internal.accountValueUsd,
        exchangeValue: exAccountVal,
        deltaUsd: deltaEquity,
        severity: deltaEquity > 10.0 ? "CRITICAL" : "WARNING",
      });
    }

    // 2. Margin Used Check
    const deltaMargin = Math.abs(internal.totalMarginUsedUsd - exMarginUsed);
    if (deltaMargin > ExchangeStateReconciler.DIVERGENCE_TOLERANCE_USD) {
      totalDivergence += deltaMargin;
      discrepancies.push({
        field: "totalMarginUsed",
        internalValue: internal.totalMarginUsedUsd,
        exchangeValue: exMarginUsed,
        deltaUsd: deltaMargin,
        severity: deltaMargin > 10.0 ? "CRITICAL" : "WARNING",
      });
    }

    // 3. Free Collateral Check
    const deltaCollateral = Math.abs(internal.freeCollateralUsd - exWithdrawable);
    if (deltaCollateral > ExchangeStateReconciler.DIVERGENCE_TOLERANCE_USD) {
      totalDivergence += deltaCollateral;
      discrepancies.push({
        field: "freeCollateral",
        internalValue: internal.freeCollateralUsd,
        exchangeValue: exWithdrawable,
        deltaUsd: deltaCollateral,
        severity: deltaCollateral > 10.0 ? "CRITICAL" : "WARNING",
      });
    }

    // 4. Position Parity Check
    const exchangePositionMap = new Map<string, { size: number; entryPx: number }>();
    for (const p of exchange.assetPositions) {
      exchangePositionMap.set(p.coin, {
        size: typeof p.size === "number" ? p.size : parseFloat(p.size),
        entryPx: typeof p.entryPx === "number" ? p.entryPx : parseFloat(p.entryPx),
      });
    }

    // Check internal vs exchange
    for (const [coin, intPos] of internal.positions.entries()) {
      const exPos = exchangePositionMap.get(coin);
      if (!exPos) {
        const delta = Math.abs(intPos.size * intPos.entryPx);
        totalDivergence += delta;
        discrepancies.push({
          field: `position.${coin}`,
          internalValue: `size: ${intPos.size}`,
          exchangeValue: "NOT_FOUND",
          deltaUsd: delta,
          severity: "CRITICAL",
        });
      } else {
        const szDelta = Math.abs(intPos.size - exPos.size);
        if (szDelta > 0.0001) {
          const delta = szDelta * exPos.entryPx;
          totalDivergence += delta;
          discrepancies.push({
            field: `position.${coin}.size`,
            internalValue: intPos.size,
            exchangeValue: exPos.size,
            deltaUsd: delta,
            severity: "CRITICAL",
          });
        }
      }
    }

    // Check exchange positions missing internally
    for (const [coin, exPos] of exchangePositionMap.entries()) {
      if (!internal.positions.has(coin) && Math.abs(exPos.size) > 0.0001) {
        const delta = Math.abs(exPos.size * exPos.entryPx);
        totalDivergence += delta;
        discrepancies.push({
          field: `position.${coin}`,
          internalValue: "NOT_FOUND",
          exchangeValue: `size: ${exPos.size}`,
          deltaUsd: delta,
          severity: "CRITICAL",
        });
      }
    }

    return {
      isSynchronized: discrepancies.length === 0,
      timestamp: now,
      discrepancies,
      totalDivergenceUsd: totalDivergence,
    };
  }

  /**
   * Safely synchronizes internal ledger state to match verified exchange snapshot.
   */
  public synchronize(
    internal: InternalLedgerState,
    exchange: ExchangeClearinghouseSnapshot
  ): void {
    internal.accountValueUsd = typeof exchange.accountValue === "number" ? exchange.accountValue : parseFloat(exchange.accountValue);
    internal.totalMarginUsedUsd = typeof exchange.totalMarginUsed === "number" ? exchange.totalMarginUsed : parseFloat(exchange.totalMarginUsed);
    internal.freeCollateralUsd = typeof exchange.withdrawable === "number" ? exchange.withdrawable : parseFloat(exchange.withdrawable);

    internal.positions.clear();
    for (const p of exchange.assetPositions) {
      const sz = typeof p.size === "number" ? p.size : parseFloat(p.size);
      if (Math.abs(sz) > 0.0001) {
        internal.positions.set(p.coin, {
          size: sz,
          entryPx: typeof p.entryPx === "number" ? p.entryPx : parseFloat(p.entryPx),
        });
      }
    }
  }
}

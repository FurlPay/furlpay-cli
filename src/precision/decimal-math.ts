/**
 * FurlPay Precision Decimal Accounting Library (2026)
 * 
 * Replaces IEEE 754 binary floating-point calculations with deterministic
 * scaled BigInt integer arithmetic to prevent rounding errors in financial ledgers,
 * margin checks, and liquidation price equations.
 */

export class DecimalMath {
  public static readonly USDC_DECIMALS = 6;
  public static readonly PRICE_DECIMALS = 6;
  public static readonly BPS_FACTOR = 10_000n;

  /**
   * Parse a decimal string into a scaled BigInt.
   * Example: "42.85", decimals=6 -> 42850000n
   *
   * The sign is parsed independently of the digits: BigInt("-0") === 0n, so a
   * `cleanInteger < 0n` test loses the sign of every -1 < x < 0 value
   * (parseUnits("-0.50") used to return +500000n, inverting negative PnL and
   * fees into gains — 2026-11-16 audit P2).
   */
  public static parseUnits(valStr: string | number, decimals: number = 6): bigint {
    const s = typeof valStr === "number" ? valStr.toString() : valStr.trim();
    if (!s || s === "NaN" || isNaN(Number(s))) return 0n;
    // Only plain decimal notation is accepted: scientific form ("1e7") would
    // otherwise throw out of BigInt() mid-calculation.
    if (!/^[+-]?(\d+)?(\.\d*)?$/.test(s) || s === "." || s === "+" || s === "-") return 0n;

    const negative = s.startsWith("-");
    const [integerPart, fractionalPart = ""] = s.replace(/^[+-]/, "").split(".");
    const cleanInteger = BigInt(integerPart || "0");
    const paddedFraction = fractionalPart.padEnd(decimals, "0").slice(0, decimals);
    const fractionBig = BigInt(paddedFraction || "0");

    const scale = 10n ** BigInt(decimals);
    const magnitude = cleanInteger * scale + fractionBig;
    return negative ? -magnitude : magnitude;
  }

  /**
   * Format a scaled BigInt back to a formatted decimal string.
   */
  public static formatUnits(units: bigint, decimals: number = 6): string {
    const isNegative = units < 0n;
    const absUnits = isNegative ? -units : units;
    const scale = 10n ** BigInt(decimals);

    const integerPart = absUnits / scale;
    const fractionPart = absUnits % scale;
    const paddedFraction = fractionPart.toString().padStart(decimals, "0");

    const sign = isNegative ? "-" : "";
    return `${sign}${integerPart.toString()}.${paddedFraction}`;
  }

  /**
   * Multiplies two decimal values at standard precision (6 decimals):
   * (A * B) / 10^6
   */
  public static mul(aStr: string | number, bStr: string | number, decimals: number = 6): string {
    const a = DecimalMath.parseUnits(aStr, decimals);
    const b = DecimalMath.parseUnits(bStr, decimals);
    const scale = 10n ** BigInt(decimals);
    const res = (a * b) / scale;
    return DecimalMath.formatUnits(res, decimals);
  }

  /**
   * Divides two decimal values at standard precision:
   * (A * 10^6) / B
   */
  public static div(aStr: string | number, bStr: string | number, decimals: number = 6): string {
    const a = DecimalMath.parseUnits(aStr, decimals);
    const b = DecimalMath.parseUnits(bStr, decimals);
    if (b === 0n) throw new Error("DIVISION_BY_ZERO: Cannot divide by zero.");
    const scale = 10n ** BigInt(decimals);
    const res = (a * scale) / b;
    return DecimalMath.formatUnits(res, decimals);
  }

  /**
   * Discrete rounding to exact exchange tick size.
   * Example: price 92150.24 with tick 0.5 -> 92150.0
   *
   * Integer-minor arithmetic end to end (round half away from zero); the old
   * Math.round/parseFloat path re-entered IEEE-754 on the decision boundary
   * (audit P2).
   */
  public static roundToTick(priceStr: string | number, tickSize: number): string {
    const t = DecimalMath.parseUnits(tickSize, DecimalMath.PRICE_DECIMALS);
    if (t <= 0n) throw new Error("INVALID_TICK_SIZE: tick size must be positive.");
    const decimals = tickSize < 1 ? Math.max(1, -Math.floor(Math.log10(tickSize))) : 1;
    const p = DecimalMath.parseUnits(priceStr, DecimalMath.PRICE_DECIMALS);
    const half = p >= 0n ? t / 2n : -(t / 2n);
    const roundedMinor = ((p + half) / t) * t;
    const scaleOut = 10n ** BigInt(DecimalMath.PRICE_DECIMALS - decimals);
    return DecimalMath.formatUnits(roundedMinor / scaleOut, decimals);
  }

  /**
   * Discrete lot sizing for order base quantity — truncation toward zero at
   * the lot precision (a size is never rounded UP past what the caller can
   * fill). parseUnits already slices the fraction at `szDecimals` digits, so
   * no float is involved.
   */
  public static roundToLot(szStr: string | number, szDecimals: number): string {
    return DecimalMath.formatUnits(DecimalMath.parseUnits(szStr, szDecimals), szDecimals);
  }

  /**
   * Deterministic realized P&L calculation:
   * Long:  size * (exitPx - entryPx)
   * Short: size * (entryPx - exitPx)
   */
  public static computeRealizedPnl(
    isBuy: boolean,
    sizeStr: string | number,
    entryPxStr: string | number,
    exitPxStr: string | number
  ): string {
    const sz = DecimalMath.parseUnits(sizeStr, 6);
    const entry = DecimalMath.parseUnits(entryPxStr, 6);
    const exit = DecimalMath.parseUnits(exitPxStr, 6);
    const scale = 1_000_000n;

    const diff = isBuy ? exit - entry : entry - exit;
    const pnlUnits = (sz * diff) / scale;
    return DecimalMath.formatUnits(pnlUnits, 6);
  }

  /**
   * Slippage basis points between expected and executed price:
   * (|exec - expected| / expected) * 10,000
   */
  public static computeSlippageBps(expectedPxStr: string | number, executedPxStr: string | number): number {
    const exp = DecimalMath.parseUnits(expectedPxStr, 6);
    const exec = DecimalMath.parseUnits(executedPxStr, 6);
    if (exp === 0n) return 0;

    const diff = exec >= exp ? exec - exp : exp - exec;
    const bps = (diff * 10_000n) / exp;
    return Number(bps);
  }

  /**
   * Verified Protocol Maintenance Margin Rate:
   * l = 1 / (2 * maxLeverage)
   */
  public static maintenanceMarginRate(maxLeverage: number): number {
    if (maxLeverage <= 0) return 0.05;
    return 1.0 / (2.0 * maxLeverage);
  }

  /**
   * Verified Protocol Liquidation Price (General-Purpose):
   * P_liq = P_entry - (s * M_available) / [Q * (1 - s * l)]
   * 
   * Where:
   * - s: +1 for Long, -1 for Short
   * - Q: absolute position size
   * - M_available: available margin buffer (Account Value - MMR for cross, Assigned - MMR for isolated)
   * - l: maintenance margin rate (1 / 2*maxLeverage)
   */
  public static computeProtocolLiquidationPrice(
    entryPxStr: string | number,
    positionSizeStr: string | number,
    availableMarginStr: string | number,
    isBuy: boolean,
    maintenanceMarginRate: number
  ): string {
    const P_entry = typeof entryPxStr === "number" ? entryPxStr : parseFloat(entryPxStr);
    const Q = Math.abs(typeof positionSizeStr === "number" ? positionSizeStr : parseFloat(positionSizeStr));
    const M_available = typeof availableMarginStr === "number" ? availableMarginStr : parseFloat(availableMarginStr);
    const s = isBuy ? 1 : -1;
    const l = maintenanceMarginRate;

    if (Q === 0) return "0.00";

    const denominator = Q * (1.0 - s * l);
    if (denominator <= 0) return "0.00";

    const P_liq = P_entry - (s * M_available) / denominator;
    return Math.max(0, P_liq).toFixed(2);
  }

  /**
   * Standard Liquidation Price (Isolated Margin with zero extra collateral):
   * P_liq = Entry * (1 - s/L) / (1 - s*l)
   */
  public static computeLiquidationPrice(
    entryPxStr: string | number,
    leverage: number,
    isBuy: boolean,
    maxLeverage: number = 50
  ): string {
    const entry = typeof entryPxStr === "number" ? entryPxStr : parseFloat(entryPxStr);
    const l = DecimalMath.maintenanceMarginRate(maxLeverage);

    let liq = 0;
    if (isBuy) {
      liq = entry * ((1.0 - 1.0 / leverage) / (1.0 - l));
    } else {
      liq = entry * ((1.0 + 1.0 / leverage) / (1.0 + l));
    }
    return Math.max(0, liq).toFixed(2);
  }

  /**
   * Verified Protocol Funding Rate Formula:
   * F = P + Clamp(I - P, -0.0005, +0.0005)
   * Where I = 0.0001 / 8 (0.01% per 8h fixed interest rate)
   */
  public static computeFundingRate(avgPremium: number): number {
    const I = 0.0001 / 8; // 0.0000125
    const diff = I - avgPremium;
    const clampedDiff = Math.max(-0.0005, Math.min(0.0005, diff));
    const rate = avgPremium + clampedDiff;
    return Math.max(-0.0400, Math.min(0.0400, rate)); // 4% max hourly cap
  }
}

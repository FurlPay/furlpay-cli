/**
 * Central money abstraction for the financial operations layer.
 *
 * Rules (2026-11-17 financial-operations spec):
 * - No JavaScript floating-point arithmetic ever touches a financial amount.
 *   Every amount is a BigInt in minor units (cents, micro-USDC, satoshis...)
 *   with its decimal count carried alongside.
 * - Fiat currencies are validated against ISO 4217 (the subset the CLI can
 *   meaningfully report on). Token amounts carry an explicit network — one
 *   USDC on Base is NOT the same settlement object as one USDC on Solana.
 * - Currency conversion is never implicit: converting requires an explicit
 *   ConversionRate object the caller obtained from somewhere real, and the
 *   result records which rate produced it.
 * - Negative and non-finite amounts are rejected at the boundary. Overflow
 *   cannot occur within BigInt, but parsing rejects absurd magnitudes.
 */

// ── ISO 4217 (subset: currencies the CLI can report on) ─────────────────────

const ISO4217: Record<string, number> = {
  USD: 2, EUR: 2, GBP: 2, JPY: 0, CHF: 2, CAD: 2, AUD: 2, NZD: 2,
  SGD: 2, HKD: 2, CNY: 2, INR: 2, KRW: 0, MXN: 2, BRL: 2, ZAR: 2,
  SEK: 2, NOK: 2, DKK: 2, PLN: 2, CZK: 2, HUF: 2, TRY: 2,
};

export function isIso4217(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(ISO4217, code);
}

export function currencyDecimals(code: string): number {
  if (!isIso4217(code)) {
    throw new Error(`"${code}" is not an ISO 4217 code known to this CLI; use the checkout's code, like USD or EUR.`);
  }
  return ISO4217[code];
}

// ── Token registry (asset decimals by network family) ───────────────────────

const TOKEN_DECIMALS: Record<string, number> = {
  USDC: 6, USDT: 6, EURC: 6,
  XLM: 7, SOL: 9, ETH: 18, BTC: 8, WBTC: 8,
};

export function tokenDecimals(asset: string): number {
  const d = TOKEN_DECIMALS[asset.toUpperCase()];
  if (d === undefined) {
    throw new Error(`Unknown token decimals for "${asset}". Extend the registry or pass decimals explicitly — guessing decimals corrupts money.`);
  }
  return d;
}

// ── Amount types ─────────────────────────────────────────────────────────────

export interface FiatAmount {
  kind: "fiat";
  /** ISO 4217 code, uppercase. */
  currency: string;
  /** Integer minor units (e.g. cents). */
  minor: bigint;
}

export interface TokenAmount {
  kind: "token";
  /** Asset symbol, uppercase (USDC, XLM...). */
  asset: string;
  /** Network qualifier — the same asset on different networks is different money. */
  network: string;
  /** Integer minor units of the asset. */
  minor: bigint;
  decimals: number;
}

export type MoneyAmount = FiatAmount | TokenAmount;

const MAX_MINOR = 10n ** 18n; // 10^18 minor units — an obviously-absurd amount guard
const UI_AMOUNT_RE = /^\d+(\.\d+)?$/;

/** Parse a non-negative UI decimal string into minor units. No floats. */
export function parseMinor(ui: string, decimals: number): bigint {
  const s = String(ui).trim();
  if (!UI_AMOUNT_RE.test(s)) {
    throw new Error(`"${ui}" is not a valid non-negative decimal amount.`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`"${ui}" has more decimals than ${decimals} allow; use at most ${decimals} decimal places.`);
  }
  const fracPadded = frac.padEnd(decimals, "0");
  const minor = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  if (minor > MAX_MINOR) {
    throw new Error(`Amount ${ui} exceeds the supported magnitude (10^18 minor units).`);
  }
  return minor;
}

/** Format minor units back to a UI decimal string. No floats. */
export function formatMinor(minor: bigint, decimals: number): string {
  if (minor < 0n) throw new Error("Cannot format a negative amount as unsigned.");
  const scale = 10n ** BigInt(decimals);
  const whole = minor / scale;
  const frac = minor % scale;
  const fracStr = decimals === 0 ? "" : `.${frac.toString().padStart(decimals, "0")}`;
  return `${whole.toString()}${fracStr}`;
}

export function fiat(currency: string, ui: string): FiatAmount {
  const code = currency.toUpperCase();
  const decimals = currencyDecimals(code);
  const minor = parseMinor(ui, decimals);
  if (minor === 0n) throw new Error("A fiat amount must be positive — zero-amount financial records are noise that hides errors.");
  return { kind: "fiat", currency: code, minor };
}

export function token(asset: string, network: string, ui: string, decimals?: number): TokenAmount {
  const sym = asset.toUpperCase();
  const dec = decimals ?? tokenDecimals(sym);
  const net = network.toLowerCase();
  if (!/^[a-z0-9-]{2,24}$/.test(net)) {
    throw new Error(`"${network}" is not a recognizable network identifier.`);
  }
  const minor = parseMinor(ui, dec);
  if (minor === 0n) throw new Error("A token amount must be positive.");
  return { kind: "token", asset: sym, network: net, minor, decimals: dec };
}

/** Human string like "25.00 USD" or "100.000000 USDC (base)". */
export function formatMoney(a: MoneyAmount): string {
  if (a.kind === "fiat") return `${formatMinor(a.minor, currencyDecimals(a.currency))} ${a.currency}`;
  return `${formatMinor(a.minor, a.decimals)} ${a.asset} (${a.network})`;
}

/** Same currency/asset/network and equal minor value. */
export function moneyEquals(a: MoneyAmount, b: MoneyAmount): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "fiat" && b.kind === "fiat") return a.currency === b.currency && a.minor === b.minor;
  if (a.kind === "token" && b.kind === "token") {
    return a.asset === b.asset && a.network === b.network && a.decimals === b.decimals && a.minor === b.minor;
  }
  return false;
}

// ── Explicit conversion (never implicit) ─────────────────────────────────────

export interface ConversionRate {
  /** e.g. "USD", "USDC", "XLM" — matches the amount kinds by code. */
  from: string;
  to: string;
  /** Rate as a decimal string with ≤18 digits ("0.9998"), > 0. */
  rate: string;
  /** When the rate was observed (ms epoch) — stale rates must be visible. */
  timestampMs: number;
  /** Where the rate came from ("coingecko", "manual", ...). Never fabricated. */
  source: string;
}

const RATE_RE = /^\d+\.\d{1,18}$/;

/**
 * Convert using an explicit rate. The caller supplies the rate object; this
 * function does arithmetic only. The result's provenance (rate, timestamp,
 * source) is returned alongside so no record ever hides how it was derived.
 */
export function convert(amount: MoneyAmount, rate: ConversionRate, targetDecimals: number): { minor: bigint; applied: ConversionRate } {
  if (!RATE_RE.test(rate.rate)) {
    throw new Error(`Conversion rate "${rate.rate}" must be a positive decimal string with ≤18 fractional digits.`);
  }
  const [whole, frac] = rate.rate.split(".");
  const rateScale = 10n ** BigInt(frac.length);
  const rateMinor = BigInt(whole) * rateScale + BigInt(frac);
  if (rateMinor === 0n) throw new Error("A conversion rate of zero is not a conversion.");
  // amount.minor * rate.rate, exact rational, then rescale to target decimals.
  // (amount.minor [10^d_src] → value = minor / 10^d_src; result.minor = value * rate / 10^d_tgt)
  const srcScale = 10n ** BigInt(amount.kind === "fiat" ? currencyDecimals(amount.currency) : amount.decimals);
  const tgtScale = 10n ** BigInt(targetDecimals);
  const num = amount.minor * rateMinor * tgtScale;
  const den = srcScale * rateScale;
  return { minor: num / den, applied: rate };
}

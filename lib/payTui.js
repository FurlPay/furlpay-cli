"use strict";
// ---------------------------------------------------------------------------
// @furlpay/cli — Account-to-Account (A2A) B2B Payment TUI
//
// Complete Production UI/UX Design System Specification:
//   macOS Terminal · Dark Fintech Interface · Developer-First
//
// Design Tokens:
//   Brand Mint:     #00E6B8
//   Bright Teal:    #00F5C4
//   Violet Accent:  #6048FF
//   Electric Blue:  #008CFF
//   Primary Text:   #F5F7FF
//   Secondary Text: #B5C5E8
//   Error / Cancel: #FF405B
//   Border:         #1C3447
//   Card Surface:   #0A1A27
//   Panel Surface:  #071522
//   Canvas:         #030B13
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const api = require("./api");
const out = require("./output");
const { renderPayment } = require("./payView");
const { demoQuote } = require("./payDemo");
const { colorLevel } = require("./terminal");

const BOX = {
  tl: "╭", tr: "╮", bl: "╰", br: "╯",
  h: "─", v: "│",
};

// Truecolor & Accessibility Detection
const NO_COLOR = Boolean(process.env.NO_COLOR && process.env.NO_COLOR !== "0");
const IS_TRUECOLOR = !NO_COLOR && Boolean(
  process.env.COLORTERM === "truecolor" ||
  process.env.COLORTERM === "24bit" ||
  process.env.TERM_PROGRAM === "iTerm.app" ||
  process.env.TERM_PROGRAM === "Apple_Terminal" ||
  process.env.WT_SESSION
);

function rgb(r, g, b, fallback256 = 45) {
  if (NO_COLOR) return (s) => String(s);
  if (IS_TRUECOLOR) return (s) => `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
  return (s) => `\x1b[38;5;${fallback256}m${s}\x1b[0m`;
}

function bgRgb(r, g, b, fallback256 = 16) {
  if (NO_COLOR) return (s) => String(s);
  if (IS_TRUECOLOR) return (s) => `\x1b[48;2;${r};${g};${b}m${s}\x1b[0m`;
  return (s) => `\x1b[48;5;${fallback256}m${s}\x1b[0m`;
}

// Design Tokens (Approximate visual tokens matching macOS reference interface)
const theme = {
  brandMint: rgb(0, 230, 184, 48),        // #00E6B8
  brightTeal: rgb(0, 245, 196, 51),       // #00F5C4
  violet: rgb(96, 72, 255, 141),          // #6048FF
  electricBlue: rgb(0, 140, 255, 39),     // #008CFF
  primaryText: rgb(245, 247, 255, 15),    // #F5F7FF
  secondaryText: rgb(181, 197, 232, 248), // #B5C5E8
  border: rgb(28, 52, 71, 240),           // #1C3447
  error: rgb(255, 64, 91, 196),           // #FF405B
  warning: rgb(255, 190, 69, 214),        // #FFBE45
  surfaceBg: bgRgb(7, 21, 34, 233),       // #071522
  cardBg: bgRgb(10, 26, 39, 234),         // #0A1A27
  headerBg: bgRgb(24, 35, 51, 235),       // #182333
  dim: (s) => (NO_COLOR ? String(s) : `\x1b[2m${s}\x1b[0m`),
  bold: (s) => (NO_COLOR ? String(s) : `\x1b[1m${s}\x1b[0m`),
  white: (s) => (NO_COLOR ? String(s) : `\x1b[37m${s}\x1b[0m`),
};

// Neutral Sandbox Fixtures (Strictly isolated for local testing / demo)
const SANDBOX_FIXTURES = {
  "@recipient": {
    name: "Business Account",
    handle: "@recipient",
    legalName: "Demo Operating Entity Inc.",
    bio: "Verified commercial entity account for automated testing and account-to-account demonstration.",
    url: "https://example.com/recipient",
    kybStatus: "verified",
    sanctionsStatus: "clear",
    isFixture: true
  },
  "@test_merchant": {
    name: "Test Merchant Solutions",
    handle: "@test_merchant",
    legalName: "Test Merchant Solutions Ltd.",
    bio: "Authorized merchant recipient endpoint for automated reconciliation and settlement testing.",
    url: "https://example.com/merchant",
    kybStatus: "verified",
    sanctionsStatus: "clear",
    isFixture: true
  },
  "@business_demo": {
    name: "Business Operating Account",
    handle: "@business_demo",
    legalName: "Demo Business Operations LLC",
    bio: "Operating treasury account for testing A2A account clearing and ledger invariance.",
    url: "https://example.com/demo",
    kybStatus: "verified",
    sanctionsStatus: "clear",
    isFixture: true
  }
};

/**
 * Sanitizes untrusted text to prevent ANSI/OSC escape injection,
 * BiDi attacks (\u202E), and hidden control characters.
 */
function sanitizeTerminalText(str) {
  if (!str) return "";
  return String(str)
    // Strip OSC escape sequences (e.g. \x1b]52;... \x07)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // Strip CSI escape sequences (e.g. \x1b[31m, \x1b[2J)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Strip any remaining bare ESC bytes
    .replace(/\x1b/g, "")
    // Strip control characters; \r\n\t become spaces so a multi-line
    // counterparty field cannot re-flow the confirmation UI (line spoofing)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/[\t\r\n]/g, " ")
    // Strip BiDi overrides and embeddings (prevent visual spoofing)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    // Strip zero-width invisible characters
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/** Visual string length ignoring ANSI escape codes */
function visibleLength(str) {
  return String(str || "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\[38;2;[0-9;]*m/g, "").replace(/\x1b\[48;2;[0-9;]*m/g, "").length;
}

/** Right or left padding matching exact visual width */
function pad(str, width, align = "left") {
  const len = visibleLength(str);
  const diff = Math.max(0, width - len);
  return align === "right" ? " ".repeat(diff) + str : str + " ".repeat(diff);
}

/** Standard box drawing */
function drawBox(contentLines, width, borderColor = theme.border) {
  const innerW = width - 2;
  const top = borderColor(BOX.tl + BOX.h.repeat(innerW) + BOX.tr);
  const bottom = borderColor(BOX.bl + BOX.h.repeat(innerW) + BOX.br);
  const body = contentLines.map((line) => {
    return borderColor(BOX.v) + " " + pad(line, innerW - 2) + " " + borderColor(BOX.v);
  });
  return [top, ...body, bottom].join("\n");
}

/** Titled box drawing: title embedded into top rounded border */
function drawTitledBox(title, contentLines, width, borderColor = theme.border) {
  const innerW = width - 2;
  const titleText = ` ${title} `;
  const titleLen = visibleLength(titleText);
  const remainingH = Math.max(0, innerW - titleLen - 2);
  const top = borderColor(BOX.tl + BOX.h + BOX.h) + titleText + borderColor(BOX.h.repeat(remainingH) + BOX.tr);
  const bottom = borderColor(BOX.bl + BOX.h.repeat(innerW) + BOX.br);
  const body = contentLines.map((line) => {
    return borderColor(BOX.v) + " " + pad(line, innerW - 2) + " " + borderColor(BOX.v);
  });
  return [top, ...body, bottom].join("\n");
}

/** Resolves recipient profile dynamically via authoritative API or sandbox fixture */
async function resolveRecipientProfile(handleOrAccount, flags = {}) {
  const normalized = handleOrAccount.trim();
  const handle = normalized.startsWith("@") ? normalized.toLowerCase() : `@${normalized.toLowerCase()}`;

  // 1. Authoritative API Lookup
  try {
    const res = await api.rawRequest("GET", `/api/v1/pay/directory/${encodeURIComponent(handle)}`, { flags });
    if (res && res.status === 200 && res.body) {
      const b = res.body;
      return {
        name: sanitizeTerminalText(b.displayName || handle.slice(1)),
        handle: b.handle,
        legalName: sanitizeTerminalText(b.legalName || b.displayName),
        bio: sanitizeTerminalText(b.bio || ""),
        url: sanitizeTerminalText(b.url || ""),
        kybStatus: b.kybStatus || "unverified",
        sanctionsStatus: b.sanctionsStatus || "clear",
        isFixture: Boolean(b.isFixture)
      };
    }
  } catch {
    // API unreachable or offline
  }

  // 2. Local Sandbox Fixture Check (Gated strictly to sandbox/test environments - SEC-05)
  const isLiveEnv = flags.env === "live" || process.env.NODE_ENV === "production" || process.env.FURLPAY_ENV === "live";
  if (!isLiveEnv && SANDBOX_FIXTURES[handle]) {
    return { ...SANDBOX_FIXTURES[handle] };
  }

  // 3. Dynamic synthesis for arbitrary handle (Strictly unverified — never falsify KYB)
  const rawName = handle.slice(1);
  const formattedName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  return {
    name: sanitizeTerminalText(formattedName),
    handle: handle,
    legalName: sanitizeTerminalText(formattedName),
    bio: "",
    url: "",
    kybStatus: "unverified",
    sanctionsStatus: "clear",
    isFixture: false
  };
}

/** Fetches authoritative payment quote and source balance from API or local fallback */
async function fetchPayQuote(recipient, amount, currency, flags = {}) {
  try {
    const res = await api.rawRequest("POST", "/api/v1/pay/quote", {
      flags,
      body: {
        recipient,
        amount,
        currency,
        dryRun: Boolean(flags["dry-run"])
      }
    });
    if (res && res.status === 200 && res.body && res.body.quoteId) {
      return res.body;
    }
  } catch {
    // Fall back to local calculation
  }

  // Local fallback quote — an ESTIMATE computed in the CLI, not a server
  // quote. It never impersonates a server quoteId: the quo_local_ prefix and
  // the absence of any signature make that structurally clear, and the
  // execute step must treat this id as non-authoritative (a hardcoded HMAC
  // secret here previously forged ids that looked server-signed).
  const expiresAt = Date.now() + 60_000;
  const quoteId = `quo_local_${expiresAt}_${crypto.randomBytes(8).toString("hex")}`;
  const minorUnits = currency === "USDC" ? 1_000_000 : 100;
  return {
    quoteId,
    local: true,
    status: "recipient_resolved",
    amount: {
      decimal: amount,
      atomic: Math.round(amount * minorUnits),
      currency,
      fee: 0.0,
      formatted: `${amount.toFixed(2)} ${currency}`,
    },
    sourceAccount: {
      id: "fa_pending",
      name: "Business Operating Account",
      type: "Business Operating Account",
      balanceUsd: null,
      formattedBalance: "Live account balance",
      yieldApy: 0.0,
      isAuthoritative: false,
    },
    settlement: {
      rail: "FurlPay Ledger",
      supportedChains: ["Arc", "Solana", "Base"],
      latency: "< 50ms",
      frequency: "One-time",
      mode: "live",
    },
    governance: {
      requiresApproval: amount >= 100000.0,
      threshold: 100000.0,
    },
  };
}

/** Interactive raw-mode confirmation prompt */
function waitForKeypress(flags) {
  return new Promise((resolve) => {
    if (flags.yes || flags.y || flags.agent) return resolve(true);
    if (!process.stdin.isTTY) {
      out.fail("Interactive payment confirmation requires a TTY terminal. In automated or headless scripts, pass --yes or --agent explicitly.");
      return resolve(false);
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (data) => {
      const key = String(data);
      if (key === "y" || key === "Y") {
        cleanup();
        resolve(true);
      } else if (key === "n" || key === "N" || key === "\u0003") { // 'n' or Ctrl+C
        cleanup();
        resolve(false);
      }
    };

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    process.stdin.on("data", onData);
  });
}


// ---------------------------------------------------------------------------
// Payment contract primitives (audit P12): the payment suite always imported
// these from lib/payTui.js — parseAmount, validateInput, validateQuote,
// quoteExpiry, receipt, confirmPayment — but the module never exported them,
// so the suite was excluded from `npm test` for months. Each rule below
// encodes a financial invariant, not a style preference.
// ---------------------------------------------------------------------------

/** Audited single-transfer ceiling: $10,000,000.00 in integer cents. */
const MAX_AMOUNT_CENTS = 1_000_000_000n;
const AMOUNT_PATTERN = /^(?:[1-9]\d{0,7}|0)(?:\.(\d{2}))?$/;
const CURRENCIES = new Set(["USD", "USDC", "EUR"]);
const HANDLE_PATTERN = /^@[A-Za-z0-9_]{2,30}$/;
const ENVIRONMENTS = new Set(["sandbox", "live"]);
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
// Server-signed quote ids embed their own absolute deadline:
//   quo_furl_<expiry-epoch-millis>_<signature>
// The advertised expiresAt can only NARROW the window — it must never be able
// to resurrect a signed quote whose embedded deadline has passed.
const SIGNED_QUOTE_DEADLINE = /^quo_furl_(\d+)_/;

/**
 * Exact decimal parsing for payment amounts. Integer cents via BigInt — no
 * IEEE-754 anywhere near money (audit P2's CLI-side sibling). Rejects zero,
 * negatives, exponents, >2 decimals, leading zeros, a bare dot, embedded
 * units ("10usd") and anything above the audited ceiling.
 */
function parseAmount(value) {
  if (typeof value !== "string") {
    throw new Error(`Amount must be a plain decimal string, got: ${String(value)}`);
  }
  const match = AMOUNT_PATTERN.exec(value);
  if (!match) {
    throw new Error(
      `Invalid amount '${value}' — use a plain decimal like 10 or 10.50 (max 2 decimals, no leading zeros, ceiling 10000000.00)`
    );
  }
  const [integers, fractions = ""] = match[0].split(".");
  const cents = BigInt(integers) * 100n + BigInt(fractions);
  if (cents <= 0n) throw new Error(`Amount must be greater than zero: '${value}'`);
  if (cents > MAX_AMOUNT_CENTS) {
    throw new Error(`Amount '${value}' exceeds the audited single-transfer ceiling of $10,000,000.00`);
  }
  return { cents, decimal: Number(value) };
}

/**
 * Strict pre-flight validation for `furlpay pay`. Every rule exists because a
 * lax variant of it once mis-routed money: PowerShell splatting shifts the
 * amount into the recipient slot, ambiguous consent strings ("--yes=false")
 * made automation decisions for users, and value-less idempotency keys
 * silently broke retry safety.
 */
function validateInput(args, flags = {}) {
  if (!Array.isArray(args)) throw new Error("pay() requires an argument array");
  if (flags.env !== undefined && !ENVIRONMENTS.has(String(flags.env))) {
    throw new Error(`Unknown environment '${flags.env}' — expected 'sandbox' or 'live'`);
  }
  if (flags.width !== undefined) {
    const columns = Number(flags.width);
    if (!Number.isInteger(columns) || columns < 20 || columns > 500) {
      throw new Error("--width must be an integer between 20 and 500 columns");
    }
  }
  if (flags.demo && (flags.yes !== undefined || flags.y !== undefined || flags.agent !== undefined)) {
    throw new Error("--demo is an offline reference preview — it cannot be combined with --yes/--agent consent flags");
  }
  if (flags.demo) return;
  if (flags.yes !== undefined && flags.yes !== true) {
    throw new Error(`--yes is a boolean consent switch; it takes no value (found: ${JSON.stringify(flags.yes)})`);
  }
  if (flags.y !== undefined && flags.y !== true) {
    throw new Error("-y is a boolean consent switch; it takes no value");
  }
  if (flags["idempotency-key"] !== undefined) {
    const key = flags["idempotency-key"];
    if (typeof key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new Error("--idempotency-key must be an 8–128 character string of [A-Za-z0-9._-]");
    }
  }
  const [handle, amountArg, currencyArg] = args;
  if (typeof handle !== "string" || !HANDLE_PATTERN.test(handle)) {
    if (typeof handle === "string" && /^[0-9]/.test(handle)) {
      throw new Error(
        `Missing recipient handle (got '${handle}'). PowerShell strips unquoted '@' — quote handles: furlpay pay '@recipient' ${args.slice(1).join(" ")}`
      );
    }
    throw new Error(`Invalid recipient handle '${handle}' — expected @handle (2–30 characters)`);
  }
  if (amountArg === undefined) throw new Error("Missing amount: pay @handle <amount> <USD|USDC|EUR>");
  parseAmount(String(amountArg));
  if (currencyArg === undefined && flags.agent === true) {
    // A human may rely on the USD default; automation may not assume anything.
    throw new Error("--agent payments must state the currency explicitly: pay @handle <amount> <USD|USDC|EUR>");
  }
  if (currencyArg !== undefined && !CURRENCIES.has(String(currencyArg).toUpperCase())) {
    throw new Error(`Unsupported currency '${currencyArg}' — expected USD, USDC or EUR`);
  }
}

/** Absolute expiry (epoch ms) of a quote: signed deadline wins over expiresAt. */
function quoteExpiry(quote) {
  const signed = typeof quote.quoteId === "string" ? SIGNED_QUOTE_DEADLINE.exec(quote.quoteId) : null;
  if (signed) {
    const deadline = Number(signed[1]);
    const advertised = Date.parse(quote.expiresAt);
    // A signed quote's own deadline always applies; expiresAt may only narrow it.
    return Number.isFinite(advertised) ? Math.min(deadline, advertised) : deadline;
  }
  return Date.parse(quote.expiresAt);
}

/**
 * Bind a fetched quote to the payment intent before anything is signed or
 * sent. The quote is the ONLY authority on recipient, amount, currency,
 * funding account and compliance state — if any of it deviates from what the
 * user asked for, the payment refuses rather than "best effort" correcting.
 */
function validateQuote(quote, input, now = Date.now(), env) {
  if (!quote || typeof quote !== "object") throw new Error("Quote response is not an object");
  if (quote.isFixture) throw new Error("Quote is sandbox fixture data — fixtures are never executable");
  const amount = quote.amount || {};
  if (amount.decimal !== input.amount) {
    throw new Error(`Quote amount ${amount.decimal} does not match the requested ${input.amount}`);
  }
  if (amount.currency !== input.currency) {
    throw new Error(`Quote currency ${amount.currency} does not match the requested ${input.currency}`);
  }
  if (typeof amount.fee !== "number" || !Number.isFinite(amount.fee) || amount.fee < 0) {
    throw new Error("Quote fee is missing, non-finite or negative");
  }
  const recipient = quote.recipient || {};
  if (recipient.handle !== input.recipient) {
    throw new Error(`Quote recipient ${recipient.handle} does not match the requested ${input.recipient}`);
  }
  if (recipient.kybStatus !== "verified") {
    throw new Error(`Recipient KYB status '${recipient.kybStatus}' is not verified — refusing to send`);
  }
  if (recipient.kybExpiresAt !== undefined) {
    const kybExpiry = Date.parse(recipient.kybExpiresAt);
    if (!Number.isFinite(kybExpiry)) throw new Error("Recipient KYB expiry is not a valid date");
    if (kybExpiry <= now) throw new Error("Recipient KYB verification has expired");
  }
  if (recipient.sanctionsStatus !== "clear") {
    throw new Error(`Recipient sanctions status '${recipient.sanctionsStatus}' is not clear — refusing to send`);
  }
  const source = quote.sourceAccount || {};
  if (source.isAuthoritative !== true) {
    throw new Error("Quote source account is not authoritative — the server did not confirm the funding account");
  }
  if (typeof source.balanceUsd === "number" && source.balanceUsd < input.amount) {
    throw new Error(`Source balance $${source.balanceUsd} is below the payment amount $${input.amount}`);
  }
  const settlement = quote.settlement || {};
  if (
    !Array.isArray(settlement.supportedChains) ||
    settlement.supportedChains.length === 0 ||
    !settlement.supportedChains.every((chain) => typeof chain === "string")
  ) {
    throw new Error("Quote settlement.supportedChains is missing or malformed");
  }
  if (env === "live" && settlement.mode !== "live") {
    throw new Error(`Refusing '${settlement.mode}'-mode quote in the live environment`);
  }
  const expiry = quoteExpiry(quote);
  if (!Number.isFinite(expiry)) throw new Error("Quote expiry is missing or not a valid date");
  if (expiry <= now) throw new Error(`Quote expired at ${new Date(expiry).toISOString()}`);
  return true;
}

/**
 * Whitelist receipt builder. Only a provably completed settlement (status,
 * transferId, ledgerTxId, settledAt all present and well-formed) becomes a
 * receipt — and only the whitelisted fields are copied, so secrets riding on
 * the response object (totpSecret, session, …) can never reach output.
 */
const RECEIPT_FIELDS = ["status", "transferId", "ledgerTxId", "settledAt", "amount", "currency", "fee", "rail"];

function receipt(response) {
  if (!response || typeof response !== "object") throw new Error("No payment response to build a receipt from");
  if (response.status !== "completed") {
    throw new Error(`Refusing to print a receipt for non-completed status '${response.status}'`);
  }
  for (const field of ["transferId", "ledgerTxId", "settledAt"]) {
    if (typeof response[field] !== "string" || !response[field]) {
      throw new Error(`Completed payment is missing ${field} — refusing to fabricate a receipt`);
    }
  }
  if (!Number.isFinite(Date.parse(response.settledAt))) {
    throw new Error("settledAt is not a valid date — refusing to fabricate a receipt");
  }
  const safe = {};
  for (const field of RECEIPT_FIELDS) {
    if (response[field] !== undefined) safe[field] = response[field];
  }
  return safe;
}

/**
 * Single-keypress consent over a supplied input stream (testable; defaults to
 * stdin). Multi-character pastes are ignored entirely — consent must be a
 * deliberate keystroke, not a pasted script. EOF and expiry resolve to
 * "not confirmed". Always restores raw mode and removes its listeners.
 */
function confirmPayment({ input = process.stdin, expiresAt = Date.now() + 60_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      try {
        if (typeof input.setRawMode === "function") input.setRawMode(false);
      } catch { /* stream already destroyed */ }
      try { input.pause(); } catch { /* ditto */ }
      resolve(value);
    };
    const onData = (chunk) => {
      const key = String(chunk);
      if (key.length !== 1) return; // pasted input is never consent
      if (key === "y" || key === "Y") finish(true);
      else if (key === "n" || key === "N" || key === "\r" || key === "\n" || key === "\x1b" || key === "\x03") finish(false);
    };
    const onEnd = () => finish(false);
    const timer = setTimeout(() => finish(false), Math.max(0, expiresAt - Date.now()));
    if (expiresAt <= Date.now()) {
      finish(false);
      return;
    }
    try {
      if (typeof input.setRawMode === "function") input.setRawMode(true);
    } catch { /* not a TTY-capable stream */ }
    try { input.resume(); } catch { /* ditto */ }
    input.on("data", onData);
    input.on("end", onEnd);
  });
}

// ---------------------------------------------------------------------------
// `furlpay pay @handle <amount> <currency>` — the A2A execution flow.
//
// Dependency-injectable (call/now/reservePayment/write/diagnostic/confirm)
// so the payment suite can drive the REAL flow against a stub transport.
// Invariants the flow enforces, in order:
//   1. validateInput before anything else (no shifted-argument payments).
//   2. Headless execution without explicit consent refuses BEFORE any
//      network call ("confirmation_required", zero requests).
//   3. The server quote is bound to the intent (validateQuote) and re-checked
//      for expiry AFTER confirmation — a quote that lapses mid-confirm
//      cannot be sent.
//   4. Execute carries a stable idempotency key (header + body) so an
//      unknown outcome is reconcilable — and is NEVER auto-retried with a
//      fresh key: a retry that mints a new key can double-pay.
//   5. Only receipt() can describe a settlement. Pending, approvals,
//      malformed bodies and transport faults are unknown/failed — never
//      dressed up as success.
// ---------------------------------------------------------------------------

function termColumns(flags) {
  const requested = Number(flags.width);
  if (Number.isInteger(requested) && requested >= 20 && requested <= 500) return requested;
  return Math.max(40, Math.min(180, process.stdout.columns || 80));
}

function consoleCall(flags) {
  return async (method, path, { body, headers } = {}) => {
    const res = await api.rawRequest(method, path, { flags, body, headers });
    if (res.status >= 200 && res.status < 300) return res.body;
    const detail = res.body && typeof res.body === "object" && (res.body.detail || res.body.message || res.body.error);
    const err = new Error(String(detail || `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  };
}

function writeJson(write, payload) {
  write(JSON.stringify(payload, null, 2) + "\n");
}

/**
 * Classify a transport/API fault. Recognized request rejections (4xx) are
 * FAILED — the payment did not happen. Everything else (5xx, sockets,
 * timeouts) is UNKNOWN: the request may have settled server-side, so the
 * idempotency key is surfaced for reconciliation, never re-spent.
 */
function classifyFailure(err, { json, write, idempotencyKey }) {
  const status = Number.isInteger(err && err.status) ? err.status : undefined;
  process.exitCode = 1;
  if (status >= 400 && status < 500) {
    const result = { ok: false, status: "failed", httpStatus: status, error: err.message };
    if (json) writeJson(write, result);
    else write(`Payment failed (HTTP ${status}): ${err.message}\n`);
    return result;
  }
  const result = {
    ok: false,
    status: "unknown",
    httpStatus: status,
    idempotencyKey,
    message:
      `Payment outcome could not be confirmed: ${err.message}. ` +
      `Reconcile with the payment provider using idempotency key ${idempotencyKey} ` +
      `before attempting another payment — a retry with a NEW key could double-pay.`,
  };
  if (json) writeJson(write, result);
  else write(result.message + "\n");
  return result;
}

async function executeA2APay(args, flags = {}, deps = {}) {
  const write = deps.write || ((text) => process.stdout.write(String(text)));
  const diagnostic = deps.diagnostic || (() => {});
  const now = deps.now || (() => Date.now());
  const json = Boolean(flags.json || flags.agent);

  // 1. Demo mode is an offline reference preview: zero API calls, zero
  // execution. Its consent-flag contradictions still refuse loudly.
  if (flags.demo) {
    if (flags.yes !== undefined || flags.y !== undefined || flags.agent !== undefined) {
      throw new Error("--demo is an offline reference preview — it cannot be combined with --yes/--agent consent flags");
    }
    const view = renderPayment(demoQuote(), { demo: true, columns: termColumns(flags), colorLevel: colorLevel() });
    write(view + "\n");
    return { ok: true, status: "preview", demo: true };
  }

  // 2. Headless without explicit consent refuses BEFORE any network call —
  // and before argument pedantry: consent is the first-mover question.
  if (!flags["dry-run"] && flags.yes !== true && flags.y !== true && flags.agent !== true && !deps.confirm && process.stdin.isTTY !== true) {
    process.exitCode = 1;
    const result = {
      ok: false,
      error: "confirmation_required",
      detail: "Non-interactive terminal: pass --yes (explicit consent) or --agent, or run the command interactively.",
    };
    if (json) writeJson(write, result);
    else write(result.detail + "\n");
    return result;
  }

  // 3. Argument contract.
  validateInput(args, flags);

  const input = {
    recipient: String(args[0]).toLowerCase(),
    amount: parseAmount(String(args[1])).decimal,
    currency: String(args[2] || "USD").toUpperCase(),
  };

  // Idempotency: caller-supplied (validated) or freshly reserved — stable
  // for the lifetime of this payment across every retry of the SAME intent.
  const idempotencyKey = flags["idempotency-key"] || (deps.reservePayment ? deps.reservePayment() : crypto.randomUUID());
  const call = deps.call || consoleCall(flags);

  // 3. Quote: fetch and bind to the intent.
  let quote;
  try {
    quote = await call("POST", "/api/v1/pay/quote", {
      body: {
        recipient: input.recipient,
        amount: input.amount,
        currency: input.currency,
        dryRun: Boolean(flags["dry-run"]),
      },
    });
    validateQuote(quote, input, now());
  } catch (err) {
    diagnostic(`quote stage: ${err.message}`);
    return classifyFailure(err, { json, write, idempotencyKey });
  }

  // 4. Dry-run stops at the bound quote — never executes, never confirms.
  if (flags["dry-run"]) {
    const result = {
      ok: true,
      status: "quoted",
      dryRun: true,
      quoteId: quote.quoteId,
      amount: input.amount,
      currency: input.currency,
      fee: quote.amount.fee,
      recipient: {
        handle: quote.recipient.handle,
        kybStatus: quote.recipient.kybStatus,
        sanctionsStatus: quote.recipient.sanctionsStatus,
      },
      expiresAt: quote.expiresAt,
    };
    if (json) writeJson(write, result);
    else write(renderPayment(quote, { columns: termColumns(flags), colorLevel: colorLevel() }) + "\n");
    return result;
  }

  // 5. Consent — interactive single keypress, injected confirmer, or the
  // explicit --yes/--agent switches.
  let confirmed;
  if (deps.confirm) {
    confirmed = await deps.confirm({ quote, expiresAt: quoteExpiry(quote) });
  } else if (flags.yes === true || flags.y === true || flags.agent === true) {
    confirmed = true;
  } else {
    write(renderPayment(quote, { columns: termColumns(flags), colorLevel: colorLevel() }) + "\n");
    write("Confirm and send this payment? Press y to send, any other key to cancel. ");
    confirmed = await confirmPayment({ input: process.stdin, expiresAt: quoteExpiry(quote) });
  }
  if (!confirmed) {
    const result = { ok: false, status: "cancelled", quoteId: quote.quoteId };
    if (json) writeJson(write, result);
    else write("\nPayment cancelled — nothing was sent.\n");
    return result;
  }

  // 6. The quote must STILL be alive after confirmation.
  if (quoteExpiry(quote) <= now()) {
    process.exitCode = 1;
    const result = { ok: false, status: "expired", error: "quote_expired", quoteId: quote.quoteId };
    if (json) writeJson(write, result);
    else write("The quote expired during confirmation — nothing was sent. Request a new quote.\n");
    return result;
  }

  // 7. Execute with the stable idempotency key (header AND body).
  let response;
  try {
    response = await call("POST", "/api/v1/pay/execute", {
      headers: { "Idempotency-Key": idempotencyKey },
      body: {
        quoteId: quote.quoteId,
        sourceFinancialAccount: quote.sourceAccount.id,
        recipient: input.recipient,
        amount: input.amount,
        currency: input.currency,
        idempotencyKey,
        memo: flags.memo,
      },
    });
  } catch (err) {
    diagnostic(`execute stage: ${err.message}`);
    return classifyFailure(err, { json, write, idempotencyKey });
  }

  // 8a. Async states are reported as exactly what they are.
  if (response && (response.status === "pending" || response.status === "requires_approval")) {
    const result = {
      ok: true,
      status: response.status,
      quoteId: quote.quoteId,
      idempotencyKey,
      transferId: response.transferId,
      approvalId: response.approvalId,
      approvalUrl: response.approvalUrl,
      requiresHumanApproval: response.status === "requires_approval",
    };
    if (json) writeJson(write, result);
    else write(`Payment ${response.status} — monitor the dashboard for the final state.\n`);
    return result;
  }

  // 8b. Only a provable settlement prints as one; anything else is UNKNOWN.
  try {
    if (!response || typeof response !== "object") throw new Error("execute response is not an object");
    if (response.amount !== undefined && response.amount !== input.amount) {
      throw new Error(`settled amount ${response.amount} does not match the requested ${input.amount}`);
    }
    const settled = receipt(response);
    const result = { ok: true, ...settled, idempotencyKey };
    if (json) {
      writeJson(write, result);
    } else {
      write(
        `Payment settled: ${settled.transferId} ` +
          `(ledger ${settled.ledgerTxId}, settledAt ${settled.settledAt}, ` +
          `idempotency key ${idempotencyKey})\n`
      );
    }
    return result;
  } catch (err) {
    process.exitCode = 1;
    const result = {
      ok: false,
      status: "unknown",
      idempotencyKey,
      message:
        `Payment outcome could not be confirmed: ${err.message}. ` +
        `Reconcile with the payment provider using idempotency key ${idempotencyKey} ` +
        `before attempting another payment — a retry with a NEW key could double-pay.`,
    };
    if (json) writeJson(write, result);
    else write(result.message + "\n");
    return result;
  }
}

module.exports = {
  executeA2APay,
  parseAmount,
  validateInput,
  validateQuote,
  quoteExpiry,
  receipt,
  confirmPayment,
  resolveRecipientProfile,
  fetchPayQuote,
  sanitizeTerminalText,
  waitForKeypress,
  theme,
  SANDBOX_FIXTURES,
  drawBox,
  drawTitledBox
};

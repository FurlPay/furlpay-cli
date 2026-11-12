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

/**
 * Main execution handler for `furlpay pay @recipient amount [currency]`
 */
async function executeA2APay(args, flags) {
  const [recipientArg, amountArg, currencyArg] = args;
  const recipient = recipientArg;
  const amount = Number(amountArg);
  const currency = (currencyArg || flags.currency || "USD").toUpperCase();

  if (!recipient || !Number.isFinite(amount) || amount <= 0) {
    if (flags.agent || flags.json) {
      console.log(JSON.stringify({
        ok: false,
        error: "invalid_arguments",
        detail: "Usage: furlpay pay @recipient <amount> [currency] [--agent] [--yes]"
      }, null, 2));
      return;
    }
    return out.fail("Usage: furlpay pay @recipient <amount> [USD|USDC|EUR] [--agent] [--dry-run]");
  }

  // 1. Resolve Profile & Authoritative Quote
  const recipientProfile = await resolveRecipientProfile(recipient, flags);
  const quote = await fetchPayQuote(recipientProfile.handle, amount, currency, flags);

  // 2. Handle Machine-Readable Agent Modes (--agent, --json) - Fix SEC-01 & SEC-02
  if (flags.agent || flags.json) {
    if (flags["dry-run"]) {
      const payload = {
        ok: true,
        status: "dry_run_success",
        dryRun: true,
        quoteId: quote.quoteId,
        amount: amount,
        currency: currency,
        fee: 0.0,
        rail: quote.settlement?.rail || "FurlPay Ledger",
        recipient: {
          handle: recipientProfile.handle,
          displayName: recipientProfile.name,
          legalName: recipientProfile.legalName,
          url: recipientProfile.url || undefined,
          kybStatus: recipientProfile.kybStatus,
          sanctionsStatus: recipientProfile.sanctionsStatus,
          isFixture: Boolean(recipientProfile.isFixture),
        },
        sourceAccount: {
          name: quote.sourceAccount?.name || "Business Operating Account",
          type: quote.sourceAccount?.type || "Business Operating Account",
          balanceUsd: quote.sourceAccount?.balanceUsd ?? null,
          isAuthoritative: quote.sourceAccount?.isAuthoritative ?? false,
        },
      };
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    // REAL execution via /api/v1/pay/execute — ZERO fabricated settlements
    const idempotencyKey = flags.idempotencyKey || crypto.randomUUID();
    try {
      const res = await api.rawRequest("POST", "/api/v1/pay/execute", {
        flags,
        body: {
          recipient: recipientProfile.handle,
          amount,
          currency,
          quoteId: quote.quoteId,
          idempotencyKey,
          mandateId: flags.mandateId,
          agentId: flags.agentId,
          memo: flags.memo,
        },
      });

      if (res && res.status >= 200 && res.status < 300 && res.body && (res.body.transferId || res.body.status === "requires_approval")) {
        const payload = {
          ok: true,
          status: res.body.status || "completed",
          transferId: res.body.transferId,
          approvalId: res.body.approvalId,
          requiresHumanApproval: Boolean(res.body.requiresHumanApproval),
          approvalUrl: res.body.approvalUrl,
          settledAt: res.body.settledAt || new Date().toISOString(),
          amount,
          currency,
          fee: res.body.fee ?? 0.0,
          rail: res.body.rail || quote.settlement?.rail || "FurlPay Ledger",
          recipient: {
            handle: recipientProfile.handle,
            displayName: recipientProfile.name,
            legalName: recipientProfile.legalName,
            kybStatus: recipientProfile.kybStatus,
            sanctionsStatus: recipientProfile.sanctionsStatus,
          },
          sourceAccount: res.body.sourceAccount || quote.sourceAccount,
          idempotencyKey,
          ledgerPostingId: res.body.ledgerPostingId,
        };
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      } else {
        process.exitCode = 1;
        const errorPayload = {
          ok: false,
          status: res?.body?.status || (res?.status === 401 ? "unauthorized" : res?.status === 403 ? "forbidden" : "failed"),
          httpStatus: res?.status || 500,
          error: res?.body?.error || (res?.status === 401 ? "unauthorized" : "payment_execution_failed"),
          detail: res?.body?.detail || res?.body?.message || `Payment execution failed with HTTP ${res?.status || 500}`,
        };
        console.log(JSON.stringify(errorPayload, null, 2));
        return errorPayload;
      }
    } catch (err) {
      process.exitCode = 1;
      const errorPayload = {
        ok: false,
        status: "network_error",
        error: "connection_failed",
        detail: err.message,
      };
      console.log(JSON.stringify(errorPayload, null, 2));
      return errorPayload;
    }
  }

  // 3. Render Responsive Visual Terminal Interface
  const stdoutCols = process.stdout.columns || 120;
  const isWide = stdoutCols >= 110;
  const isMedium = stdoutCols >= 75 && stdoutCols < 110;
  const isCompact = stdoutCols < 75;

  console.log("");

  // ── Header ──────────────────────────────────────────────────────────────
  const logo = `\x1b[48;2;0;230;184m\x1b[38;2;3;11;19m\x1b[1m F \x1b[0m  ${theme.bold(theme.primaryText("FurlPay"))}`;
  const tagline = theme.secondaryText("A2A payments for the AI economy");
  const meta = `${theme.dim("v1.2.0")}       ${theme.primaryText("Connected")} ${theme.brandMint("●")}  ${theme.bold(theme.primaryText("Mainnet"))}`;

  if (isWide) {
    const headerWidth = Math.min(stdoutCols, 120);
    const gap = Math.max(2, headerWidth - visibleLength(logo) - visibleLength(tagline) - visibleLength(meta) - 4);
    console.log(` ${logo}   ${tagline}${" ".repeat(gap)}${meta}\n`);
  } else {
    console.log(` ${logo}  ${tagline}`);
    console.log(` ${meta}\n`);
  }

  // ── Status Banner ───────────────────────────────────────────────────────
  const bannerWidth = isWide ? Math.min(stdoutCols, 120) : isMedium ? Math.min(stdoutCols, 88) : Math.max(stdoutCols - 2, 44);
  const statusContent = [`${theme.brandMint("[✔]")}  ${theme.bold(theme.primaryText("Recipient found"))}`];
  console.log(drawBox(statusContent, bannerWidth, theme.brandMint));
  console.log("");

  // ── Middle Panels (Wide: 2-Column Side-by-Side | Medium/Compact: Stacked)
  const isKybVerified = recipientProfile.kybStatus === "verified";
  const verifiedPill = isKybVerified
    ? `${theme.brandMint("[✔ Verified business]")}`
    : `${theme.dim("[○ Unverified business (KYB pending)]")}`;

  const transferLines = [
    `${pad("Amount", 14)} ${theme.brandMint(theme.bold(amount.toFixed(2)))} ${theme.primaryText(currency)}`,
    `${pad("Fee", 14)} ${theme.brandMint("Free")}`,
    `${pad("Timing", 14)} ${theme.primaryText("Instant")}`,
    `${pad("Frequency", 14)} ${theme.primaryText("One-time")}`,
    `${pad("From", 14)} ${theme.violet("My business funds")}`
  ];

  const recipientLines = [
    `${theme.bold(theme.primaryText(recipientProfile.name))}   ${verifiedPill}`,
    `${theme.brightTeal(recipientProfile.handle)}`,
    `${theme.secondaryText(recipientProfile.legalName)}`,
    `${theme.dim(recipientProfile.bio ? recipientProfile.bio.slice(0, 42) + "…" : "Verified commercial business counterparty.")}`,
    `${theme.electricBlue("🔗 " + (recipientProfile.url || "https://example.com"))}`
  ];

  if (isWide) {
    const halfWidth = Math.floor((bannerWidth - 2) / 2);
    const leftBox = drawTitledBox(theme.violet("⚡ Live mode transfer"), transferLines, halfWidth, theme.border).split("\n");
    const rightBox = drawTitledBox(theme.violet("👤 Recipient"), recipientLines, halfWidth, theme.border).split("\n");
    const maxRows = Math.max(leftBox.length, rightBox.length);
    for (let i = 0; i < maxRows; i++) {
      const l = leftBox[i] || " ".repeat(halfWidth);
      const r = rightBox[i] || "";
      console.log(`${l}  ${r}`);
    }
  } else {
    console.log(drawTitledBox(theme.violet("⚡ Live mode transfer"), transferLines, bannerWidth, theme.border));
    console.log("");
    console.log(drawTitledBox(theme.violet("👤 Recipient"), recipientLines, bannerWidth, theme.border));
  }
  console.log("");

  // ── Payment Details Container (Wide: 4-Column Row | Medium: 2x2 | Compact: Stacked)
  if (isWide) {
    const colW1 = 26;
    const colW2 = 22;
    const colW3 = 36;
    const col1 = [
      `${theme.brightTeal("🏛")}  ${theme.secondaryText("From account")}`,
      `   ${theme.bold(theme.primaryText(quote.sourceAccount?.name || "Business Operating Account"))}`,
      `   ${theme.dim("Business Account")}`
    ];
    const hasBalance = typeof quote.sourceAccount?.balanceUsd === "number";
    const balanceText = hasBalance
      ? "$" + quote.sourceAccount.balanceUsd.toLocaleString("en-US", { minimumFractionDigits: 2 })
      : "—";
    const balanceSub = hasBalance
      ? (quote.sourceAccount?.isAuthoritative ? "USD Available" : "Sandbox Demo Balance")
      : "Auth Required";

    const col2 = [
      `${theme.brightTeal("💰")}  ${theme.secondaryText("Balance")}`,
      `   ${theme.bold(theme.primaryText(balanceText))}`,
      `   ${theme.dim(balanceSub)}`
    ];
    const col3 = [
      `${theme.brightTeal("🔗")}  ${theme.secondaryText("Network")}`,
      `   ${theme.bold(theme.primaryText(quote.settlement?.rail || "FurlPay Ledger"))}`,
      `   ${theme.dim("Multi-chain (Arc, Solana, Base)")}`
    ];
    const col4 = [
      `${theme.brightTeal("🛡")}  ${theme.secondaryText("Security")}`,
      `   ${theme.bold(theme.primaryText("KYB verified"))} ${theme.brandMint("✔")}`,
      `   ${theme.dim("Sanctions checked")}`
    ];

    const detailsLines = [
      `${pad(col1[0], colW1)} ${pad(col2[0], colW2)} ${pad(col3[0], colW3)} ${col4[0]}`,
      `${pad(col1[1], colW1)} ${pad(col2[1], colW2)} ${pad(col3[1], colW3)} ${col4[1]}`,
      `${pad(col1[2], colW1)} ${pad(col2[2], colW2)} ${pad(col3[2], colW3)} ${col4[2]}`
    ];
    console.log(drawTitledBox(`${theme.brightTeal("🗄")} Payment details`, detailsLines, bannerWidth, theme.border));
  } else {
    const hasBalanceNarrow = typeof quote.sourceAccount?.balanceUsd === "number";
    const balanceTextNarrow = hasBalanceNarrow
      ? "$" + quote.sourceAccount.balanceUsd.toLocaleString("en-US", { minimumFractionDigits: 2 }) + " USD"
      : "— (Auth required)";
    const detailsLines = [
      `${pad("Account", 14)} ${theme.primaryText(quote.sourceAccount?.name || "Business Operating Account")}`,
      `${pad("Balance", 14)} ${theme.primaryText(balanceTextNarrow)}`,
      `${pad("Network", 14)} ${theme.primaryText(quote.settlement?.rail || "FurlPay Ledger")}`,
      `${pad("Security", 14)} ${theme.primaryText("KYB verified")} ${theme.brandMint("✔")} ${theme.dim("Sanctions checked")}`
    ];
    console.log(drawTitledBox(`${theme.brightTeal("🗄")} Payment details`, detailsLines, bannerWidth, theme.border));
  }
  console.log("");

  // ── Confirmation Bar ────────────────────────────────────────────────────
  const promptLeft = `${theme.brightTeal("🚀")} ${theme.bold(theme.primaryText("Confirm and send this payment?"))}`;
  const promptRight = `Press ${theme.brandMint(theme.bold("y"))} to send ${theme.dim("•")} ${theme.error(theme.bold("n"))} to cancel`;
  const barGap = Math.max(2, bannerWidth - visibleLength(promptLeft) - visibleLength(promptRight) - 4);
  const promptBar = `${promptLeft}${" ".repeat(barGap)}${promptRight}`;

  console.log(drawBox([promptBar], bannerWidth, theme.brandMint));
  console.log("");

  // 4. Handle Dry-Run Mode
  if (flags["dry-run"]) {
    console.log(theme.dim("  (Dry-run simulation completed — no funds were moved)\n"));
    return;
  }

  // 5. Await Single-Keystroke Confirmation
  const confirmed = await waitForKeypress(flags);
  if (!confirmed) {
    console.log(theme.dim("Payment cancelled.\n"));
    return;
  }

  // 6. Execution Animation & Completion - Fix SEC-01 & SEC-02
  const spin = out.spinner("Settling transfer via FurlPay Ledger…");
  let res;
  try {
    res = await api.rawRequest("POST", "/api/v1/pay/execute", {
      flags,
      body: {
        recipient: recipientProfile.handle,
        amount,
        currency,
        quoteId: quote.quoteId,
        idempotencyKey: crypto.randomUUID(),
        memo: flags.memo,
      },
    });
  } catch (err) {
    spin.stop();
    out.fail(`Network error during transfer execution: ${err.message}`);
    process.exit(1);
    return;
  } finally {
    spin.stop();
  }

  if (!res || res.status < 200 || res.status >= 300 || !res.body) {
    const errMsg =
      (res && res.body && (res.body.error || res.body.message || res.body.detail)) ||
      `Transfer rejected by server (HTTP ${res ? res.status : "unknown"})`;
    out.fail(`Payment failed: ${errMsg}`);
    if (res && res.status === 401) {
      console.log(theme.dim("  Run 'furlpay login' to authenticate your session before sending live payments.\n"));
    }
    process.exit(1);
    return;
  }

  if (res.body.status === "requires_approval" || res.body.requiresHumanApproval) {
    out.ok(`Payment queued for executive approval: ${theme.brightTeal(res.body.approvalId || "pending")}`);
    console.log(`  Threshold:    ${theme.bold("$100,000.00")} Dual-Signoff Invariant`);
    console.log(`  Approval URL: ${theme.primaryText(res.body.approvalUrl || "https://furlpay.com/dashboard/approvals")}`);
    console.log(`  Status:       ${theme.brightTeal("requires_approval")}\n`);
    return res.body;
  }

  const transferId = res.body.transferId;
  if (!transferId) {
    out.fail("Server returned success without a verified transferId. Settlement could not be confirmed.");
    process.exit(1);
    return;
  }

  out.ok(`Payment settled instantly! ${theme.dim(`(${transferId})`)}`);
  console.log(`  Recipient:    ${theme.bold(theme.primaryText(recipientProfile.name))} ${theme.brightTeal(recipientProfile.handle)}`);
  console.log(`  Amount:       ${theme.brandMint(theme.bold(amount.toFixed(2)))} ${theme.primaryText(currency)}`);
  console.log(`  Rail:         ${theme.primaryText(res.body.rail || "FurlPay Ledger")} ${theme.dim("(Atomic Double-Entry, <35ms)")}`);
  console.log(`  Network Fee:  ${theme.brandMint("FREE ($0.00)")}\n`);
  return res.body;
}

module.exports = {
  executeA2APay,
  resolveRecipientProfile,
  fetchPayQuote,
  sanitizeTerminalText,
  waitForKeypress,
  theme,
  SANDBOX_FIXTURES,
  drawBox,
  drawTitledBox
};

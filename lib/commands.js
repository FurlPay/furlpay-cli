"use strict";
// All non-TUI command implementations. Each command wires to a real
// apps/web API route — request shapes are documented next to each call.

const crypto = require("crypto");
const { c, loadConfig, saveConfig, prompt, confirm } = require("./util");
const api = require("./api");
const out = require("./output");

// ---------------------------------------------------------------------------
// Auth & config
// ---------------------------------------------------------------------------

// `furlpay login` — email OTP → session cookie (same flow as the web app).
// `furlpay login --key sk_...` — store an API/webhook key (dev tooling only).
async function login(args, flags) {
  if (flags.key) {
    const cfg = loadConfig();
    saveConfig({ ...cfg, key: flags.key, secret: flags.secret || flags.key });
    out.ok("Credentials saved to ~/.furlpay/config.json");
    return;
  }

  const email = flags.email || (await prompt("Email: "));
  if (!email.includes("@")) return out.fail("Enter a valid email address.");

  // --code means a code was already issued (e.g. a prior start call) — sending
  // a new one would invalidate it.
  if (!flags.code) {
    const spin = out.spinner("Sending one-time code…");
    let start;
    try {
      // POST /api/auth/otp/start { to, channel } — devCode present in mock mode.
      start = await api.call("POST", "/api/auth/otp/start", { flags, body: { to: email, channel: "email" } });
    } finally {
      spin.stop();
    }
    if (start.devCode) console.log(c.dim(`  (sandbox mock mode — your code is ${start.devCode})`));
    else out.ok(`Code sent to ${email}`);
  }

  const code = flags.code || (await prompt("Enter code: "));
  // POST /api/auth/otp/check mints the furlpay_session cookie on success.
  const res = await api.rawRequest("POST", "/api/auth/otp/check", {
    flags,
    body: { to: email, code, channel: "email", login: true },
  });
  if (res.status !== 200 || !res.body.verified) {
    return out.fail((res.body && res.body.error) || "Verification failed.");
  }
  const session = api.extractSession(res.headers["set-cookie"]);
  if (!session) return out.fail("Server did not return a session cookie.");
  api.storeSession(flags, session);
  out.ok(`Logged in as ${c.cyan(email)} (${api.currentEnv(loadConfig(), flags)})`);
}

async function logout(args, flags) {
  try {
    await api.call("POST", "/api/auth/logout", { flags });
  } catch {
    /* revoking server-side is best-effort — always clear locally */
  }
  api.clearSession(flags);
  out.ok("Logged out — local session cleared.");
}

async function whoami(args, flags) {
  const profile = await api.call("GET", "/api/profile", { flags });
  if (out.renderObject(profile, flags)) return;
  const cfg = loadConfig();
  console.log(`${c.bold(profile.name)} ${c.dim(`<${profile.email || "no email"}>`)}`);
  console.log(`  Safe:   ${c.cyan(profile.safeAddress)}`);
  console.log(`  KYC:    ${profile.kycStatus}   Tier: ${profile.tier}   Region: ${profile.region}`);
  console.log(`  Env:    ${api.currentEnv(cfg, flags)} → ${api.apiBase(cfg, flags)}`);
}

async function config(args, flags) {
  const [action, key, ...valueParts] = args;
  const cfg = loadConfig();
  if (action === "get") {
    if (!key) return console.log(JSON.stringify({ ...cfg, sessions: cfg.sessions ? "(redacted)" : undefined }, null, 2));
    console.log(cfg[key] === undefined ? "" : String(cfg[key]));
    return;
  }
  if (action === "set") {
    if (!key || !valueParts.length) return out.fail("Usage: furlpay config set <key> <value>");
    saveConfig({ ...cfg, [key]: valueParts.join(" ") });
    out.ok(`${key} = ${valueParts.join(" ")}`);
    return;
  }
  out.fail("Usage: furlpay config <get|set> [key] [value]");
}

async function env(args, flags) {
  const cfg = loadConfig();
  const target = args[0];
  if (!target) {
    const cur = api.currentEnv(cfg, flags);
    console.log(`${c.bold(cur)} → ${api.apiBase(cfg, flags)}`);
    return;
  }
  if (target !== "sandbox" && target !== "live") return out.fail("Usage: furlpay env <sandbox|live>");
  saveConfig({ ...cfg, env: target });
  out.ok(`Environment switched to ${c.cyan(target)} (${api.apiBase({ ...cfg, env: target }, flags)})`);
}

async function status(args, flags) {
  const spin = out.spinner("Checking chain + API health…");
  let data;
  try {
    // Public — no session needed.
    data = await api.call("GET", "/api/chain/status", { flags });
  } finally {
    spin.stop();
  }
  if (out.renderObject(data, flags)) return;
  console.log(`${c.bold("FurlPay API")} ${c.green("● up")}   primary settlement: ${c.cyan(data.primarySettlement)}`);
  out.render(
    data.chains || [],
    [
      { key: "name", label: "Chain" },
      { key: "chainId", label: "Chain ID", align: "right" },
      { key: "healthy", label: "Status", format: (v) => (v ? c.green("healthy") : c.red("down")) },
      { key: "blockHeight", label: "Block", align: "right" },
      { key: "source", label: "Source", format: (v) => c.dim(String(v ?? "—")) },
    ],
    flags
  );
}

// ---------------------------------------------------------------------------
// Wallet & balance
// ---------------------------------------------------------------------------

async function balance(args, flags) {
  const data = await api.call("GET", "/api/wallets", { flags });
  let rows = data.balances || [];
  if (flags.chain) rows = rows.filter((b) => b.chain === flags.chain);
  const total = rows.reduce((s, b) => s + Number(b.usdValue || 0), 0);
  out.render(
    rows,
    [
      { key: "token", label: "Token" },
      { key: "amount", label: "Amount", align: "right" },
      { key: "chain", label: "Chain" },
      { key: "usdValue", label: "USD Value", align: "right", format: (v) => out.money(v) },
    ],
    flags,
    "usdValue"
  );
  if (!flags.quiet && (flags.output || "table") === "table") {
    console.log(c.bold(`  Total: ${out.money(total)}`));
  }
}

async function wallet(args, flags) {
  const [sub] = args;
  if (sub === "address") {
    const data = await api.call("GET", "/api/wallets", { flags });
    if (flags.quiet) return console.log(data.safeAddress);
    if (out.renderObject({ safeAddress: data.safeAddress, modules: data.modules }, flags)) return;
    console.log(`${c.bold("Safe smart account")}  ${c.cyan(data.safeAddress)}`);
    for (const m of data.modules || []) {
      console.log(`  ${m.enabled ? c.green("●") : c.dim("○")} ${m.name} ${c.dim(`(${m.type})`)}`);
    }
    return;
  }
  if (sub === "fund") {
    // GET /api/onramp/quote — public, publishable-key scoped on-ramp quote.
    const amount = Number(args[1] || flags.amount || 100);
    const data = await api.call("GET", `/api/onramp/quote?amountUsd=${amount}`, { flags });
    if (out.renderObject(data, flags)) return;
    console.log(`${c.bold("On-ramp quote")} for ${out.money(amount)}:`);
    console.log(JSON.stringify(data, null, 2));
    console.log(c.dim("Complete funding in the app or via `furlpay api POST /api/onramp/session`."));
    return;
  }
  if (sub === "export") {
    const data = await api.call("GET", "/api/wallets", { flags });
    // Non-custodial: there is no private key to export — the Safe is on-chain.
    console.log(JSON.stringify({ safeAddress: data.safeAddress, modules: data.modules, balances: data.balances }, null, 2));
    return;
  }
  out.fail("Usage: furlpay wallet <address|fund|export>");
}

// ---------------------------------------------------------------------------
// Payments & transfers
// ---------------------------------------------------------------------------

async function send(args, flags) {
  const [amountArg, destination] = args;
  const amount = Number(amountArg);
  if (!Number.isFinite(amount) || amount <= 0 || !destination) {
    return out.fail("Usage: furlpay send <amount> <destination> [--token USDC] [--chain arbitrum] [--mfa 123456]");
  }
  const token = flags.token || "USDC";
  const chain = flags.chain || "arbitrum";

  if (!(await confirm(`Send ${c.bold(out.money(amount))} ${token} on ${chain} to ${c.cyan(destination)}?`, flags))) {
    return console.log(c.dim("Cancelled."));
  }

  const profile = await api.call("GET", "/api/profile", { flags });
  const body = {
    safeAddress: profile.safeAddress,
    destination,
    amount,
    token,
    chain,
    // Demo signer: the API validates ECDSA shape (0x + 130 hex). A production
    // CLI signs the payload with the Safe owner key / passkey instead.
    signature: "0x" + crypto.randomBytes(65).toString("hex"),
    ...(flags.mfa ? { mfaCode: String(flags.mfa) } : {}),
  };

  const spin = out.spinner("Submitting gas-sponsored transfer…");
  let res;
  try {
    res = await api.call("POST", "/api/wallets/transfer", { flags, body });
  } catch (e) {
    spin.stop();
    if (e.body && e.body.stepUpRequired) {
      return out.fail(`${e.message} — re-run with --mfa <totp-code> (transfers ≥ $5000 require MFA).`);
    }
    throw e;
  }
  spin.stop();
  if (out.renderObject(res, flags)) return;
  out.ok(`Sent ${out.money(amount)} ${token} → ${destination}`);
  console.log(`  tx: ${c.cyan(res.transactionHash)}  ${c.dim(res.gasSponsored ? "gas sponsored" : "")}`);
}

async function swap(args, flags) {
  const [fromToken, toToken, amountArg] = args;
  const amountIn = Number(amountArg);
  if (!fromToken || !toToken || !Number.isFinite(amountIn) || amountIn <= 0) {
    return out.fail("Usage: furlpay swap <fromToken> <toToken> <amount> [--from-chain arbitrum] [--to-chain base]");
  }
  const body = {
    fromToken: fromToken.toUpperCase(),
    toToken: toToken.toUpperCase(),
    fromChain: flags["from-chain"] || flags.chain || "arbitrum",
    ...(flags["to-chain"] ? { toChain: flags["to-chain"] } : {}),
    amountIn,
  };

  // Quote first, execute only after confirmation (same POST with execute:true).
  const { quote } = await api.call("POST", "/api/swaps", { flags, body });
  console.log(
    `${c.bold("Quote:")} ${quote.amountIn} ${quote.fromToken} (${quote.fromChain}) → ` +
      `${c.green(String(quote.amountOut))} ${quote.toToken} (${quote.toChain}) ${c.dim(`via ${quote.route || "Li.Fi"}`)}`
  );
  if (flags["quote-only"]) return;
  if (!(await confirm("Execute swap?", flags))) return console.log(c.dim("Cancelled."));

  const res = await api.call("POST", "/api/swaps", { flags, body: { ...body, execute: true } });
  if (out.renderObject(res, flags)) return;
  out.ok(`Swapped ${res.quote.amountIn} ${res.quote.fromToken} → ${res.quote.amountOut} ${res.quote.toToken}`);
}

// bridge = cross-chain swap of the same token (CCTP-style route via /api/swaps).
async function bridge(args, flags) {
  const amount = Number(args[0]);
  const from = flags.from;
  const to = flags.to;
  if (!Number.isFinite(amount) || amount <= 0 || !from || !to) {
    return out.fail("Usage: furlpay bridge <amount> --from <chain> --to <chain> [--token USDC]");
  }
  const token = (flags.token || "USDC").toUpperCase();
  return swap([token, token, String(amount)], { ...flags, "from-chain": from, "to-chain": to });
}

async function pay(args, flags) {
  const [orderId] = args;
  if (!orderId) return out.fail("Usage: furlpay pay <order-id>");
  const res = await api.call("POST", `/api/actions/pay/${orderId}`, { flags, body: {} });
  if (out.renderObject(res, flags)) return;
  out.ok(`Paid order ${orderId}`);
  console.log(JSON.stringify(res, null, 2));
}

async function tx(args, flags) {
  const [sub] = args;
  if (sub && sub !== "list") {
    // Anything that isn't "list" is a tx hash — public chain lookup.
    const data = await api.call("GET", `/api/chain/tx/${sub}`, { flags });
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const params = new URLSearchParams();
  if (flags.category) params.set("category", flags.category);
  if (flags["card-id"]) params.set("cardId", flags["card-id"]);
  const qs = params.toString();
  const data = await api.call("GET", `/api/transactions${qs ? "?" + qs : ""}`, { flags });
  const limit = Number(flags.limit) || 20;
  out.render(
    (data.transactions || []).slice(0, limit),
    [
      { key: "title", label: "Transaction" },
      { key: "category", label: "Category" },
      { key: "direction", label: "", format: (v) => (v === "in" ? c.green("←") : c.red("→")) },
      { key: "amountUsd", label: "Amount", align: "right", format: (v) => out.money(v) },
      { key: "token", label: "Token" },
      { key: "status", label: "Status", format: (v) => (v === "settled" ? c.green(String(v)) : c.yellow(String(v ?? "?"))) },
    ],
    flags,
    "amountUsd"
  );
}

// ---------------------------------------------------------------------------
// Investing & markets
// ---------------------------------------------------------------------------

async function invest(args, flags) {
  const [sub, ...restArgs] = args;

  if (sub === "buy" || sub === "sell") {
    const [symbol, amountArg] = restArgs;
    if (!symbol || !amountArg) return out.fail(`Usage: furlpay invest ${sub} <SYMBOL> <usd-amount> [--qty] [--type limit --limit-price N]`);
    const body = {
      symbol: symbol.toUpperCase(),
      side: sub,
      // Default = notional USD (fractional). --qty switches to share count.
      ...(flags.qty ? { qty: Number(amountArg) } : { notional: Number(amountArg) }),
      ...(flags.type ? { type: flags.type } : {}),
      ...(flags["limit-price"] ? { limit_price: Number(flags["limit-price"]) } : {}),
      ...(flags["stop-price"] ? { stop_price: Number(flags["stop-price"]) } : {}),
      ...(flags.tif ? { time_in_force: flags.tif } : {}),
    };
    const what = flags.qty ? `${amountArg} shares of` : `${out.money(amountArg)} of`;
    if (!(await confirm(`${sub === "buy" ? "Buy" : "Sell"} ${what} ${c.bold(symbol.toUpperCase())}?`, flags))) {
      return console.log(c.dim("Cancelled."));
    }
    const res = await api.call("POST", "/api/investing/order", { flags, body });
    if (out.renderObject(res, flags)) return;
    out.ok(`Order ${res.orderId} ${res.status} — ${res.side} ${res.symbol}` + (res.filledQty ? ` (${res.filledQty.toFixed(4)} sh)` : ""));
    return;
  }

  if (sub === "portfolio" || sub === undefined) {
    const data = await api.call("GET", "/api/investing/portfolio", { flags });
    out.render(
      data.holdings || [],
      [
        { key: "symbol", label: "Symbol" },
        { key: "name", label: "Name" },
        { key: "shares", label: "Shares", align: "right", format: (v) => Number(v).toFixed(3) },
        { key: "price", label: "Price", align: "right", format: (v) => out.money(v) },
        { key: "changePct", label: "Today", align: "right", format: (v) => out.pct(v) },
        { key: "marketValue", label: "Value", align: "right", format: (v) => out.money(v) },
      ],
      flags,
      "marketValue"
    );
    const p = data.performance;
    if (p && !flags.quiet && (flags.output || "table") === "table") {
      console.log(
        `  ${c.bold(out.money(p.marketValue))}  today ${out.pct(p.dayChangePct)} (${out.money(p.dayChange)})` +
          `  total return ${out.pct(p.totalReturnPct)} (${out.money(p.totalReturn)})`
      );
    }
    return;
  }

  if (sub === "quote") {
    const symbol = (restArgs[0] || "").toUpperCase();
    if (!symbol) return out.fail("Usage: furlpay invest quote <SYMBOL>");
    const data = await api.call("GET", `/api/markets/${symbol}`, { flags });
    if (flags.quiet) return console.log(data.quote.price);
    if (out.renderObject(data, flags)) return;
    console.log(`${c.bold(data.asset.symbol)}  ${data.asset.name}  ${c.dim(`(${data.asset.kind}${data.asset.sector ? " · " + data.asset.sector : ""})`)}`);
    console.log(`  ${c.bold(out.money(data.quote.price))}  ${out.pct(data.quote.changePct)}  ${data.quote.live ? c.green("live") : c.dim("delayed")}`);
    if (data.position) console.log(`  position: ${data.position.shares.toFixed(3)} sh (${out.money(data.position.marketValue)})`);
    if (data.digest) console.log(c.dim("  " + String(data.digest).slice(0, 240)));
    return;
  }

  if (sub === "history") {
    return tx(["list"], { ...flags, category: "invest" });
  }

  if (sub === "dca") {
    const [action, symbol, amountArg] = restArgs;
    if (action === "create") {
      if (!symbol || !amountArg) return out.fail("Usage: furlpay invest dca create <SYMBOL> <usd> [--cadence day|week|month]");
      const res = await api.call("POST", "/api/investing/schedule", {
        flags,
        body: { symbol: symbol.toUpperCase(), side: "buy", notional: Number(amountArg), cadence: flags.cadence || "week" },
      });
      if (out.renderObject(res, flags)) return;
      out.ok(`DCA created: buy ${out.money(amountArg)} of ${symbol.toUpperCase()} every ${flags.cadence || "week"}`);
      return;
    }
    if (action === "cancel") {
      if (!symbol) return out.fail("Usage: furlpay invest dca cancel <schedule-id>");
      await api.call("DELETE", `/api/investing/schedule?id=${symbol}`, { flags });
      out.ok("Schedule cancelled.");
      return;
    }
    const data = await api.call("GET", "/api/investing/schedule", { flags });
    out.render(
      data.schedules || data || [],
      [
        { key: "id", label: "ID" },
        { key: "symbol", label: "Symbol" },
        { key: "notional", label: "Amount", align: "right", format: (v) => out.money(v) },
        { key: "cadence", label: "Cadence" },
        { key: "nextRun", label: "Next run" },
        { key: "active", label: "Active", format: (v) => (v ? c.green("yes") : c.dim("no")) },
      ],
      flags,
      "id"
    );
    return;
  }

  out.fail("Usage: furlpay invest <buy|sell|portfolio|quote|dca|history>");
}

async function market(args, flags) {
  const spin = out.spinner("Fetching market data…");
  let indices, movers;
  try {
    // Public endpoints — work logged-out.
    [indices, movers] = await Promise.all([
      api.call("GET", "/api/markets/indices", { flags }),
      api.call("GET", "/api/markets/movers?limit=5", { flags }),
    ]);
  } finally {
    spin.stop();
  }
  if (out.renderObject({ indices, movers }, flags)) return;
  out.render(
    indices.items || indices.indices || [],
    [
      { key: "label", label: "Index" },
      { key: "price", label: "Price", align: "right", format: (v) => out.money(v) },
      { key: "changePct", label: "Change", align: "right", format: (v) => out.pct(v) },
    ],
    flags
  );
  console.log(c.bold("\nTop gainers"));
  for (const g of (movers.gainers || []).slice(0, 5)) {
    console.log(`  ${c.green("▲")} ${g.symbol.padEnd(6)} ${out.money(g.price).padStart(12)}  ${out.pct(g.changePct)}`);
  }
  console.log(c.bold("Top losers"));
  for (const l of (movers.losers || []).slice(0, 5)) {
    console.log(`  ${c.red("▼")} ${l.symbol.padEnd(6)} ${out.money(l.price).padStart(12)}  ${out.pct(l.changePct)}`);
  }
}

// ---------------------------------------------------------------------------
// Travel
// ---------------------------------------------------------------------------

async function travel(args, flags) {
  const [sub, ...restArgs] = args;

  if (sub === "search") {
    if (!flags.city) return out.fail("Usage: furlpay travel search --city Tokyo [--checkin 2026-08-01 --checkout 2026-08-05] [--max-nightly 300] [--min-stars 4]");
    const body = {
      type: "stays",
      city: flags.city,
      checkIn: flags.checkin,
      checkOut: flags.checkout,
      ...(flags["max-nightly"] ? { maxNightlyUsd: Number(flags["max-nightly"]) } : {}),
      ...(flags["min-stars"] ? { minStars: Number(flags["min-stars"]) } : {}),
      ...(flags.guests ? { guests: Number(flags.guests) } : {}),
    };
    const spin = out.spinner(`Searching stays in ${flags.city}…`);
    let data;
    try {
      data = await api.call("POST", "/api/travel/search", { flags, body });
    } finally {
      spin.stop();
    }
    out.render(
      (data.results || []).slice(0, Number(flags.limit) || 10),
      [
        { key: "id", label: "ID" },
        { key: "name", label: "Property" },
        { key: "stars", label: "★", align: "right" },
        { key: "type", label: "Type" },
        { key: "nightlyUsd", label: "Nightly", align: "right", format: (v) => out.money(v) },
      ],
      flags,
      "id"
    );
    if (!flags.quiet && (flags.output || "table") === "table") {
      console.log(c.dim(`  ${data.count} results (${data.source})${data.nights ? ` · ${data.nights} nights` : ""} — book with \`furlpay travel book --name "…" --amount <total>\``));
    }
    return;
  }

  if (sub === "flights") {
    const body = { type: "flights", from: flags.from, to: flags.to, date: flags.date, cabin: flags.cabin };
    if (!flags.from || !flags.to) return out.fail("Usage: furlpay travel flights --from NYC --to TYO [--date 2026-08-01] [--cabin Business]");
    const spin = out.spinner(`Searching flights ${flags.from} → ${flags.to}…`);
    let data;
    try {
      data = await api.call("POST", "/api/travel/search", { flags, body });
    } finally {
      spin.stop();
    }
    out.render(
      (data.results || []).slice(0, Number(flags.limit) || 10),
      [
        { key: "carrier", label: "Airline" },
        { key: "carrierCode", label: "Code" },
        { key: "departTime", label: "Depart" },
        { key: "arriveTime", label: "Arrive" },
        { key: "durationMin", label: "Duration", align: "right", format: (v) => `${Math.floor(v / 60)}h${String(v % 60).padStart(2, "0")}` },
        { key: "stops", label: "Stops", align: "right", format: (v) => (v ? String(v) : c.green("direct")) },
        { key: "cabin", label: "Cabin" },
        { key: "priceUsd", label: "Price", align: "right", format: (v) => out.money(v) },
      ],
      flags,
      "id"
    );
    return;
  }

  if (sub === "book") {
    const amount = Number(flags.amount);
    if (!amount) return out.fail('Usage: furlpay travel book --amount 450 --name "Park Hyatt" --city Tokyo [--checkin --checkout --nights 3 --guests 2]');
    if (!(await confirm(`Book ${c.bold(flags.name || "stay")} in ${flags.city || "—"} for ${out.money(amount)} (USDC via x402)?`, flags))) {
      return console.log(c.dim("Cancelled."));
    }
    const res = await api.call("POST", "/api/travel/book", {
      flags,
      body: {
        amountUsd: amount,
        name: flags.name,
        city: flags.city,
        checkIn: flags.checkin,
        checkOut: flags.checkout,
        nights: flags.nights ? Number(flags.nights) : undefined,
        guests: flags.guests ? Number(flags.guests) : undefined,
        source: flags.source || "travala",
      },
    });
    if (out.renderObject(res, flags)) return;
    const booking = res.booking || {};
    out.ok(`Booked — ${c.cyan(booking.id || "confirmed")} (${booking.status || "authorized"}, ${out.money(booking.amountUsd || amount)})`);
    if (booking.trip) {
      console.log(c.dim(`  ${booking.trip.method || ""}${booking.trip.cashbackUsd ? ` · cashback ${out.money(booking.trip.cashbackUsd)}` : ""}`));
    }
    return;
  }

  if (sub === "bookings" || sub === "trips") {
    const data = await api.call("GET", "/api/travel/trips", { flags });
    const rows = [
      ...(data.upcoming || []).map((t) => ({ ...t, bucket: "upcoming" })),
      ...(data.past || []).map((t) => ({ ...t, bucket: "past" })),
      ...(data.cancelled || []).map((t) => ({ ...t, bucket: "cancelled" })),
    ];
    out.render(
      rows,
      [
        { key: "id", label: "ID" },
        { key: "name", label: "Trip" },
        { key: "city", label: "City" },
        { key: "checkIn", label: "Check-in" },
        { key: "nights", label: "Nights", align: "right" },
        { key: "amountUsd", label: "Total", align: "right", format: (v) => out.money(v) },
        { key: "bucket", label: "Status", format: (v) => (v === "upcoming" ? c.green(v) : v === "cancelled" ? c.red(v) : c.dim(v)) },
      ],
      flags,
      "id"
    );
    return;
  }

  if (sub === "cancel") {
    const id = restArgs[0];
    if (!id) return out.fail("Usage: furlpay travel cancel <booking-id>");
    if (!(await confirm(`Cancel booking ${c.bold(id)}?`, flags))) return console.log(c.dim("Cancelled."));
    const res = await api.call("POST", `/api/travel/cancel/${id}`, { flags, body: {} });
    if (out.renderObject(res, flags)) return;
    out.ok(`Booking ${id} cancelled.`);
    return;
  }

  out.fail("Usage: furlpay travel <search|flights|book|bookings|cancel>");
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

async function card(args, flags) {
  const [sub, id] = args;

  if (sub === "list" || sub === undefined) {
    const data = await api.call("GET", "/api/cards", { flags });
    out.render(
      data.cards || [],
      [
        { key: "id", label: "ID" },
        { key: "label", label: "Label" },
        { key: "kind", label: "Type" },
        { key: "last4", label: "Last 4" },
        { key: "network", label: "Network" },
        { key: "frozen", label: "Status", format: (v) => (v ? c.cyan("frozen") : c.green("active")) },
        { key: "limits", label: "Daily limit", align: "right", format: (v) => (v ? out.money(v.daily) : "—") },
      ],
      flags,
      "id"
    );
    return;
  }

  if (sub === "create") {
    const type = flags.type || "virtual";
    if (!(await confirm(`Issue a new ${c.bold(type)} Visa card?`, flags))) return console.log(c.dim("Cancelled."));
    // kycToken: issuance is gated on verified KYC server-side.
    const res = await api.call("POST", "/api/cards", { flags, body: { cardType: type, kycToken: flags["kyc-token"] || "kyc_cli" } });
    if (out.renderObject(res, flags)) return;
    out.ok(`Card issued: ${c.cyan(res.cardId)} (•••• ${res.last4})`);
    return;
  }

  if (sub === "freeze" || sub === "unfreeze") {
    if (!id) return out.fail(`Usage: furlpay card ${sub} <card-id>`);
    const res = await api.call("POST", "/api/cards/settings", { flags, body: { cardId: id, freeze: sub === "freeze" } });
    if (out.renderObject(res, flags)) return;
    out.ok(`Card ${id} ${sub === "freeze" ? "frozen" : "active again"}`);
    return;
  }

  if (sub === "limits") {
    if (!id) return out.fail("Usage: furlpay card limits <card-id> [--daily 5000] [--per-purchase 2500]");
    if (flags.daily || flags["per-purchase"]) {
      const limits = {
        ...(flags.daily ? { daily: Number(flags.daily) } : {}),
        ...(flags["per-purchase"] ? { perPurchase: Number(flags["per-purchase"]) } : {}),
      };
      const res = await api.call("POST", "/api/cards/settings", { flags, body: { cardId: id, limits } });
      if (out.renderObject(res, flags)) return;
      out.ok(`Limits updated: daily ${out.money(res.card.limits.daily)}, per-purchase ${out.money(res.card.limits.perPurchase)}`);
      return;
    }
    const data = await api.call("GET", "/api/cards", { flags });
    const found = (data.cards || []).find((x) => x.id === id);
    if (!found) return out.fail("Card not found.");
    console.log(JSON.stringify(found.limits, null, 2));
    return;
  }

  if (sub === "transactions") {
    if (!id) return out.fail("Usage: furlpay card transactions <card-id>");
    return tx(["list"], { ...flags, "card-id": id });
  }

  if (sub === "reveal") {
    // PAN/CVV never transit the API in cleartext — this is by design.
    return out.fail("Card details can only be revealed in the FurlPay app after biometric step-up.");
  }

  out.fail("Usage: furlpay card <list|create|freeze|unfreeze|limits|transactions>");
}

// ---------------------------------------------------------------------------
// Earn
// ---------------------------------------------------------------------------

async function earn(args, flags) {
  const [sub, amountArg] = args;

  if (sub === "deposit" || sub === "withdraw") {
    const amount = Number(amountArg);
    if (!Number.isFinite(amount) || amount <= 0) return out.fail(`Usage: furlpay earn ${sub} <usd-amount> [--vault 0x…]`);
    if (!(await confirm(`${sub === "deposit" ? "Deposit" : "Withdraw"} ${c.bold(out.money(amount))} ${sub === "deposit" ? "into" : "from"} FurlPay Earn?`, flags))) {
      return console.log(c.dim("Cancelled."));
    }
    const res = await api.call("POST", `/api/earn/${sub}`, {
      flags,
      body: { amountUsd: amount, ...(flags.vault ? { vault: flags.vault } : {}) },
    });
    if (out.renderObject(res, flags)) return;
    if (res.mode === "live") {
      out.ok(`Unsigned ${sub} bundle for ${res.vault.name} — sign with your Safe:`);
      console.log(JSON.stringify(res, null, 2));
    } else {
      out.ok(
        sub === "deposit"
          ? `Deposited ${out.money(amount)} into ${res.vault.name} (${res.vault.netApy}% APY, ~${out.money(res.projectedYearly)}/yr)`
          : `Withdrew ${out.money(amount)} from ${res.vault ? res.vault.name : "Earn"}`
      );
    }
    return;
  }

  if (sub === "apy" || sub === "vaults") {
    const data = await api.call("GET", "/api/earn/vaults", { flags });
    out.render(
      data.vaults || [],
      [
        { key: "name", label: "Vault" },
        { key: "netApy", label: "Net APY", align: "right", format: (v) => c.green(`${Number(v).toFixed(2)}%`) },
        { key: "tvlUsd", label: "TVL", align: "right", format: (v) => (v ? out.money(v) : "—") },
        { key: "address", label: "Address", format: (v) => c.dim(String(v).slice(0, 10) + "…") },
      ],
      flags,
      "netApy"
    );
    return;
  }

  if (sub === "history") {
    return tx(["list"], { ...flags, category: "yield" });
  }

  // Default / `earn balance`: overview with positions + summary.
  const data = await api.call("GET", "/api/earn", { flags });
  if (out.renderObject(data, flags)) return;
  const s = data.summary || {};
  console.log(`${c.bold("FurlPay Earn")} ${data.live ? c.green("(live)") : c.dim("(simulated)")}   best APY: ${c.green(`${(data.bestApy || 0).toFixed(2)}%`)}`);
  if (s.principalUsd !== undefined) {
    console.log(`  Deposited: ${out.money(s.principalUsd)}   Current: ${out.money(s.currentUsd ?? s.principalUsd)}   Yield: ${c.green(out.money(s.yieldUsd ?? 0))}`);
  }
  console.log(`  Idle USDC: ${out.money(data.idleUsdc)}`);
  out.render(
    data.positions || [],
    [
      { key: "vaultName", label: "Vault" },
      { key: "principalUsd", label: "Principal", align: "right", format: (v) => out.money(v) },
      { key: "currentUsd", label: "Current", align: "right", format: (v) => (v === undefined ? "—" : out.money(v)) },
      { key: "apy", label: "APY", align: "right", format: (v) => c.green(`${Number(v).toFixed(2)}%`) },
    ],
    flags
  );
}

// ---------------------------------------------------------------------------
// Developer tools
// ---------------------------------------------------------------------------

async function apiCmd(args, flags) {
  const [method, path] = args;
  if (!method || !path) return out.fail('Usage: furlpay api <METHOD> </api/path> [--data \'{"k":"v"}\']');
  let body;
  if (flags.data) {
    try {
      body = JSON.parse(flags.data);
    } catch {
      return out.fail("--data must be valid JSON");
    }
  }
  const res = await api.rawRequest(method.toUpperCase(), path.startsWith("/") ? path : "/" + path, { flags, body });
  if (!flags.quiet) console.error(c.dim(`HTTP ${res.status}`));
  console.log(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2));
  if (res.status >= 400) process.exitCode = 1;
}

const DOC_TOPICS = [
  ["quickstart", "/docs"],
  ["payments", "/docs/payments"],
  ["webhooks", "/docs/webhooks"],
  ["x402 (agentic payments)", "/docs/x402"],
  ["sdks", "/docs/sdks"],
  ["cards", "/docs/cards"],
  ["earn", "/docs/earn"],
  ["travel", "/docs/travel"],
  ["api reference", "/developer"],
];

async function docs(args, flags) {
  const query = args.join(" ");
  const base = "https://furlpay.com";
  const match = query ? DOC_TOPICS.find(([t]) => t.includes(query.toLowerCase())) : null;
  const url = base + (match ? match[1] : "/docs");
  console.log(c.bold("FurlPay docs"));
  for (const [topic, p] of DOC_TOPICS) console.log(`  ${c.cyan(topic.padEnd(26))} ${c.dim(base + p)}`);
  if (flags["no-open"]) return;
  // Best-effort browser open, per-platform; the URLs above always work manually.
  const { exec } = require("child_process");
  const opener = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(opener, () => {});
  console.log(c.dim(`\nOpening ${url} …`));
}

module.exports = {
  login,
  logout,
  whoami,
  config,
  env,
  status,
  balance,
  wallet,
  send,
  swap,
  bridge,
  pay,
  tx,
  invest,
  market,
  travel,
  card,
  earn,
  apiCmd,
  docs,
};

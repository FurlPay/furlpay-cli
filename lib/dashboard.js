"use strict";
// `furlpay dashboard` — interactive terminal dashboard. Hand-rolled ANSI TUI
// (alt-screen + raw keys) rather than Ink, so the CLI stays dependency-free
// and `npx @furlpay/cli` starts instantly.
//
// Keys: [h]ome  [p]ortfolio  [e]arn  [t]ransactions  [m]arkets  [r]efresh  [q]uit

const { c } = require("./util");
const api = require("./api");
const { money, pct, sparkline, visibleLength, pad } = require("./output");

const ALT_ON = "\x1b[?1049h\x1b[?25l";
const ALT_OFF = "\x1b[?1049l\x1b[?25h";
const HOME = "\x1b[H\x1b[2J";
const REFRESH_MS = 20_000;

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function panel(title, lines, width) {
  const inner = width - 2;
  const outLines = [];
  const t = ` ${title} `;
  outLines.push("┌─" + c.bold(t) + "─".repeat(Math.max(0, inner - visibleLength(t) - 1)) + "┐");
  for (const line of lines) {
    let s = line;
    // Truncate on visible length so ANSI colors don't break the frame.
    while (visibleLength(s) > inner - 2) s = s.slice(0, -1);
    outLines.push("│ " + pad(s, inner - 2) + " │");
  }
  outLines.push("└" + "─".repeat(inner) + "┘");
  return outLines;
}

// Place two panels side by side (they may have different heights).
function sideBySide(left, right, gap = 2) {
  const rows = Math.max(left.length, right.length);
  const leftWidth = left.length ? visibleLength(left[0]) : 0;
  const outLines = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] || " ".repeat(leftWidth);
    outLines.push(pad(l, leftWidth) + " ".repeat(gap) + (right[i] || ""));
  }
  return outLines;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function fetchAll(flags) {
  const settle = (p) => p.then((v) => v).catch((e) => ({ __error: e.message }));
  const [overview, portfolio, earn, movers] = await Promise.all([
    settle(api.call("GET", "/api/overview", { flags })),
    settle(api.call("GET", "/api/investing/portfolio", { flags })),
    settle(api.call("GET", "/api/earn", { flags })),
    settle(api.call("GET", "/api/markets/movers?limit=6", { flags })),
  ]);
  return { overview, portfolio, earn, movers, at: new Date() };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function balancesPanel(data, w) {
  const o = data.overview;
  if (o.__error) return panel("BALANCES", [c.red(o.__error)], w);
  const lines = (o.tokenBalances || []).map(
    (b) => `${b.token.padEnd(6)} ${pad(money(b.usdValue), 14, "right")}  ${c.dim(b.chain)}`
  );
  lines.push("");
  lines.push(c.bold(`Net worth ${money(o.netWorth)}`));
  lines.push(c.dim(`crypto ${money(o.breakdown.crypto)} · fiat ${money(o.breakdown.fiat)} · equities ${money(o.breakdown.equities)}`));
  return panel("BALANCES", lines, w);
}

function portfolioPanel(data, w, expanded = false) {
  const p = data.portfolio;
  if (p.__error) return panel("PORTFOLIO", [c.red(p.__error)], w);
  const holdings = (p.holdings || []).slice(0, expanded ? 20 : 6);
  const lines = holdings.map(
    (h) =>
      `${h.symbol.padEnd(6)} ${pad(Number(h.shares).toFixed(2) + " sh", 10, "right")} ` +
      `${pad(money(h.marketValue), 12, "right")}  ${pct(h.changePct)}`
  );
  const perf = p.performance;
  if (perf) {
    lines.push("");
    lines.push(c.bold(`Total ${money(perf.marketValue)}`) + `  today ${pct(perf.dayChangePct)}  all-time ${pct(perf.totalReturnPct)}`);
  }
  return panel("PORTFOLIO", lines, w);
}

function earnPanel(data, w) {
  const e = data.earn;
  if (e.__error) return panel("EARN", [c.red(e.__error)], w);
  const s = e.summary || {};
  const lines = [];
  lines.push(`Deposited ${pad(money(s.principalUsd ?? 0), 12, "right")}`);
  lines.push(`Current   ${pad(money(s.currentUsd ?? s.principalUsd ?? 0), 12, "right")}`);
  lines.push(`Yield     ${pad(c.green(money(s.yieldUsd ?? 0)), 12, "right")}  best APY ${c.green(((e.bestApy || 0)).toFixed(2) + "%")}`);
  lines.push(c.dim(`Idle USDC ${money(e.idleUsdc ?? 0)}`));
  for (const v of (e.vaults || []).slice(0, 4)) {
    lines.push(`${String(v.name).slice(0, 22).padEnd(22)} ${c.green(Number(v.netApy).toFixed(2) + "%")}`);
  }
  return panel("EARN", lines, w);
}

function txPanel(data, w, expanded = false) {
  const o = data.overview;
  if (o.__error) return panel("RECENT", [c.red(o.__error)], w);
  const txs = (o.recentTransactions || []).slice(0, expanded ? 20 : 6);
  const lines = txs.map(
    (t) =>
      `${t.direction === "in" ? c.green("←") : c.red("→")} ${String(t.title).slice(0, 26).padEnd(26)} ` +
      `${pad(money(t.amountUsd), 11, "right")} ${c.dim(String(t.status))}`
  );
  return panel("RECENT TRANSACTIONS", lines.length ? lines : [c.dim("(none)")], w);
}

function marketsPanel(data, w) {
  const m = data.movers;
  if (m.__error) return panel("MARKETS", [c.red(m.__error)], w);
  const lines = [c.bold("Gainers")];
  for (const g of (m.gainers || []).slice(0, 5)) lines.push(`  ${c.green("▲")} ${g.symbol.padEnd(6)} ${pad(money(g.price), 11, "right")}  ${pct(g.changePct)}`);
  lines.push(c.bold("Losers"));
  for (const l of (m.losers || []).slice(0, 5)) lines.push(`  ${c.red("▼")} ${l.symbol.padEnd(6)} ${pad(money(l.price), 11, "right")}  ${pct(l.changePct)}`);
  const spark = (m.gainers || []).map((g) => g.changePct);
  if (spark.length) lines.push(c.dim("breadth ") + c.cyan(sparkline(spark)));
  return panel("MARKETS", lines, w);
}

function draw(view, data, flags) {
  const cols = process.stdout.columns || 100;
  const half = Math.min(52, Math.floor((cols - 4) / 2));
  const full = Math.min(106, cols - 2);
  const buf = [];

  const o = data.overview;
  const name = !o.__error && o.user ? o.user.name : "guest";
  const cfg = require("./util").loadConfig();
  buf.push(
    c.bold(c.cyan(" FURLPAY ")) +
      c.dim(`${api.currentEnv(cfg, flags)} · ${api.apiBase(cfg, flags)}`) +
      "   " + c.bold(name) +
      c.dim(`   updated ${data.at.toLocaleTimeString()}`)
  );
  buf.push("");

  if (view === "home") {
    buf.push(...sideBySide(balancesPanel(data, half), portfolioPanel(data, half)));
    buf.push(...sideBySide(earnPanel(data, half), txPanel(data, half)));
  } else if (view === "portfolio") {
    buf.push(...portfolioPanel(data, full, true));
    buf.push(...marketsPanel(data, full));
  } else if (view === "earn") {
    buf.push(...earnPanel(data, full));
    buf.push(...txPanel(data, full));
  } else if (view === "tx") {
    buf.push(...txPanel(data, full, true));
  } else if (view === "markets") {
    buf.push(...marketsPanel(data, full));
  }

  buf.push("");
  buf.push(c.dim(" [h]ome  [p]ortfolio  [e]arn  [t]ransactions  [m]arkets  [r]efresh  [q]uit"));
  process.stdout.write(HOME + buf.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function run(flags) {
  if (!process.stdout.isTTY) {
    console.error("dashboard requires an interactive terminal");
    process.exit(1);
  }

  let view = flags.portfolio ? "portfolio" : flags.earn ? "earn" : "home";
  let data;

  const cleanup = () => {
    process.stdout.write(ALT_OFF);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  process.stdout.write(ALT_ON + HOME + c.dim("Loading FurlPay dashboard…"));
  data = await fetchAll(flags);
  draw(view, data, flags);

  const timer = setInterval(async () => {
    data = await fetchAll(flags);
    draw(view, data, flags);
  }, REFRESH_MS);
  timer.unref?.();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (key) => {
    if (key === "q" || key === "\x03" /* ctrl-c */) return cleanup();
    if (key === "h" || key === "b") view = "home";
    else if (key === "p") view = "portfolio";
    else if (key === "e") view = "earn";
    else if (key === "t") view = "tx";
    else if (key === "m") view = "markets";
    else if (key === "r") {
      data = await fetchAll(flags);
    } else return;
    draw(view, data, flags);
  });
}

module.exports = { run };

"use strict";
// Output system: every listing command renders through render() so
// --output json|csv|table and --quiet behave identically everywhere.
//
// TERMINAL-INJECTION RULE (second-pass audit 2026-11-12): strings that
// originate from an API response, a counterparty, or an agent are rendered
// through sanitize() from lib/terminal.js — never raw. A malicious API can
// otherwise rewrite table geometry with OSC/CSI, spoof approval screens with
// BiDi overrides, or forge log lines with newlines.

const { c } = require("./util");
const { sanitize } = require("./terminal");

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

function money(n, currency = "$") {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return currency + num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const s = `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
  return num >= 0 ? c.green(s) : c.red(s);
}

// Strip ANSI codes when measuring cell widths (SGR, OSC, CSI and C1 variants).
function visibleLength(s) {
  return sanitize(s).length;
}

function pad(s, width, align = "left") {
  const gap = Math.max(0, width - visibleLength(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

// ---------------------------------------------------------------------------
// Table renderer (box-drawing, like cli-table3 without the dependency)
// ---------------------------------------------------------------------------

/** cols: [{ key, label, align?: "left"|"right", format?: (val, row) => str }] */
function table(rows, cols) {
  const cells = rows.map((row) =>
    cols.map((col) => {
      // Sanitize the RAW value first — API/counterparty data never reaches the
      // terminal with escape sequences intact — then hand the clean string to
      // the (trusted) formatter, which may add its own styling.
      const raw = sanitize(val === undefined || val === null ? "—" : String(row[col.key]));
      return col.format ? col.format(raw, row) : raw;
    })
  );
  const widths = cols.map((col, i) =>
    Math.max(visibleLength(col.label), ...cells.map((r) => visibleLength(r[i])), 1)
  );
  const line = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const out = [];
  out.push(line("┌", "┬", "┐"));
  out.push("│ " + cols.map((col, i) => c.bold(pad(col.label, widths[i]))).join(" │ ") + " │");
  out.push(line("├", "┼", "┤"));
  for (const row of cells) {
    out.push("│ " + row.map((cell, i) => pad(cell, widths[i], cols[i].align)).join(" │ ") + " │");
  }
  out.push(line("└", "┴", "┘"));
  return out.join("\n");
}

// CSV cells that Excel/Sheets would evaluate as formulas are neutralized with
// a leading apostrophe: =, +, -, @ and tab/CR prefixes. A counterparty-
// controlled field like a name or memo must never execute in a spreadsheet.
function csvEscape(v) {
  let s = String(v === undefined || v === null ? "" : v).replace(/\x1b\[[0-9;]*m/g, "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(rows, cols) {
  const head = cols.map((col) => csvEscape(col.label)).join(",");
  const body = rows.map((row) =>
    cols.map((col) => csvEscape(col.format ? col.format(row[col.key], row) : row[col.key])).join(",")
  );
  return [head, ...body].join("\n");
}

/**
 * Unified list output. quietKey: which raw field --quiet prints (one per line).
 * JSON/CSV always emit RAW values (no ANSI, no $-formatting) for scripting.
 */
function render(rows, cols, flags, quietKey) {
  const mode = flags.output || (flags.json ? "json" : "table");
  if (flags.quiet && quietKey) {
    for (const row of rows) console.log(row[quietKey]);
    return;
  }
  if (mode === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (mode === "csv") {
    const rawCols = cols.map(({ key, label }) => ({ key, label }));
    console.log(csv(rows, rawCols));
    return;
  }
  if (!rows.length) {
    console.log(c.dim("(no results)"));
    return;
  }
  console.log(table(rows, cols));
}

/** For single-object commands: JSON when asked, key/value lines otherwise. */
function renderObject(obj, flags) {
  if ((flags.output || (flags.json ? "json" : "")) === "json") {
    console.log(JSON.stringify(obj, null, 2));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Charts (asciichart-style, no dependency)
// ---------------------------------------------------------------------------

function lineChart(values, { height = 8, label = (v) => v.toFixed(2) } = {}) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const rows = [];
  for (let y = height - 1; y >= 0; y--) {
    const threshold = min + (range * y) / (height - 1 || 1);
    let row = "";
    for (const v of values) {
      const lv = Math.round(((v - min) / range) * (height - 1));
      row += lv === y ? "●" : lv > y ? "│" : " ";
    }
    rows.push(c.dim(pad(label(threshold), 10, "right")) + " ┤" + c.cyan(row));
  }
  return rows.join("\n");
}

const SPARKS = "▁▂▃▄▅▆▇█";
function sparkline(values) {
  if (!values.length) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => SPARKS[Math.round(((v - min) / range) * (SPARKS.length - 1))]).join("");
}

// ---------------------------------------------------------------------------
// Spinner (stderr so piped stdout stays clean; no-op when not a TTY)
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinner(text) {
  if (!process.stderr.isTTY) return { stop() {} };
  let i = 0;
  process.stderr.write("\x1b[?25l");
  const timer = setInterval(() => {
    process.stderr.write(`\r${c.cyan(FRAMES[i++ % FRAMES.length])} ${text}`);
  }, 80);
  return {
    stop() {
      clearInterval(timer);
      process.stderr.write("\r" + " ".repeat(text.length + 3) + "\r\x1b[?25h");
    },
  };
}

function ok(msg) {
  console.log(c.green("✓ ") + msg);
}
function fail(msg) {
  console.error(c.red("✗ ") + msg);
}

module.exports = { money, pct, table, csv, render, renderObject, lineChart, sparkline, spinner, ok, fail, visibleLength, pad };

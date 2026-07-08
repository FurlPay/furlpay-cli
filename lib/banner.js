"use strict";
// FurlPay ASCII wordmark. Rendered with a cyan→blue gradient on ANSI-capable
// TTYs; plain monochrome when piped so `furlpay help > file` stays clean.

const LOGO = [
  "███████╗██╗   ██╗██████╗ ██╗     ██████╗  █████╗ ██╗   ██╗",
  "██╔════╝██║   ██║██╔══██╗██║     ██╔══██╗██╔══██╗╚██╗ ██╔╝",
  "█████╗  ██║   ██║██████╔╝██║     ██████╔╝███████║ ╚████╔╝ ",
  "██╔══╝  ██║   ██║██╔══██╗██║     ██╔═══╝ ██╔══██║  ╚██╔╝  ",
  "██║     ╚██████╔╝██║  ██║███████╗██║     ██║  ██║   ██║   ",
  "╚═╝      ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝  ╚═╝   ╚═╝   ",
];

// xterm-256 gradient, bright cyan down to deep blue — one shade per row.
const GRADIENT = [51, 45, 39, 38, 33, 27];

const TAGLINE = "Stablecoin payments · Investing · Travel · Yield";
const RULE = "─".repeat(LOGO[0].length);

function banner({ color = process.stdout.isTTY } = {}) {
  const paint = (row, i) => (color ? `\x1b[38;5;${GRADIENT[i]}m${row}\x1b[0m` : row);
  const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const center = (s) => " ".repeat(Math.max(0, Math.floor((LOGO[0].length - s.length) / 2))) + s;
  return [
    "",
    ...LOGO.map(paint),
    dim(RULE),
    dim(center(TAGLINE)),
    "",
  ].join("\n");
}

module.exports = { banner, LOGO };

"use strict";

// Terminal cells are measured independently of ANSI styles and UTF-16 length.
const TOKENS = {
  mint: [0, 230, 184, 49, 36], teal: [0, 245, 196, 50, 96],
  violet: [96, 72, 255, 99, 95], blue: [0, 140, 255, 33, 94],
  text: [245, 247, 255, 231, 97], muted: [181, 197, 232, 146, 37],
  border: [28, 52, 71, 238, 90], red: [255, 64, 91, 203, 91],
  amber: [255, 190, 69, 215, 93],
};
const SGR = /\x1b\[[0-9;]*m/g;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function sanitize(value) {
  return String(value ?? '')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|\x90)[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1f\x7f-\x9f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\u00a0/g, ' ');
}
function cellWidth(g) {
  if (/^\p{Mark}+$/u.test(g)) return 0;
  const p = g.codePointAt(0);
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) ||
    p >= 0x1100 && (p <= 0x115f || p === 0x2329 || p === 0x232a ||
    p >= 0x2e80 && p <= 0xa4cf || p >= 0xac00 && p <= 0xd7a3 ||
    p >= 0xf900 && p <= 0xfaff || p >= 0xfe10 && p <= 0xfe6f ||
    p >= 0xff01 && p <= 0xff60 || p >= 0xffe0 && p <= 0xffe6 ||
    p >= 0x20000 && p <= 0x3fffd) ? 2 : 1;
}
function width(value) {
  return [...segmenter.segment(String(value).replace(SGR, ''))]
    .reduce((n, { segment }) => n + cellWidth(segment), 0);
}
function fit(value, size) {
  let used = 0, result = '';
  for (const part of String(value).split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) { result += part; continue; }
    for (const { segment } of segmenter.segment(part)) {
      const n = cellWidth(segment);
      if (used + n > size) return result + (result.includes('\x1b') ? '\x1b[0m' : '') + ' '.repeat(size - used);
      result += segment; used += n;
    }
  }
  return result + ' '.repeat(Math.max(0, size - used));
}
function wrap(value, size) {
  const lines = []; let line = '';
  for (const word of sanitize(value).split(/ +/)) {
    if (line && width(line + ' ' + word) <= size) { line += ' ' + word; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const { segment } of segmenter.segment(word)) {
      if (width(line + segment) > size) { lines.push(line); line = ''; }
      line += segment;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
function colorLevel(env = process.env, tty = process.stdout.isTTY) {
  if (Object.hasOwn(env, 'NO_COLOR') || env.TERM === 'dumb' || !tty) return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM || '') || env.WT_SESSION) return 3;
  return /256color/.test(env.TERM || '') ? 2 : 1;
}
function palette(level = colorLevel()) {
  const result = {};
  for (const [name, [r, g, b, index, basic]] of Object.entries(TOKENS)) {
    const code = level === 3 ? '38;2;' + [r, g, b].join(';') : level === 2 ? '38;5;' + index : basic;
    result[name] = s => level ? '\x1b[' + code + 'm' + s + '\x1b[0m' : String(s);
  }
  result.bold = s => level ? '\x1b[1m' + s + '\x1b[22m' : String(s);
  return result;
}
function box(lines, size, paint, ascii = false) {
  const [tl, tr, bl, br, h, v] = ascii ? ['+', '+', '+', '+', '-', '|'] : ['╭', '╮', '╰', '╯', '─', '│'];
  return [
    paint(tl + h.repeat(size - 2) + tr),
    ...lines.map(s => paint(v) + ' ' + fit(s, size - 4) + ' ' + paint(v)),
    paint(bl + h.repeat(size - 2) + br),
  ];
}
function joinColumns(columns, sizes, gap = ' ') {
  const rows = Math.max(...columns.map(c => c.length));
  return Array.from({ length: rows }, (_, row) => columns.map((c, i) => fit(c[row] || '', sizes[i])).join(gap));
}
module.exports = { TOKENS, sanitize, width, fit, wrap, colorLevel, palette, box, joinColumns };

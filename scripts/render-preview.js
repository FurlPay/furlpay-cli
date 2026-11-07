"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { renderPayment } = require('../lib/payView');
const { demoQuote } = require('../lib/payDemo');
const columns = 120;
const lines = renderPayment(demoQuote(), { columns, colorLevel: 3, demo: true }).trimEnd().split('\n');
const cell = 11.8, row = 25, margin = 48, top = 90;
const w = columns * cell + margin * 2, h = top + lines.length * row + 35;
const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
let rows = '';
for (let i = 0; i < lines.length; i++) {
  let color = '#b5c5e8', weight = 'normal', x = margin;
  for (const part of lines[i].split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) {
      const code = part.slice(2, -1).split(';').map(Number);
      if (code[0] === 38 && code[1] === 2) color = 'rgb(' + code.slice(2).join(',') + ')';
      if (code[0] === 1) weight = 'bold';
      if (code[0] === 22) weight = 'normal';
      if (code[0] === 0) { color = '#b5c5e8'; weight = 'normal'; }
      continue;
    }
    if (!part) continue;
    rows += '<text x="' + x + '" y="' + (top + i * row) + '" fill="' + color + '" font-weight="' + weight +
      '" xml:space="preserve" textLength="' + (part.length * cell) + '" lengthAdjust="spacingAndGlyphs">' + escape(part) + '</text>\n';
    x += part.length * cell;
  }
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
  '<rect width="100%" height="100%" rx="18" fill="#030b13"/>' +
  '<path d="M18 0H' + (w-18) + 'Q' + w + ' 0 ' + w + ' 18V55H0V18Q0 0 18 0" fill="#17202e"/>' +
  '<circle cx="28" cy="27" r="8" fill="#ff5f57"/><circle cx="54" cy="27" r="8" fill="#febc2e"/><circle cx="80" cy="27" r="8" fill="#28c840"/>' +
  '<text x="' + w/2 + '" y="34" text-anchor="middle" fill="#b5c5e8" font-family="monospace" font-size="17">furlpay pay --demo / offline reference preview</text>' +
  '<g font-family="Cascadia Mono,Consolas,DejaVu Sans Mono,monospace" font-size="19">' + rows + '</g></svg>\n';
fs.writeFileSync(path.join(__dirname, '../docs/terminal-preview.svg'), svg);
console.log('Generated docs/terminal-preview.svg from the actual ANSI renderer.');

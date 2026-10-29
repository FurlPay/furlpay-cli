"use strict";
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
// Native CommonJS ships directly: validate every source and package entry point.
for (const dir of ['bin', 'lib', 'scripts']) {
  for (const name of fs.readdirSync(path.join(root, dir)).filter(n => n.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, dir, name)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
const pkg = require('../package.json');
const server = require('../server.json');
if (pkg.version !== server.version || server.packages[0].version !== pkg.version)
  throw new Error('Package and MCP manifest versions must match.');
for (const name of ['bin/furlpay.js', 'lib/payTui.js', 'lib/payView.js', 'lib/terminal.js'])
  if (!fs.existsSync(path.join(root, name))) throw new Error('Missing package file: ' + name);
console.log('Build verified: @furlpay/cli v' + pkg.version + ' (native CommonJS; ws transport dependency).');

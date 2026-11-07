"use strict";
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function dpapi(value, decrypt = false) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Secret material travels over stdin, never command-line arguments or environment.
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
    "$r=[Security.Cryptography.ProtectedData]::" + (decrypt ? 'Unprotect' : 'Protect') +
    "($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))";
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(value).toString('base64'), encoding: 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(result.stdout || ''))
    throw new Error('Windows credential protection failed. Configuration was not replaced.');
  return Buffer.from(result.stdout, 'base64');
}
function save(file, config) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const plain = JSON.stringify(config, null, 2);
  const contents = process.platform === 'win32'
    ? JSON.stringify({ format: 'furlpay-dpapi-v1', ciphertext: dpapi(plain).toString('base64') }) : plain;
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
function load(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Cannot read CLI configuration; restore or repair it before continuing.'); }
  if (value?.format === 'furlpay-dpapi-v1') {
    if (process.platform !== 'win32') throw new Error('This configuration is bound to its Windows user. Sign in on this computer.');
    value = JSON.parse(dpapi(Buffer.from(value.ciphertext, 'base64'), true).toString('utf8'));
  } else if (process.platform === 'win32') save(file, value);
  else fs.chmodSync(file, 0o600);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid CLI configuration.');
  return value;
}
module.exports = { load, save, dpapi };

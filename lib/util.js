"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CONFIG_DIR = path.join(os.homedir(), ".furlpay");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // Atomic write: temp file in the SAME directory (rename is atomic within a
  // filesystem) + fsync, so a crash or two concurrent CLI processes can never
  // leave a truncated config.json behind — the old in-place writeFileSync
  // corrupted sessions on exactly the concurrent-login case it needed to
  // survive. Refuse to follow a symlink planted at the config path: rename
  // would replace the link, but readFileSync would have followed it.
  const tmpPath = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const stats = fs.lstatSync(CONFIG_PATH);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to write: ${CONFIG_PATH} is a symlink`);
    }
  } catch (e) {
    // ENOENT = first write, nothing to protect. Anything else — including the
    // symlink refusal above — propagates and aborts the write.
    if (e.code !== "ENOENT") throw e;
  }
  const payload = JSON.stringify(cfg, null, 2);
  try {
    const fd = fs.openSync(tmpPath, "w", 0o600);
    try {
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, CONFIG_PATH);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* renamed away already */
    }
  }
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows chmod is a no-op for unix mode bits
  }
}

// HMAC-SHA256 signature header, matching @furlpay/compliance + SDK.
function sign(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

// Flags that are pure switches and NEVER consume a following token. Without
// this schema the greedy parser turned `furlpay pay --yes @recipient 10 usd`
// into "yes = @recipient", shifting every positional left and sending money
// to the wrong recipient (audit P7). Keep this list in sync with the CLI
// surface: add a flag here only when no command ever gives it a value.
const BOOLEAN_FLAGS = new Set([
  "yes", "y", "json", "quiet", "agent", "dry-run", "demo", "sponsor",
  "verbose", "v", "h", "help", "toml", "testnet", "check", "latest",
  "device", "qr", "interactive", "mnemonic", "all-chains", "isolated",
  "hl", "perp", "orderbook", "microstructure", "quant", "workstation",
  "headless", "reduce-only", "post-only", "quote-only", "qty", "no-open",
  "no-browser", "once", "ascii", "hlp", "offline",
]);

function isBooleanFlag(token) {
  // Short single-char flags (-y, -v) are switches by convention here.
  if (/^-[a-zA-Z]$/.test(token)) return true;
  if (!token.startsWith("--")) return false;
  return BOOLEAN_FLAGS.has(token.slice(2));
}

// Minimal flag parser: --key value / --key=value / --flag.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (isBooleanFlag(tok)) {
      const name = tok.startsWith("--") ? tok.slice(2) : tok.slice(1);
      flags[name] = true;
      continue;
    }
    if (tok.startsWith("--")) {
      const raw = tok.slice(2);
      const eq = raw.indexOf("=");
      if (eq !== -1) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[raw] = next;
        i++;
      } else {
        flags[raw] = true;
      }
    }
  }
  return flags;
}

// Positional args = everything that isn't a flag or a flag's value. Must
// mirror parseFlags' consumption EXACTLY: boolean switches never eat the
// next token, value flags do (any token not starting with "--" — including
// short flags — is a value candidate for them, same as parseFlags).
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (isBooleanFlag(tok)) continue;
    if (tok.startsWith("--")) {
      if (!tok.includes("=") && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(tok);
  }
  return out;
}

// Interactive line prompt (readline). masked=true hides input (API keys, codes).
function prompt(question, { masked = false } = {}) {
  const readline = require("readline");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (masked) {
      // Overwrite echoed chars: readline still records them, we just don't show them.
      rl._writeToOutput = function (s) {
        rl.output.write(s.includes(question) ? s : "*");
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (masked) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// y/N confirmation. --yes / -y skips it (scripting).
async function confirm(question, flags = {}) {
  if (flags.yes || flags.y) return true;
  const answer = await prompt(`${question} ${c.dim("[y/N]")} `);
  return /^y(es)?$/i.test(answer);
}

module.exports = { c, loadConfig, saveConfig, sign, parseFlags, positionals, prompt, confirm, CONFIG_DIR, CONFIG_PATH };

"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const CONFIG_DIR = path.join(os.homedir(), ".furlpay");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const styled = (code, s) => !process.stdout.isTTY || Object.hasOwn(process.env, "NO_COLOR") || process.env.TERM === "dumb" ? String(s) : "\x1b[" + code + "m" + s + "\x1b[0m";
const c = {
  dim: (s) => styled("2", s),
  green: (s) => styled("32", s),
  red: (s) => styled("31", s),
  cyan: (s) => styled("36", s),
  yellow: (s) => styled("33", s),
  bold: (s) => styled("1", s),
};

function loadConfig() {
  return require('./configStore').load(CONFIG_PATH);
}

function saveConfig(cfg) {
  require('./configStore').save(CONFIG_PATH, cfg);
}

// HMAC-SHA256 signature header, matching @furlpay/compliance + SDK.
function sign(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const BOOLEAN_FLAGS = new Set(["yes", "y", "json", "quiet", "demo", "ascii", "dry-run", "help", "h", "portfolio", "earn", "quote-only", "qty", "tail", "no-open", "live", "watch", "once"]);

// Minimal flag parser: --key value / --key=value / --flag.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-y" || argv[i] === "-h") { flags[argv[i].slice(1)] = true; continue; }
    if (argv[i].startsWith("--")) {
      const raw = argv[i].slice(2);
      const eq = raw.indexOf("=");
      if (eq !== -1) {
        flags[raw.slice(0, eq)] = raw.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(raw)) { flags[raw] = true; continue; }
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

// Positional args = everything that isn't a flag or a flag's value.
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-y" || argv[i] === "-h") continue;
    if (argv[i].startsWith("--")) {
      if (!argv[i].includes("=") && !BOOLEAN_FLAGS.has(argv[i].slice(2)) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(argv[i]);
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

module.exports = { c, loadConfig, saveConfig, sign, parseFlags, positionals, prompt, confirm, CONFIG_PATH };

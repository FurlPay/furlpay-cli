#!/bin/sh
# FurlPay CLI installer (Linux / macOS) — secure npm bootstrap.
#
# What this does (inspect before running — that's the point of curl | sh):
#   1. Verifies Node.js >= 22.19.0 and npm are present (never installs them
#      for you, never uses sudo).
#   2. Verifies npm is installing from the official registry.npmjs.org.
#   3. Runs:  npm install -g @furlpay/cli@<version>   (integrity is enforced
#      by npm itself: every tarball is checked against the registry's sha512
#      digest and manifest signatures before it is executed).
#   4. Verifies the installed `furlpay --version` matches the target.
#
# Standalone binaries are a planned second channel; until they ship, npm is
# the only supported installation method, and this script is a verified
# bootstrap for it — it downloads nothing outside npm's signed path.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.sh | sh
#   install.sh [--version X.Y.Z] [--channel stable|beta] [--uninstall] [--dry-run] [--help]
#
# Exit codes: 0 success · 1 environment/verification failure · 2 usage error.

set -eu

PACKAGE="@furlpay/cli"
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=19
OFFICIAL_REGISTRY="https://registry.npmjs.org/"
REPO_URL="https://github.com/FurlPay/furlpay-cli"

VERSION=""
CHANNEL="stable"
UNINSTALL=0
DRY_RUN=0

usage() {
  cat <<EOF
FurlPay CLI installer — bootstraps the official npm global install.

Usage: install.sh [options]

Options:
  --version X.Y.Z   Install an exact version (default: latest stable on npm)
  --channel NAME    Dist-tag channel: stable (default) or beta
  --uninstall       Remove the globally installed @furlpay/cli
  --dry-run         Print the plan and checks without changing anything
  --help            Show this help

This script never uses sudo and never downloads anything outside npm's
integrity-verified install path. Source: $REPO_URL
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "install.sh: --version needs a value" >&2; exit 2; }; VERSION="$2"; shift 2 ;;
    --channel) [ $# -ge 2 ] || { echo "install.sh: --channel needs a value" >&2; exit 2; }; CHANNEL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "install.sh: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

case "$CHANNEL" in
  stable) SPEC="${VERSION:-latest}" ;;
  beta)
    [ -z "$VERSION" ] || echo "install.sh: --version overrides --channel — installing the exact version" >&2
    SPEC="${VERSION:-beta}"
    ;;
  *) echo "install.sh: --channel must be 'stable' or 'beta' (got '$CHANNEL')" >&2; exit 2 ;;
esac

info()  { printf '  %s\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()   { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

echo "FurlPay CLI installer (npm bootstrap)"
echo "-------------------------------------"

# --- OS guard ---------------------------------------------------------------
case "$(uname -s)" in
  Linux*) ;;
  Darwin*) ;;
  *) die "Unsupported OS '$(uname -s)' — use install.ps1 on Windows, or: npm install -g $PACKAGE" ;;
esac

# --- Node.js ----------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v 2>/dev/null || true)"
  NODE_VERSION="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  NODE_REST="${NODE_VERSION#*.}"
  NODE_MINOR="${NODE_REST%%.*}"
  if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] ||
     { [ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]; }; then
    die "Node.js >= $REQUIRED_NODE_MAJOR.$REQUIRED_NODE_MINOR.0 required, found $NODE_VERSION.
     Install a current LTS from https://nodejs.org (nvm: nvm install --lts), then re-run."
  fi
  ok "Node.js v$NODE_VERSION"
else
  die "Node.js is not installed (need >= $REQUIRED_NODE_MAJOR.$REQUIRED_NODE_MINOR.0).
   Install it from https://nodejs.org — e.g.: curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | sh && . ~/.nvm/nvm.sh && nvm install --lts
   Then re-run this script."
fi

command -v npm >/dev/null 2>&1 || die "npm not found — it ships with Node.js; reinstall Node from https://nodejs.org"

# --- Registry sanity (fail loud on untrusted mirrors) -----------------------
REGISTRY="$(npm config get registry 2>/dev/null || true)"
case "${REGISTRY%/}" in
  "$OFFICIAL_REGISTRY"|"") ok "npm registry: official npmjs.org" ;;
  *)
    warn "npm registry is '${REGISTRY}' — not the official registry.npmjs.org."
    warn "npm will still verify each tarball's sha512 against that registry's manifest."
    warn "If this mirror is intentional, continue; otherwise:"
    warn "  npm config set registry $OFFICIAL_REGISTRY"
    ;;
esac

# --- Writable global prefix (never sudo) ------------------------------------
PREFIX="$(npm prefix -g 2>/dev/null || true)"
[ -n "$PREFIX" ] || die "Could not resolve npm global prefix"
BIN_DIR="$PREFIX/bin"
if [ "$(id -u)" = "0" ]; then
  warn "Running as root — installing for root. Prefer a normal user install (no sudo needed)."
elif [ ! -w "$PREFIX" ] && [ ! -w "$(dirname "$PREFIX")" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    warn "npm prefix '$PREFIX' is not writable — a real run would stop here with fix instructions."
  else
    die "npm global prefix '$PREFIX' is not writable by $(whoami 2>/dev/null || echo "this user").
   Fix WITHOUT sudo, one of:
     npm config set prefix ~/.npm-global   # then add ~/.npm-global/bin to PATH
     (or use nvm/volta/fnm, which keep the prefix user-owned)
   Then re-run this script."
  fi
else
  ok "npm prefix: $PREFIX (writable)"
fi

# --- Uninstall --------------------------------------------------------------
if [ "$UNINSTALL" = "1" ]; then
  echo ""
  info "Uninstalling $PACKAGE …"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] would run: npm uninstall -g $PACKAGE"
    exit 0
  fi
  npm uninstall -g "$PACKAGE"
  if command -v furlpay >/dev/null 2>&1; then
    warn "'furlpay' is still on PATH — it may come from another install location: $(command -v furlpay)"
  else
    ok "Uninstalled. (Your ~/.furlpay config, wallets and escrow ledger were left untouched.)"
  fi
  exit 0
fi

# --- Resolve target ---------------------------------------------------------
if [ -n "$VERSION" ]; then
  TARGET="$VERSION"
else
  TAG="$SPEC"   # latest | beta
  TARGET="$(npm view "$PACKAGE@$TAG" version 2>/dev/null || true)"
  [ -n "$TARGET" ] || die "Could not resolve '$PACKAGE@$TAG' from the registry (offline? unknown tag?)"
fi

echo ""
info "Target: $PACKAGE@v$TARGET"
if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] would run: npm install -g $PACKAGE@$TARGET"
  info "[dry-run] would then verify: $BIN_DIR/furlpay --version == $TARGET"
  exit 0
fi

# --- Install ----------------------------------------------------------------
info "Installing …"
npm install -g "$PACKAGE@$TARGET"

# --- Verify -----------------------------------------------------------------
FURLPAY_BIN="$BIN_DIR/furlpay"
if [ ! -e "$FURLPAY_BIN" ]; then
  die "Install finished but $FURLPAY_BIN is missing — see npm output above."
fi
INSTALLED="$("$FURLPAY_BIN" --version 2>/dev/null || true)"
if [ "$INSTALLED" != "$TARGET" ]; then
  die "Verification failed: furlpay --version reported '$INSTALLED', expected '$TARGET'.
   Rollback: npm install -g $PACKAGE@<previous-version>"
fi
ok "Installed @furlpay/cli v$INSTALLED"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "On PATH: $BIN_DIR" ;;
  *)
    warn "$BIN_DIR is not on your PATH. Add this line to your shell profile (~/.bashrc / ~/.zshrc):"
    warn "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo ""
ok "Try it:  furlpay --version    ·  furlpay --help    ·  furlpay doctor"
info "Updates: furlpay update --check   (or: furlpay update)"
info "Docs:    $REPO_URL#readme"

# FurlPay CLI installer (Windows) — secure npm bootstrap.
#
# What this does (inspect before running — that's the point of irm | iex):
#   1. Verifies Node.js >= 22.19.0 and npm are present (never installs them,
#      never elevates, never touches machine-wide config).
#   2. Verifies npm is installing from the official registry.npmjs.org.
#   3. Runs:  npm install -g @furlpay/cli@<version>   (integrity is enforced
#      by npm itself: every tarball is checked against the registry's sha512
#      digest and manifest signatures before it is executed).
#   4. Verifies the installed `furlpay --version` matches the target.
#
# Usage:
#   irm https://raw.githubusercontent.com/FurlPay/furlpay-cli/main/install.ps1 | iex
#   .\install.ps1 [-Version X.Y.Z] [-Channel stable|beta] [-Uninstall] [-DryRun]
#
# Requires Windows PowerShell 5.1+ or PowerShell 7+. No administrator rights.

[CmdletBinding()]
param(
  [string]$Version = "",
  [ValidateSet("stable", "beta")]
  [string]$Channel = "stable",
  [switch]$Uninstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Package = "@furlpay/cli"
$RequiredMajor = 22
$RequiredMinor = 19
$OfficialRegistry = "https://registry.npmjs.org/"
$RepoUrl = "https://github.com/FurlPay/furlpay-cli"

function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  $msg" }
function Warn($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  [X]  $msg" -ForegroundColor Red; exit 1 }

Write-Host "FurlPay CLI installer (npm bootstrap)" -ForegroundColor Cyan
Write-Host "-------------------------------------"

# --- Node.js ----------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "Node.js is not installed (need >= $RequiredMajor.$RequiredMinor.0).
  Install the current LTS from https://nodejs.org, reopen your terminal, then re-run this script."
}
$nodeVersion = (& node -v).TrimStart("v")
$parts = $nodeVersion -split "\."
if ($parts.Count -lt 2 -or [int]$parts[0] -lt $RequiredMajor -or
    ([int]$parts[0] -eq $RequiredMajor -and [int]$parts[1] -lt $RequiredMinor)) {
  Die "Node.js >= $RequiredMajor.$RequiredMinor.0 required, found $nodeVersion.
  Upgrade from https://nodejs.org, then re-run."
}
Ok "Node.js v$nodeVersion"

$npmCmd = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npmCmd) { Die "npm not found - it ships with Node.js; reinstall Node from https://nodejs.org" }

# --- Registry sanity ----------------------------------------------------------
$registry = (& npm config get registry 2>$null).ToString().Trim().TrimEnd("/")
if ($registry -eq "" -or $registry -eq $OfficialRegistry.TrimEnd("/")) {
  Ok "npm registry: official npmjs.org"
} else {
  Warn "npm registry is '$registry' - not the official registry.npmjs.org."
  Warn "npm still verifies each tarball's sha512 against that registry's manifest."
  Warn "If unintended:  npm config set registry $OfficialRegistry"
}

# --- Global prefix / PATH (no elevation) --------------------------------------
$prefix = (& npm prefix -g).ToString().Trim()
if (-not $prefix) { Die "Could not resolve npm global prefix." }
Ok "npm prefix: $prefix"

# npm's default per-user prefix is %APPDATA%\npm; a machine-wide Node install
# points elsewhere and may need elevation to write. We never elevate — check
# writability up front and give the exact no-admin fix instead.
$canWrite = $false
try {
  $probe = Join-Path $prefix ".furlpay-write-probe"
  [IO.File]::WriteAllText($probe, "probe"); Remove-Item $probe -ErrorAction SilentlyContinue
  $canWrite = $true
} catch { $canWrite = $false }
if (-not $canWrite) {
  if ($DryRun) {
    Warn "npm prefix '$prefix' is not writable - a real run would stop here with fix instructions."
  } else {
    Die "npm global prefix '$prefix' is not writable without elevation.
  Switch npm to a per-user prefix (no admin needed):
    npm config set prefix `"$env:APPDATA\npm`"
  Then ensure $env:APPDATA\npm is on PATH and re-run this script."
  }
}

# --- Uninstall -----------------------------------------------------------------
if ($Uninstall) {
  Info ""
  Info "Uninstalling $Package ..."
  if ($DryRun) { Info "[dry-run] would run: npm uninstall -g $Package"; exit 0 }
  & npm uninstall -g $Package
  if (Get-Command furlpay -ErrorAction SilentlyContinue) {
    Warn "'furlpay' is still on PATH - it may come from another install: $((Get-Command furlpay).Source)"
  } else {
    Ok "Uninstalled. (Your $env:USERPROFILE\.furlpay config, wallets and escrow ledger were left untouched.)"
  }
  exit 0
}

# --- Resolve target ------------------------------------------------------------
if ($Version -ne "") {
  $target = $Version
} elseif ($Channel -eq "beta") {
  $target = (& npm view "$Package@beta" version 2>$null).ToString().Trim()
  if (-not $target) { Die "Could not resolve $Package@beta from the registry (no beta tag published?)." }
} else {
  $target = (& npm view "$Package@latest" version 2>$null).ToString().Trim()
  if (-not $target) { Die "Could not resolve $Package@latest from the registry (offline?)." }
}

Info ""
Info "Target: $Package v$target"
if ($DryRun) {
  Info "[dry-run] would run: npm install -g $Package@$target"
  Info "[dry-run] would then verify: furlpay --version == $target"
  exit 0
}

# --- Install --------------------------------------------------------------------
Info "Installing ..."
& npm install -g "$Package@$target"

# --- Verify ----------------------------------------------------------------------
$shim = Join-Path $prefix "furlpay.cmd"
if (-not (Test-Path $shim)) { Die "Install finished but $shim is missing - see npm output above." }
$installed = (& $shim --version).ToString().Trim()
if ($installed -ne $target) {
  Die "Verification failed: furlpay --version reported '$installed', expected '$target'.
  Rollback: npm install -g $Package@<previous-version>"
}
Ok "Installed @furlpay/cli v$installed"

if ($env:PATH -split ";" -notcontains $prefix) {
  Warn "npm prefix '$prefix' is not on PATH. Add it via Settings > Environment Variables, then reopen the terminal."
} else {
  Ok "On PATH: $prefix"
}

Write-Host ""
Ok "Try it:  furlpay --version   /  furlpay --help   /  furlpay doctor"
Info "Updates: furlpay update --check   (or: furlpay update)"
Info "Docs:    $RepoUrl#readme"

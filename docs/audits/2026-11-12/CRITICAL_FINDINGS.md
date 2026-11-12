# Critical & High Findings — Second Pass (2026-11-12)

Format per finding: ID · severity · CWE · location · root cause · exploit
preconditions · PoC · impact · status (VERIFIED / FIXED+REGRESSION-TESTED /
IMPLEMENTED-UNVERIFIED / TRACKED / DOCUMENTED LIMITATION) · remaining risk.

---

## A-1 · CRITICAL · CWE-862 · Fabricated AP2 mandate authorized autonomous settlement
- **Location:** webapp `apps/web/src/app/api/v1/pay/execute/route.ts` (old §5); CLI `lib/mcp.js` (old description), `lib/payTui.js`.
- **Root cause:** mandate "validation" was `/^(cpm|intm)_[a-zA-Z0-9_-]{16,64}$/` — identical regex on client and server. Nothing verified a signature, issuer, audience, expiry, amount, recipient, asset/chain, nonce or single-use.
- **Preconditions:** any authenticated session — a device-authorized CLI token, an MCP tool call holding the user's cookie, or direct HTTP from a compromised local process. No other privileges.
- **PoC (executed as a regression test):** POST `/api/v1/pay/execute` with a valid signed quote and `mandateId: "cpm_forged_by_compromised_agent"` → old behavior: transfer settled (`status: "completed"`). New behavior: `202 {status: "requires_approval", reason: "mandate_present"}` and `settleTransferAtomic` provably never invoked (`agentGate.spec.ts`, 8 tests).
- **Impact:** full autonomous drain of the user's own A2A balance up to the $100k approval threshold, per transfer, unbounded frequency.
- **Status:** **FIXED + REGRESSION-TESTED** (server-side gate; every entry point converges on the route).
- **Remaining risk:** the human who approves a parked transfer relies on the recorded metadata; approval-UI attestation (M-1) is TRACKED. Real mandate verification for the personal rail requires a mandate store — roadmap.

## A-2 · CRITICAL · CWE-214 · Private key material accepted via argv
- **Location:** `src/cli.ts` (`wallet import --secret-key/--password`), `lib/commands.js` (`login --key sk_...`).
- **Root cause:** argv is exposed to every local process via the process table, persists in shell history, and is reproduced verbatim in crash reports.
- **PoC:** `ps -ef | grep furlpay` (or PowerShell `Get-CimInstance Win32_Process`) while `furlpay wallet import --secret-key S…` runs — the key is readable by any local user/process.
- **Impact:** full key compromise by any co-tenant process; shell history leaks the key to backups/sync.
- **Status:** **FIXED + REGRESSION-TESTED** (usage text + code paths): `wallet import` reads TWO stdin lines (key, password) and never argv; `login --key` rejects an argv value outright and reads stdin.
- **Remaining risk:** a TTY user typing at an echoed prompt is shoulder-surfable; piping is the documented path.

## A-3 · HIGH · CWE-367/CWE-708 · Config write corruption & symlink planting
- **Location:** `lib/util.js saveConfig` (old: in-place `writeFileSync`).
- **Root cause:** non-atomic in-place write corrupts `config.json` on crash or two concurrent CLI processes; nothing refused a symlink planted at the path (read would follow it; a rename would clobber the link's owner's target).
- **PoC:** two `furlpay login` processes racing historically truncated the file; `fs.symlinkSync(victim, CONFIG_PATH)` followed by any config write previously wrote through/over the link without refusal.
- **Impact:** session loss (DoS on the CLI) and, with a planted link, writes steered by a local attacker.
- **Status:** **FIXED + REGRESSION-TESTED** — temp+fsync+rename atomic write in the same directory, explicit symlink refusal, temp cleanup; `test/hardening.test.js` (5 tests) pins round-trip, no-temp-leftovers, symlink refusal, victim integrity.
- **Note (disclosed):** during the audit, two functional probes of `saveConfig` overwrote the operator's real `~/.furlpay/config.json` because the probe overrode `HOME` but not `USERPROFILE` (Windows `os.homedir()` reads USERPROFILE). Content lost: at most an expired dev sandbox session cookie and env preference. The file was restored to a fresh state; no server-side or financial state was affected. Tests now override both variables.

## A-4 · HIGH · CWE-1236 · CSV formula injection across every listing export
- **Location:** `lib/output.js csvEscape` (old).
- **Root cause:** only `"`, `,`, `\n` were escaped; cells beginning `=`, `+`, `-`, `@`, tab, CR executed as formulas in Excel/Sheets.
- **PoC:** counterparty name `=HYPERLINK("http://evil","Payment received")` exported via `--output csv` executes on open.
- **Status:** **FIXED** (leading `=+/−@`, tab, CR neutralized with an apostrophe).

## A-5 · HIGH · CWE-150 · Terminal/CSV injection on approval & payment screens
- **Location:** `lib/output.js table()` (SGR-only width accounting), `lib/commands.js approvals show` / `payments show`, `lib/payTui.js sanitizeTerminalText` (let `\r\n\t` through).
- **Root cause:** API/agent-controlled strings (recipient, requester, reason, memo) reached the terminal raw — the approval screen a human reads before typing APPROVE was injectable.
- **Status:** **FIXED** — central sanitize in `table()`, explicit sanitize on both screens, `\r\n\t`→space in payTui.
- **Remaining risk:** `dashboard.js` and some `commands.js` free-form prints still render selected fields raw — TRACKED (sweep list in AUTHORIZATION_BYPASS_MATRIX companion notes); JSON output verified structurally safe (JSON.stringify).

## A-6 · HIGH · CWE-829 · Unpinned supply-chain artifacts in CI
- **Location:** `.github/workflows/publish-mcp.yml` (curl of `releases/latest` binary piped to execution with `id-token: write`), both workflows (tag-pinned actions).
- **Status:** **FIXED** — publisher pinned to `v1.8.9`; `actions/checkout@11d5960a…` and `actions/setup-node@49933ea5…` SHA-pinned (tags recorded in comments).

## A-7 · HIGH · CWE-1104 · 3 npm high advisories via stellar-sdk transitive deps
- **Location:** `@stellar/stellar-sdk@15.1.0` → axios 1.15.0 (auth bypass, SSRF bypasses, CRLF, response tampering), toml ≤5 (prototype pollution).
- **Precondition:** attacker-controlled input reaching the SDK's Horizon/TOML paths. The CLI's own transport is zero-dep; Hyperliquid paths do not use axios.
- **Status:** **TRACKED** — `npm audit fix --force` means a breaking major (stellar-sdk 17); scheduled as its own change with full regression. Not masked, not excluded.

## Verified-safe verdicts (no fix needed)
- **Hyperliquid duplicate-order-after-timeout:** no retry loop exists; timeout surfaces as an error. Same-ms nonce collision rejects server-side (failure-safe). Documented limitation: a human re-running a timed-out command must check `/api/v1` state — output already tells them the request MAY have landed.
- **Redirect-based credential leakage:** raw `node:http` never follows redirects; the device URL allowlist rejects non-furlpay hosts pre-spawn.
- **Device races:** single-winner redemption proven by 8-way concurrent poll test; concurrent cross-account approvals bind exactly one owner.

# Troubleshooting

Every error the CLI refuses with is a designed signal, not a bug to work
around. Grouped by what you were trying to do. Exit codes: `0` success;
non-zero refusal (per-command codes where documented, e.g. `tx verify`
semantics or the MCP execution-mode exit 47).

## Install & update

| Symptom | Cause | Fix |
|---|---|---|
| `furlpay: command not found` | npm global bin not on PATH | `npm config get prefix` → add its bin to PATH, or reinstall with the installer script |
| Install script warns about mirrors | unofficial registry override | remove the mirror from `.npmrc`; the script warns rather than proceeding silently |
| `furlpay update` stalls | npm global permissions | use the installer script (never sudo) or `npm config set prefix` to a user-writable path |

## Authentication & credentials

| Symptom | Cause | Fix |
|---|---|---|
| Device login URL doesn't open | headless box | set `FURLPAY_NO_BROWSER=1` and open the printed URL anywhere |
| `login --key` refused | secret on argv | pipe it: `printf '%s' "$KEY" | furlpay login --key` (stdin only, by design) |
| Hosted commands 401 | expired session cookie | `furlpay login` again; the cookie only attaches to furlpay.com over TLS/loopback — check `--api-base` if you overrode it |
| `credential-less request` warning | `--api-base` pointed at a non-FurlPay host | by design: cookies never leave the furlpay.com/loopback boundary |

## Wallets & signing

| Symptom | Cause | Fix |
|---|---|---|
| Ledger probe finds nothing | app not open / USB HID permissions | open the Stellar app on the device; on Linux check udev rules |
| "Fail closed without signer" on HLP/perps | no signer configured | export `HYPERLIQUID_PRIVATE_KEY` (or `ETH_PRIVATE_KEY`) — there is deliberately no simulated fallback |
| Order refused: `LIVE_EXECUTION_DISABLED` | `FURLPAY_LIVE` master gate | set `FURLPAY_LIVE=1` **and** have the per-surface credential; the gate is on top of, not instead of, credentials |
| Order refused by risk engine | margin/notional/turnover/peg guard | read the reason field: peg halts carry `PEG_FEED_UNAVAILABLE` when the feed (not the peg) is the problem |

## MCP agents

| Symptom | Cause | Fix |
|---|---|---|
| `EXECUTION_MODE_REQUIRED` | read-only default | this is the designed default; add `--enable-execution` + a policy **only** if you intend value movement |
| Server exits 47 on `--enable-execution` | no agent policy on disk | run `furlpay wallet agent-keygen` first (recipe 8) |
| `TWO_PHASE_REQUIRED` | mutating tool called directly | preview via `furlpay_preview_execution`, then `furlpay_confirm_execution {executionHash}` |
| Confirm fails after 10 min | preview TTL expired | re-preview; hashes are single-use by design |
| Tool missing from tools/list | it is value-moving and you are read-only | structural absence — see [MCP tools](/reference/mcp-tools) |

## Network surfaces

| Symptom | Cause | Fix |
|---|---|---|
| `tx verify` returns `UNAVAILABLE` | Horizon outage | an outage is never evidence about the transaction; retry later |
| `solana` commands fail with `SOLANA_RPC_INSECURE_URL` | non-https RPC | use https endpoints only |
| `INVALID_SOLANA_ADDRESS` | not base58 (0/O/I/l present, wrong length) | validate the address before the call |
| Oracle `DISAGREEMENT` (exit 1) | sources differ beyond the asset budget | inspect the printed per-source readings; the CLI refuses to blend disagreeing prices |
| Oracle `UNAVAILABLE` (exit 2) | no source answered sanely | check network/egress; nothing is guessed — that is the point |
| Pyth provider listed `(none)` | public Hermes is auth-gated | configure `FURLPAY_PYTH_HERMES_URL` + `FURLPAY_PYTH_FEED_IDS` with a gateway you are authorized to use |
| Binance orders refused | missing consent (no `--wallet`, non-interactive, no `--yes`) | pass `--wallet <agent>` (mandate gate) or run interactively and confirm |

## Diagnostics

| Symptom | Cause | Fix |
|---|---|---|
| `config validate` fails on passphrase | edited network profile | passphrases must match the canonical values; restore from defaults |
| `doctor` exits non-zero | API liveness check failed | follow its report; `--output json` for scripts |
| keystore errors mention locks | concurrent CLI processes | the write path is atomic + locked; retry — never delete `~/.furlpay` to "fix" a lock |

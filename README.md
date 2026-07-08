# @furlpay/cli

FurlPay from your terminal: stablecoin balances and transfers, token swaps, fractional stock trading, hotel & flight booking, Visa card controls, USDC yield, webhook tooling — plus an interactive dashboard and an MCP server mode for AI agents.

[![npm](https://img.shields.io/npm/v/%40furlpay%2Fcli?logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@furlpay/cli)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![JavaScript](https://img.shields.io/badge/JavaScript-CommonJS-F7DF1E?logo=javascript&logoColor=black)](bin/furlpay.js)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen?logo=npm&logoColor=white)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server_mode-6E56CF?logo=anthropic&logoColor=white)](#mcp-server-ai-agents)
[![USDC](https://img.shields.io/badge/USDC-Arbitrum_One-2775CA?logo=ethereum&logoColor=white)](https://furlpay.com)
[![License](https://img.shields.io/badge/license-MIT-blue)](../../LICENSE)

Zero dependencies. `npx @furlpay/cli` starts instantly.

**Tech stack:** pure Node.js (`http`/`https`, `readline`, `crypto` — no runtime packages), hand-rolled ANSI TUI, newline-delimited JSON-RPC 2.0 for the MCP transport, HMAC-SHA256 webhook signing.

```bash
npm install -g @furlpay/cli
furlpay login          # email OTP → session
furlpay dashboard      # interactive TUI
```

## Commands

### Auth & config

```bash
furlpay login                    # email one-time-code login
furlpay login --key sk_sandbox…  # or store an API/webhook key (dev tooling)
furlpay whoami                   # who am I + environment
furlpay logout
furlpay env sandbox|live         # switch environments (sandbox → localhost:8787)
furlpay config set sandboxUrl http://localhost:3000
furlpay status                   # API + every settlement chain's health
```

### Wallet & payments

```bash
furlpay balance [--chain base] [--output json|csv] [--quiet]
furlpay wallet address           # Safe smart account + active modules
furlpay send 25 0xAbc… --token USDC --chain arbitrum   # gas-sponsored; --mfa for ≥$5k
furlpay swap USDT USDC 100 [--to-chain base] [--quote-only]
furlpay bridge 100 --from ethereum --to arbitrum       # CCTP-style route
furlpay tx list [--category swap]
furlpay tx 0xhash…               # on-chain lookup with explorer link
```

### Investing

```bash
furlpay invest buy AAPL 50                 # $50 notional (fractional)
furlpay invest sell NVDA 2 --qty           # 2 shares
furlpay invest buy TSLA 100 --type limit --limit-price 380
furlpay invest portfolio                   # holdings + P&L, marked to live quotes
furlpay invest quote AAPL                  # live quote + AI digest + your position
furlpay invest dca create AAPL 50 --cadence week
furlpay market                             # indices + top movers
```

### Travel · Cards · Earn

```bash
furlpay travel search --city Tokyo --checkin 2026-08-01 --checkout 2026-08-05 --min-stars 4
furlpay travel flights --from JFK --to NRT --date 2026-08-01
furlpay travel book --amount 450 --name "Park Hyatt" --city Tokyo   # USDC via x402 + cashback
furlpay travel bookings · furlpay travel cancel <id>

furlpay card list · create --type virtual · freeze <id> · unfreeze <id>
furlpay card limits <id> --daily 6000 · card transactions <id>

furlpay earn                     # positions, yield, best APY
furlpay earn apy                 # live Morpho vault APY/TVL table
furlpay earn deposit 500 · earn withdraw 200 · earn history
```

### Developer tools

```bash
furlpay listen --forward-to localhost:3000/api/webhooks   # webhook forwarding
furlpay trigger card.transaction.authorized               # signed test events
furlpay events · furlpay logs --tail
furlpay api GET /api/markets/movers                        # raw authenticated calls
furlpay api POST /api/swaps --data '{"fromToken":"USDT","toToken":"USDC","amountIn":10}'
furlpay docs [topic]                                       # docs map + browser
furlpay completion bash|zsh|fish|powershell
```

### MCP server (AI agents)

```bash
furlpay mcp     # stdio MCP server — 18 tools
```

Register in Claude Code / any MCP client:

```json
{ "mcpServers": { "furlpay": { "command": "furlpay", "args": ["mcp"] } } }
```

Tools include `get_balance`, `send_stablecoin`, `swap_tokens`, `get_portfolio`, `place_order`, `get_quote`, `search_travel`, `book_travel`, `earn_deposit`, `set_card_controls`, `chain_status` and more. Auth reuses the `furlpay login` session; public tools (markets, chain, travel search) work logged out.

### Dashboard

```bash
furlpay dashboard                # balances · portfolio · earn · transactions
furlpay dashboard --portfolio    # start on the portfolio view
```

Keyboard: `h` home · `p` portfolio · `e` earn · `t` transactions · `m` markets · `r` refresh · `q` quit. Auto-refreshes every 20s.

## Output formats

Every listing command supports `--output json|csv|table` (default table) and `--quiet` (raw values, one per line — for scripts). Mutating commands prompt for confirmation; pass `--yes` to skip (CI/scripts).

## Configuration

State lives in `~/.furlpay/config.json`: environment (`sandbox`/`live`), per-environment sessions, webhook forward target and signing secret. `--env`, `--api-base` override per-invocation.

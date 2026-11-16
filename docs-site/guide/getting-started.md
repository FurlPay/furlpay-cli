# Getting Started

FurlPay CLI (`@furlpay/cli`) is a high-performance terminal execution layer for stablecoin payments, tokenized securities, decentralized perps and autonomous agent trading. It is **non-custodial**: private keys are generated, stored and used locally — the CLI never transmits key material anywhere.

::: warning What is live vs. simulated
Every execution surface in this CLI is **labeled at runtime**. Hyperliquid perp execution, HLP vault transfers, transaction verification and the testnet faucet are live. Stellar SDEX order flow, Soroban swaps, x402 settlement and MCP balance queries are **clearly-labeled local simulations** in this build. The [Honesty Matrix](/reference/honesty-matrix) is the authoritative table.
:::

## Requirements

- **Node.js ≥ 22.19.0** (npm ships with it)
- Linux, macOS, or Windows — no administrator/root privileges needed
- A terminal (any)

Check your version:

```bash
node --version
```

## Install

```bash
npm install -g @furlpay/cli
furlpay --version
```

Other vectors — curl/PowerShell one-liners, `npx`, offline tarballs with checksums and SBOMs, and self-update — are covered in [Installation](/guide/installation).

## Your first five commands

```bash
# 1. Install diagnostics: install method, registry, config, connectivity
furlpay doctor

# 2. Look at the local configuration and validate its security bounds
furlpay config validate

# 3. Live market data from Hyperliquid validators
furlpay hyperliquid status
furlpay market BTC

# 4. Verify a real transaction on Stellar mainnet (a documented example hash)
furlpay tx verify 37ccb558c42b9386c91a7895e54d3da92ddf3e09cb46d5119be0eb4cf49679e4 --network mainnet

# 5. The offline reference preview of a payment — zero network calls, zero execution
furlpay pay --demo
```

## Mental model

The CLI is split into two planes that never share secrets:

| Plane | What it does | What it holds |
|---|---|---|
| **Identity** (`furlpay login`, `whoami`) | Authenticates you to the web dashboard, reads balances and history | A read-only session cookie |
| **Execution** (trading, payments, wallets) | Signs orders and transfers **locally** | Private keys in hardware, extensions, or the encrypted keystore |

A stolen web session cannot move funds; a stolen exchange API key cannot withdraw. See the [Security Model](/reference/security).

## Where your data lives

Everything is under `~/.furlpay/`:

| File | Purpose |
|---|---|
| `config.json` | Environment selection, API endpoints, session cookies |
| `keystore.enc` | PBKDF2 + AES-256-GCM encrypted wallet material |
| `escrows.json` | The local escrow ledger (state machine + audit log) |
| `agent-policies/` | Autonomous agent spending policies (atomic, file-locked) |

On POSIX the directory is `0700` and files `0600`; on Windows secrets are DPAPI-sealed.

## Next steps

- [Authenticate](/guide/authentication) — `furlpay login --device`
- [Make a payment](/guide/payments) — `furlpay pay '@vendor' 250 USD`
- [Trade perps with guardrails](/guide/hyperliquid) — `furlpay trading limits --max-leverage 3`
- [Give an AI agent a spending mandate](/guide/agents) — `furlpay wallet agent-keygen`

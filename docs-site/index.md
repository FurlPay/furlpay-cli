---
layout: home

hero:
  name: "FurlPay CLI"
  text: "The non-custodial terminal for stablecoin payments and institutional trading."
  tagline: "Stellar tokenized equities & RWAs, Hyperliquid perps, Binance spot, x402 micropayments, ETSS escrow and autonomous MCP agent trading — every execution surface honestly labeled live or simulated, at runtime."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/FurlPay/furlpay-cli
    - theme: alt
      text: Honesty Matrix
      link: /reference/honesty-matrix

features:
  - icon: 💸
    title: A2A Payments
    details: Pay a verified business handle in one command. Server-bound quotes, consent-first execution, stable idempotency keys, receipts that never lie.
    link: /guide/payments
    linkText: Pay someone
  - icon: 📈
    title: Hyperliquid Perps & HLP
    details: Real EIP-712 Phantom Agent signing against Hyperliquid L1 — orders, positions, the HLP vault, and a pre-trade risk engine with a kill-switch.
    link: /guide/hyperliquid
    linkText: Trade perps
  - icon: 🏛
    title: Tokenized Stocks & RWAs
    details: "JQQQ, Securitize NVDA, Franklin Templeton FOBXX on Stellar — surfaced honestly: SEP-8 issuer authorization is never faked or simulated."
    link: /guide/rwa
    linkText: Inspect RWAs
  - icon: 🤖
    title: Autonomous MCP Agents
    details: A STDIO MCP server for Claude, Cursor and Gemini with atomic spend policies, daily caps and asset whitelists enforced under an OS file lock.
    link: /guide/agents
    linkText: Run an agent
  - icon: 🔐
    title: Hardware & Non-Custodial Custody
    details: Ledger clear-signing, Freighter/Albedo loopback bridge, PBKDF2 + AES-256-GCM keystore. Zero private key material ever leaves the machine.
    link: /guide/stellar
    linkText: Connect a wallet
  - icon: ⚖️
    title: ETSS Escrow
    details: A deterministic escrow state machine with cryptographic delivery proofs, ledger-clock timers and an immutable audit log on disk.
    link: /guide/escrow
    linkText: Escrow a delivery
---

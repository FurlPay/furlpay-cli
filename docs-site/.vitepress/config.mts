import { defineConfig } from "vitepress";

// Deployed at https://furlpay.github.io/furlpay-cli/ — the base MUST match
// the repo path or every asset URL 404s on Pages.
export default defineConfig({
  title: "FurlPay CLI",
  description:
    "Non-custodial terminal for Stellar tokenized equities & RWAs, Hyperliquid perps, Binance spot, x402 micropayments, ETSS escrow and autonomous MCP agent trading — every execution surface honestly labeled live or simulated.",
  lang: "en-US",
  base: "/furlpay-cli/",
  srcDir: ".",
  cleanUrls: true,
  ignoreDeadLinks: true,
  head: [
    ["meta", { name: "theme-color", content: "#00e6b8" }],
    ["link", { rel: "icon", type: "image/svg+xml", href: "/furlpay-cli/logo.svg" }],
  ],
  themeConfig: {
    siteTitle: "FurlPay CLI Docs",
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide/getting-started", activeMatch: "/guide/" },
      { text: "Reference", link: "/reference/cli", activeMatch: "/reference/" },
      { text: "Examples", link: "/examples/index", activeMatch: "/examples/" },
      { text: "Use Cases", link: "/use-cases", activeMatch: "/use-cases" },
      { text: "Research", link: "/research/index", activeMatch: "/research/" },
      { text: "Compliance", link: "/compliance/regulatory", activeMatch: "/compliance/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Getting Started", link: "/guide/getting-started" },
            { text: "Installation", link: "/guide/installation" },
            { text: "Authentication", link: "/guide/authentication" },
            { text: "Configuration & Diagnostics", link: "/guide/configuration" },
          ],
        },
        {
          text: "Payments & Settlement",
          items: [
            { text: "A2A Payments (furlpay pay)", link: "/guide/payments" },
            { text: "Escrow (ETSS)", link: "/guide/escrow" },
            { text: "x402 Micropayments", link: "/guide/x402" },
          ],
        },
        {
          text: "Trading",
          items: [
            { text: "Hyperliquid Perps & HLP", link: "/guide/hyperliquid" },
            { text: "Bitcoin Shorting", link: "/guide/shorting" },
            { text: "Stellar Wallets & SDEX", link: "/guide/stellar" },
            { text: "Tokenized Stocks & RWAs", link: "/guide/rwa" },
            { text: "Binance Spot", link: "/guide/binance" },
            { text: "Market Data & Microstructure", link: "/guide/market-data" },
            { text: "Quantitative Algo Engines", link: "/guide/algorithms" },
            { text: "Fork Assets & Replay Risk", link: "/guide/forks" },
          ],
        },
        {
          text: "Automation",
          items: [
            { text: "MCP AI Agents", link: "/guide/agents" },
            { text: "Platform API Integration", link: "/guide/platform-api-integration" },
          ],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "CLI Command Reference", link: "/reference/cli" },
            { text: "Command Index", link: "/reference/command-index" },
            { text: "MCP Tool Reference", link: "/reference/mcp-tools" },
            { text: "Environment Variables", link: "/reference/environment" },
            { text: "Architecture", link: "/reference/architecture" },
            { text: "Honesty Matrix", link: "/reference/honesty-matrix" },
            { text: "Security Model", link: "/reference/security" },
            { text: "Troubleshooting", link: "/reference/troubleshooting" },
          ],
        },
      ],
      "/examples/": [
        {
          text: "Examples",
          items: [
            { text: "All Recipes (index)", link: "/examples/index" },
            { text: "Setup, Wallets & Agents (1–10)", link: "/examples/setup" },
            { text: "Trading & Market Data (11–18)", link: "/examples/trading-and-data" },
            { text: "Operations & Analysis (19–30)", link: "/examples/ops-and-analysis" },
          ],
        },
      ],
      "/compliance/": [
        {
          text: "Compliance",
          items: [
            { text: "Regulatory Overview", link: "/compliance/regulatory" },
            { text: "Developer Invariants", link: "/compliance/invariants" },
          ],
        },
      ],
      "/research/": [
        {
          text: "Research",
          items: [{ text: "Research Reports Index", link: "/research/index" }],
        },
      ],
      "/use-cases": [
        {
          text: "Use Cases",
          items: [{ text: "Real-World Workflows", link: "/use-cases" }],
        },
      ],
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: { buttonText: "Search docs", buttonAriaLabel: "Search documentation" },
        },
      },
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/FurlPay/furlpay-cli" },
      { icon: "npm", link: "https://www.npmjs.com/package/@furlpay/cli" },
    ],
    outline: { level: [2, 3], label: "On this page" },
    footer: {
      message:
        "FurlPay CLI is non-custodial software. Every execution surface is labeled live or simulated at runtime.",
      copyright: "MIT © FurlPay Protocol & Systems Engineering Group",
    },
    docFooter: { prev: "Previous", next: "Next" },
    lastUpdated: { text: "Last updated" },
  },
  markdown: { lineNumbers: false },
});

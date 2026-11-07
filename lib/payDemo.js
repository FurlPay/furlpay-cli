"use strict";
// Explicit offline reference data. This module is loaded ONLY by pay --demo
// and documentation generation; it is never a fallback for an API request.
function demoQuote() {
  return {
    amount: { decimal: 10, currency: 'USD', fee: 0 },
    recipient: { handle: '@figma', displayName: 'Figma',
      bio: 'Collaborative design platform for teams to build, design, and ship products together.',
      url: 'https://figma.com/', kybStatus: 'verified', sanctionsStatus: 'clear' },
    sourceAccount: { name: 'FurlPay Inc.', type: 'Business Account',
      balanceUsd: 2842530.12, isAuthoritative: false },
    settlement: { rail: 'FurlPay Ledger', supportedChains: ['Arc', 'Solana', 'Base'],
      latency: 'Instant', frequency: 'One-time', mode: 'preview' },
  };
}
module.exports = { demoQuote };

"use strict";
const crypto = require("crypto");

// Sample event payloads the sandbox can emit / trigger.
const SAMPLES = {
  "card.transaction.authorized": {
    route: "/marqeta",
    data: { cardId: "card_virtual_1", amountUsd: 24.5, merchant: "Whole Foods Market", mcc: "5411" },
  },
  "deposit.settled": {
    route: "/bridge",
    data: { token: "USDT", amountUsd: 500 },
  },
  "transfer.credited": {
    route: "/wise",
    data: { currency: "EUR", amount: 250, usdValue: 272.5 },
  },
  "kyc.approved": {
    route: "",
    data: { inquiryId: "inq_demo", provider: "persona" },
  },
};

function buildEvent(type) {
  const sample = SAMPLES[type] || { route: "", data: {} };
  return {
    route: sample.route,
    event: {
      id: "evt_" + crypto.randomBytes(8).toString("hex"),
      type,
      created: Math.floor(Date.now() / 1000),
      data: sample.data,
    },
  };
}

module.exports = { SAMPLES, buildEvent };

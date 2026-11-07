"use strict";
// All dashboard values use the shared freshness-aware data layer.
module.exports = { run: flags => require("./watch").run(["wallet", "transactions", "chains"], flags) };

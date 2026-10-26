"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const previousHome = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-watchlist-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const util = require("../lib/util");
const api = require("../lib/api");
const commands = require("../lib/commands");

const originalApiCall = api.call;

test.afterEach(() => {
  api.call = originalApiCall;
  try {
    fs.unlinkSync(util.CONFIG_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
});

test.after(() => {
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testHome, { recursive: true, force: true });
});

async function captureOutput(run) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    await run();
    return { output: lines.join("\n"), error: null };
  } catch (error) {
    return { output: lines.join("\n"), error };
  } finally {
    console.log = originalLog;
  }
}

function quoteResponse(symbol, price, changePct, live = true) {
  return {
    asset: { symbol, name: `${symbol} Company` },
    quote: { price, changePct, live },
  };
}

test("watchlist add and remove persist normalized symbols", async () => {
  await captureOutput(() => commands.invest(["watchlist", "add", "tsla"], {}));
  await captureOutput(() => commands.invest(["watchlist", "add", "nvda"], {}));
  await captureOutput(() => commands.invest(["watchlist", "remove", "TsLa"], {}));

  assert.deepEqual(util.loadConfig().investWatchlist, ["NVDA"]);
});

test("adding an existing symbol does not create a duplicate", async () => {
  await captureOutput(() => commands.invest(["watchlist", "add", "tsla"], {}));
  await captureOutput(() => commands.invest(["watchlist", "add", "TSLA"], {}));

  assert.deepEqual(util.loadConfig().investWatchlist, ["TSLA"]);
});

test("watchlist listing fetches quotes and emits raw JSON rows", async () => {
  util.saveConfig({ investWatchlist: ["TSLA", "NVDA"] });
  const requests = [];
  api.call = async (method, route) => {
    requests.push({ method, route });
    if (route.endsWith("/TSLA")) return quoteResponse("TSLA", 250.5, 1.25);
    return quoteResponse("NVDA", 900, -0.5, false);
  };

  const { output, error } = await captureOutput(() => commands.invest(["watchlist"], { output: "json" }));

  assert.equal(error, null);
  assert.deepEqual(requests, [
    { method: "GET", route: "/api/markets/TSLA" },
    { method: "GET", route: "/api/markets/NVDA" },
  ]);
  assert.deepEqual(JSON.parse(output), [
    { symbol: "TSLA", name: "TSLA Company", price: 250.5, changePct: 1.25, live: true },
    { symbol: "NVDA", name: "NVDA Company", price: 900, changePct: -0.5, live: false },
  ]);
});

test("watchlist listing supports CSV and quiet output", async () => {
  util.saveConfig({ investWatchlist: ["TSLA"] });
  api.call = async () => quoteResponse("TSLA", 250.5, 1.25);

  const csv = await captureOutput(() => commands.invest(["watchlist"], { output: "csv" }));
  const quiet = await captureOutput(() => commands.invest(["watchlist"], { quiet: true }));

  assert.equal(csv.output, "Symbol,Name,Price,Today,Live\nTSLA,TSLA Company,250.5,1.25,true");
  assert.equal(quiet.output, "TSLA");
});

test("an empty watchlist returns an empty JSON array without requesting quotes", async () => {
  util.saveConfig({});
  let requests = 0;
  api.call = async () => {
    requests++;
    return quoteResponse("TSLA", 250.5, 1.25);
  };

  const { output, error } = await captureOutput(() => commands.invest(["watchlist"], { output: "json" }));

  assert.equal(error, null);
  assert.equal(output, "[]");
  assert.equal(requests, 0);
});

test("quote failures propagate without rendering partial results", async () => {
  util.saveConfig({ investWatchlist: ["TSLA"] });
  api.call = async () => {
    throw new Error("market API unavailable");
  };

  const { output, error } = await captureOutput(() => commands.invest(["watchlist"], {}));

  assert.match(error.message, /market API unavailable/);
  assert.equal(output, "");
});

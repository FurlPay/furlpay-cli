const test = require("node:test");
const assert = require("node:assert/strict");

const {
  visibleLength,
  pad,
  csv,
  sparkline,
  table,
} = require("../lib/output");

const { c } = require("../lib/util");

// visibleLength

test("visibleLength ignores ANSI escape sequences", () => {
  const colored = c.green("Hello");

  assert.equal(visibleLength(colored), 5);
});

// pad

test("pad left aligns text", () => {
  assert.equal(pad("ABC", 5), "ABC  ");
});

test("pad right aligns text", () => {
  assert.equal(pad("ABC", 5, "right"), "  ABC");
});

test("pad correctly handles ANSI-colored text", () => {
  const colored = c.green("ABC");

  assert.equal(visibleLength(pad(colored, 5)), 5);
});

// csv

test("csv correctly escapes comma, quotes and newlines together", () => {
  const rows = [
    {
      name: 'Hello, "World"\nNext Line',
    },
  ];

  const cols = [
    {
      key: "name",
      label: "Name",
    },
  ];

  const output = csv(rows, cols);

 assert.ok(
  output.includes('"Hello, ""World""\nNext Line"')
);
});

test("csv strips ANSI escape sequences", () => {
  const rows = [
    {
      name: c.green("USDC"),
    },
  ];

  const cols = [
    {
      key: "name",
      label: "Name",
    },
  ];

  const output = csv(rows, cols);

  assert.ok(output.includes("USDC"));
  assert.ok(!output.includes("\x1b"));
});

// sparkline

test("sparkline returns an empty string for empty input", () => {
  assert.equal(sparkline([]), "");
});

test("sparkline preserves current behavior for a single value", () => {
  assert.equal(sparkline([5]), "▁");
});

test("sparkline normalizes values across the full range", () => {
  const result = sparkline([1, 2, 3, 4, 5]);

  assert.equal(result.length, 5);
  assert.equal(result[0], "▁");
  assert.equal(result[result.length - 1], "█");
});

// table
test("table renders headers", () => {
  const rows = [
    { asset: "USDC", amount: "100" },
  ];

  const cols = [
    { key: "asset", label: "Asset" },
    { key: "amount", label: "Amount", align: "right" },
  ];

  const output = table(rows, cols);

  assert.ok(output.includes("Asset"));
  assert.ok(output.includes("Amount"));
});

test("table correctly aligns ANSI-colored cells", () => {
  const rows = [
    {
      asset: c.green("USDC"),
      amount: "100",
    },
    {
      asset: c.red("ETH"),
      amount: "200",
    },
  ];

  const cols = [
    { key: "asset", label: "Asset" },
    { key: "amount", label: "Amount" },
  ];

  const output = table(rows, cols);

 const dataRows = output
  .split("\n")
  .filter((line)=> line.startsWith("│"));

assert.equal(
  visibleLength(dataRows[1]),
  visibleLength(dataRows[2])
);

assert.ok(output.includes(c.green("USDC")));
assert.ok(output.includes(c.red("ETH")));
});

test("table renders box drawing borders", () => {
  const rows = [
    { asset: "USDC" },
  ];

  const cols = [
    { key: "asset", label: "Asset" },
  ];

  const output = table(rows, cols);

  assert.ok(output.includes("┌"));
  assert.ok(output.includes("┐"));
  assert.ok(output.includes("└"));
  assert.ok(output.includes("┘"));
});
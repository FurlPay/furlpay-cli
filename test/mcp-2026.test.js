const test = require("node:test");
const assert = require("node:assert");
const { TOOLS } = require("../lib/mcp");
const { McpStdioServer } = require("../dist/mcp/server");

test("MCP 2026 Specification: Mutating tools declare anthropic/requiresUserInteraction", () => {
  const mutatingToolNames = [
    "furlpay_pay",
    "send_stablecoin",
    "place_order",
    "book_travel",
    "earn_deposit",
  ];

  for (const name of mutatingToolNames) {
    const tool = TOOLS.find((t) => t.name === name);
    assert(tool, `Mutating tool ${name} must exist in MCP registry`);
    assert(tool._meta, `Tool ${name} must declare _meta object`);
    assert.strictEqual(
      tool._meta["anthropic/requiresUserInteraction"],
      true,
      `Tool ${name} MUST mandate explicit human interactive approval via anthropic/requiresUserInteraction: true`
    );
    assert.strictEqual(
      tool.annotations?.destructiveHint,
      true,
      `Tool ${name} MUST have destructiveHint: true in annotations`
    );
  }
});

test("MCP 2026 Specification: Read-only tools do not mandate human interaction", () => {
  const readOnlyToolNames = [
    "get_balance",
    "get_net_worth",
    "get_portfolio",
    "get_quote",
    "list_transactions",
  ];

  for (const name of readOnlyToolNames) {
    const tool = TOOLS.find((t) => t.name === name);
    assert(tool, `Read-only tool ${name} must exist in MCP registry`);
    assert(
      !tool._meta || !tool._meta["anthropic/requiresUserInteraction"],
      `Read-only tool ${name} must NOT block automated agent read execution`
    );
  }
});

test("MCP 2026 Specification: TypeScript McpStdioServer enforces requiresUserInteraction", () => {
  const server = new McpStdioServer("test-agent");
  const toolDefs = server.getToolDefinitions();

  assert(toolDefs.length >= 18, `Server must expose at least 18 tools, got ${toolDefs.length}`);

  const sensitiveTools = [
    "furlpay_trade",
    "furlpay_trade_perp",
    "furlpay_execute_trade",
    "furlpay_cancel_order",
    "furlpay_emergency_stop",
    "furlpay_pay",
  ];

  for (const name of sensitiveTools) {
    const def = toolDefs.find((t) => t.name === name);
    assert(def, `Tool ${name} must be registered in McpStdioServer`);
    assert.strictEqual(
      def._meta?.["anthropic/requiresUserInteraction"],
      true,
      `TypeScript MCP Tool ${name} MUST declare anthropic/requiresUserInteraction: true`
    );
  }
});

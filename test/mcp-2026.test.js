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
  // P7: the DEFAULT server is read-only — sensitive tools are structurally
  // ABSENT, not merely annotated. They exist only in an explicit
  // execution-mode server, where they keep the interaction mandate.
  const server = new McpStdioServer("test-agent");
  const defaultNames = server.getToolDefinitions().map((t) => t.name);
  assert(defaultNames.length >= 18, `Server must expose at least 18 tools, got ${defaultNames.length}`);

  const sensitiveTools = [
    "furlpay_trade",
    "furlpay_trade_perp",
    "furlpay_execute_trade",
    "furlpay_cancel_order",
    "furlpay_emergency_stop",
    "furlpay_pay",
  ];
  for (const name of sensitiveTools) {
    assert(!defaultNames.includes(name), `Tool ${name} must be ABSENT from the default read-only server (P7)`);
  }

  // Execution mode: the tools exist and still mandate human interaction.
  const execServer = new McpStdioServer("test-agent", { mode: "execution" });
  const execDefs = execServer.getToolDefinitions();
  for (const name of sensitiveTools) {
    const def = execDefs.find((t) => t.name === name);
    assert(def, `Tool ${name} must be registered in an execution-mode McpStdioServer`);
    assert.strictEqual(
      def._meta?.["anthropic/requiresUserInteraction"],
      true,
      `TypeScript MCP Tool ${name} MUST declare anthropic/requiresUserInteraction: true`
    );
  }
});

test("P23: MCP finance surface is inspection-only — no approve/create/limit/settle tool exists", () => {
  const server = new McpStdioServer("test-agent");
  const toolDefs = server.getToolDefinitions();
  // P23 scope: the FINANCE money-authorization surface (approval engine,
    // orchestrator, spend controls) is CLI-human-only. The x402 challenge
    // tool (furlpay_settle_invoice) is a separate execution surface gated by
    // agent policy — its further restriction is P7's job, not this guard's.
    const FORBIDDEN = ["approve", "approval", "create_payment", "set_limit", "confirm", "cancel_payment"];
  for (const def of toolDefs) {
    const n = def.name.toLowerCase();
    for (const bad of FORBIDDEN) {
      assert(
        !n.includes(bad),
        `MCP tool ${def.name} must NOT exist — money-authorization verbs belong to the human CLI, never the agent surface (P23)`
      );
    }
  }
  // The finance tools that DO exist are read-only by annotation and honest about it.
  const financeTools = toolDefs.filter((t) => t.name.startsWith("furlpay_finance"));
  assert(financeTools.length >= 5, `finance inspection tools should exist (got ${financeTools.length})`);
  for (const t of financeTools) {
    assert.strictEqual(
      t.annotations?.readOnlyHint ?? true,
      true,
      `Finance tool ${t.name} must be readOnlyHint (or omit destructive hints)`
    );
  }
});

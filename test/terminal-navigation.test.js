const test = require("node:test");
const assert = require("node:assert");
const { FurlPayInteractiveTerminal } = require("../dist/tui/interactive-terminal");
const { furlPayStore } = require("../dist/tui/store/furlpay-store");

test("Terminal Navigation: Arrow keys move market selection dynamically", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });
  terminal.switchScreen("markets");

  const initialIndex = terminal.getSelectedMarketIndex();
  assert.strictEqual(initialIndex, 0);

  // Simulate Down arrow
  terminal.handleKey("\u001b[B");
  assert.strictEqual(terminal.getSelectedMarketIndex(), 1, "Down arrow must advance index to 1");

  // Simulate Down arrow again
  terminal.handleKey("\u001b[B");
  assert.strictEqual(terminal.getSelectedMarketIndex(), 2, "Down arrow must advance index to 2");

  // Simulate Up arrow
  terminal.handleKey("\u001b[A");
  assert.strictEqual(terminal.getSelectedMarketIndex(), 1, "Up arrow must return index to 1");
});

test("Terminal Navigation: Enter key selects active market without restart", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });
  terminal.switchScreen("markets");

  // Select 4th market (e.g. SOL)
  terminal.handleKey("\u001b[B"); // 1
  terminal.handleKey("\u001b[B"); // 2
  terminal.handleKey("\u001b[B"); // 3

  // Press Enter
  terminal.handleKey("\r");

  assert.strictEqual(terminal.getCurrentScreen(), "dashboard", "Enter on market must return to dashboard");
  assert.strictEqual(terminal.getActiveMarket(), "SOL", "Active market must switch to SOL");
  assert.strictEqual(furlPayStore.getState().activeSymbol, "SOL", "Shared state bus must synchronize to SOL");
});

test("Terminal Navigation: Shift+Tab cycles permission modes", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });

  assert.strictEqual(terminal.getPermissionMode(), "manual");

  // Shift+Tab -> Auto
  terminal.handleKey("\u001b[Z");
  assert.strictEqual(terminal.getPermissionMode(), "auto");

  // Shift+Tab -> Simulate
  terminal.handleKey("\u001b[Z");
  assert.strictEqual(terminal.getPermissionMode(), "simulate");

  // Shift+Tab -> Plan
  terminal.handleKey("\u001b[Z");
  assert.strictEqual(terminal.getPermissionMode(), "plan");

  // Shift+Tab -> Manual
  terminal.handleKey("\u001b[Z");
  assert.strictEqual(terminal.getPermissionMode(), "manual");
});

test("Terminal Navigation: Command Palette (/) opens and executes commands", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });
  assert.strictEqual(terminal.getCurrentScreen(), "dashboard");

  // Trigger command palette
  terminal.handleKey("/");
  const frameWithPalette = terminal.renderFrame();
  assert(frameWithPalette.includes("COMMAND PALETTE"), "Frame must display Command Palette overlay");

  // Press Enter on first command (/markets)
  terminal.handleKey("\r");
  assert.strictEqual(terminal.getCurrentScreen(), "markets", "Command /markets must switch screen to markets");
});

test("Terminal Navigation: Interactive Human Approval Gate [y/N] for trades", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });

  // Press 'B' to open Buy ticket preview
  terminal.handleKey("b");
  assert.strictEqual(terminal.getCurrentScreen(), "trading");

  const previewFrame = terminal.renderFrame();
  assert(previewFrame.includes("AUTHORIZE AND SUBMIT ORDER?"), "Must show approval confirmation prompt");
  assert(previewFrame.includes("[y] to confirm"), "Must require explicit human keypress");

  // Human rejects with 'n'
  terminal.handleKey("n");
  const rejectedFrame = terminal.renderFrame();
  assert(rejectedFrame.includes("rejected by user"), "Order must transition to rejected state");

  // Prepare another ticket and authorize with 'y'
  terminal.handleKey("b");
  terminal.handleKey("y");
  const confirmedFrame = terminal.renderFrame();
  assert(confirmedFrame.includes("Execution Authorized"), "Order must transition to confirmed state upon 'y'");
});

test("Terminal Navigation: Ctrl+O toggles execution transcript overlay", () => {
  const terminal = new FurlPayInteractiveTerminal({ headless: true });

  terminal.handleKey("\u000f"); // Ctrl+O
  const frameExpanded = terminal.renderFrame();
  assert(frameExpanded.includes("EXECUTION TRANSCRIPT"), "Frame must render execution transcript overlay");

  terminal.handleKey("\u000f"); // Ctrl+O again
  const frameCollapsed = terminal.renderFrame();
  assert(!frameCollapsed.includes("EXECUTION TRANSCRIPT"), "Second Ctrl+O must collapse transcript");
});

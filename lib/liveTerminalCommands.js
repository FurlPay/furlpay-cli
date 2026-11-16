"use strict";

// ---------------------------------------------------------------------------
// `furlpay live` command surface — the LIVE Hyperliquid WebSocket
// terminal. Interactive raw-mode TUI by default; `--once` renders a single
// frame snapshot for headless/CI diagnostics; `--no-connect` starts
// disconnected (frame + hotkey plumbing visible without any network).
// ---------------------------------------------------------------------------

const { LiveTerminal } = require("./liveTerminal");

function run({ args, flags }) {
  const symbol = args[0] || flags.symbol;
  if (!symbol) {
    console.error("Usage: furlpay live <SYMBOL> [--once] [--no-connect] [--width n] [--vpin-bucket <minor>]");
    console.error("                    [--gamma G --sigma S --kappa K [--inventory q]] [--funding <per8h>] [--allow-panic]");
    console.error("");
    console.error("LIVE Hyperliquid WebSocket feed (l2Book + trades) through the streaming state machines.");
    console.error("Hotkeys: [q] quit  [r] resync  [Space] panic (prints the signed kill-switch command;");
    console.log("         only spawns it with --allow-panic — that command still runs the risk engine).");
    console.error("");
    console.error("Example: furlpay live BTC --gamma 0.1 --sigma 0.02 --kappa 1.5");
    return 1;
  }

  const columns = flags.width ? Number(flags.width) : process.stdout.columns || 100;

  let terminal;
  try {
    terminal = new LiveTerminal({
      symbol,
      columns,
      allowPanic: !!flags["allow-panic"],
      vpinBucketVolume: flags["vpin-bucket"],
      gamma: flags.gamma,
      sigma: flags.sigma,
      kappa: flags.kappa,
      inventory: flags.inventory,
      fundingPer8h: flags.funding !== undefined ? Number(flags.funding) : undefined,
      connect: flags["no-connect"] ? null : LiveTerminal.connectProduction,
    });
  } catch (e) {
    console.error("FAIL-CLOSED:", e.message);
    return 1;
  }

  // --once: render the current state once and exit. No socket opened unless
  // connect would run — with --no-connect this is a pure frame check.
  if (flags.once) {
    if (!flags["no-connect"]) {
      console.error("--once requires --no-connect (a single frame cannot wait for a live push).");
      return 1;
    }
    console.log(terminal.snapshotFrame());
    return 0;
  }

  if (flags["no-connect"]) {
    console.error("--no-connect is a frame diagnostic — the interactive loop needs the live socket.");
    console.log(terminal.snapshotFrame());
    return 1;
  }

  return terminal
    .run()
    .then((result) => {
      process.stdout.write(`terminal closed (${result ? result.reason : "done"})\n`);
      return 0;
    })
    .catch((e) => {
      console.error("FAIL-CLOSED:", e.message);
      return 1;
    });
}

module.exports = { run };

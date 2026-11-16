"use strict";

// ---------------------------------------------------------------------------
// `furlpay terminal --symbol BTC` — the LIVE interactive trade terminal
// (HFT-V2 §9 P0 #1: "the single highest-leverage UX feature").
//
// LIVE data: real Hyperliquid WebSocket pushes (l2Book + trades channels)
// through the streaming engine's state machines — RollingVpin for toxicity,
// the lib/microstructure OBI + microprice gauges. Sequence discipline: an
// l2Book push whose `time` regresses poisons the frame (STALE, book frozen)
// instead of silently rendering an old book — the same rule the delta
// engine enforces, applied to HL's snapshot-style pushes.
//
// HONESTY: the terminal renders live market DATA and local analysis. It
// never places, signs or broadcasts anything: [Space] PANIC prints the exact
// signed kill-switch command, and only spawns it when --allow-panic is
// passed explicitly (the spawned command still runs behind the risk engine,
// mandate gate and kill-switch — and fails closed without a signer).
// ---------------------------------------------------------------------------

const { RollingVpin } = require("./streaming");
const { orderBookImbalance, microprice } = require("./microstructure");
const { cascadeSignal } = require("./algoQuant");

const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
const RENDER_INTERVAL_MS = 250; // 4 FPS — above human flicker perception, below CPU noise
const MAX_LOG_LINES = 40;

/** Pure frame renderer — deterministic given (state, columns). The TUI is a
 *  function of its data: the same state always renders the same frame, which
 *  is what makes the terminal testable without a socket or a TTY. */
function renderFrame(state, columns) {
  const w = Math.max(40, Math.min(200, columns || 80));
  const line = (s) => s.slice(0, w);
  const out = [];
  const rule = "─".repeat(w);

  // Header
  const src = state.connected ? `LIVE · Hyperliquid WebSocket` : state.connecting ? "CONNECTING…" : "DISCONNECTED";
  const age = state.lastMsgMsAgo === null ? "no data yet" : `${(state.lastMsgMsAgo / 1000).toFixed(1)}s since last push`;
  const staleTag = state.stale ? "  ⚠ STALE — feed regressed, book frozen pending resync" : "";
  out.push(line(`FURLPAY TERMINAL │ ${state.symbol}-PERP │ ${src} │ ${age}${staleTag}`));
  out.push(line(rule));

  // Order book (top N asks descending, spread bar, top N bids descending)
  const depth = state.book && state.book.bids.length ? state.book : null;
  if (!depth) {
    out.push(line("ORDER BOOK: waiting for the first l2Book push…"));
  } else {
    const rows = Math.max(3, Math.floor((w > 100 ? 22 : 14) / 2));
    const asks = [...depth.asks].reverse().slice(0, rows);
    const bids = depth.bids.slice(0, rows);
    const bestBid = depth.bids[0] ? BigInt(depth.bids[0].priceMinor) : null;
    const bestAsk = depth.asks[0] ? BigInt(depth.asks[0].priceMinor) : null;
    out.push(line("ORDER BOOK (L2, live)          ASKS ↑"));
    for (const l of asks) out.push(line(`  ${l.priceMinor.padStart(14)}  ${fmtSize(l.sizeMinor)}`));
    if (bestBid && bestAsk) {
      const spread = bestAsk - bestBid;
      out.push(line(`  ── spread ${spread} minor (${fmtSize(spread.toString())}) ──`));
    } else {
      out.push(line("  ── crossed/empty book ──"));
    }
    for (const l of bids) out.push(line(`  ${l.priceMinor.padStart(14)}  ${fmtSize(l.sizeMinor)}`));
    out.push(line("                                     BIDS ↓"));
  }

  // Microstructure gauges
  out.push(line(rule));
  out.push(line("MICROSTRUCTURE GAUGES (computed on the live feed)"));
  const g = state.gauges;
  out.push(line(`  OBI          : ${g.obi === null ? "unavailable" : g.obi.value.toFixed(4) + " → " + g.obi.signal}`));
  out.push(line(`  Micro-price  : ${g.micro === null ? "unavailable" : g.micro.microMinor + (g.micro.driftedBelowMid ? "  (below mid — sell pressure)" : "  (at/above mid)")}`));
  out.push(line(`  VPIN (live)  : ${g.vpin === null ? `waiting for ${state.vpinBucketVolume} minor of tape` : `${g.vpin.vpin.toFixed(4)} over ${g.vpin.buckets} buckets${g.vpin.toxic ? "  ⚠ TOXIC" : ""}`}`));
  if (state.cascade) {
    out.push(line(`  Cascade      : ${state.cascade.regime} (${state.cascade.score}/3) — analysis only, no sniping edge exists`));
  }
  if (state.reservation) {
    out.push(line(`  GLFT quotes  : bid ${state.reservation.bidMinor} / ask ${state.reservation.askMinor} (r=${state.reservation.reservationMinor})`));
  }

  // Execution log
  out.push(line(rule));
  out.push(line("EXECUTION LOG (local events, ms-stamped)"));
  const logRows = Math.max(2, Math.floor(w > 100 ? 8 : 5));
  for (const e of state.log.slice(-logRows)) out.push(line(`  ${e}`));

  // Hotkeys bar
  out.push(line(rule));
  const panicHint = state.allowPanic
    ? "[Space] PANIC → spawning kill-switch (risk-engine gated)"
    : "[Space] PANIC → prints the signed kill-switch command (pass --allow-panic to spawn it)";
  out.push(line(`[q] quit │ [r] force resync │ ${panicHint}`));
  return out.join("\n");
}

function fmtSize(minor) {
  const s = String(minor);
  return s.length > 12 ? s.slice(0, 9) + "…" : s;
}

/** The live terminal runtime. `opts.connect` is injectable for tests (same
 *  discipline as WsConnectionManager): production passes a real WebSocket
 *  factory against the Hyperliquid endpoint. */
class LiveTerminal {
  constructor(opts) {
    if (!opts.symbol) throw new Error("--symbol is required (e.g. BTC)");
    this.symbol = String(opts.symbol).toUpperCase().replace(/-PERP$/i, "");
    this.columns = opts.columns || 100;
    this.allowPanic = !!opts.allowPanic;
    this.vpinBucketVolume = String(opts.vpinBucketVolume ?? 100000000); // default 1e8 minor tape bucket
    this.connectFn = opts.connect; // async (handle) → wires handlers; injected in tests
    this.ws = null;
    this.connected = false;
    this.connecting = false;
    this.stale = false;
    this.lastMsgAt = null;
    this.lastBookTime = null;
    this.book = null; // { bids: [{priceMinor,sizeMinor}], asks: [...] }
    this.vpin = new RollingVpin(this.vpinBucketVolume, { toxicThreshold: opts.toxicThreshold ?? 0.75 });
    this.gauges = { obi: null, micro: null, vpin: null };
    this.cascade = opts.fundingPer8h !== undefined ? { regime: "NORMAL", score: 0 } : null;
    this.fundingPer8h = opts.fundingPer8h;
    this.reservation = null;
    this.glftParams = opts.gamma && opts.sigma && opts.kappa ? { gamma: Number(opts.gamma), sigma: Number(opts.sigma), kappa: Number(opts.kappa), inventory: Number(opts.inventory ?? 0) } : null;
    this.log = [];
    this.subscribed = false;
    this.renderTimer = null;
    this.write = opts.write || ((s) => process.stdout.write(s));
    this.onLog = opts.onLog || null;
  }

  logEvent(msg) {
    const stamp = new Date().toISOString().slice(11, 23);
    this.log.push(`${stamp} ${msg}`);
    if (this.log.length > MAX_LOG_LINES) this.log.shift();
    if (this.onLog) this.onLog(msg);
  }

  /** Open the socket, wire handlers, subscribe. Fail-closed without a
   *  WebSocket implementation (very old Node) — never a fake feed. */
  async open() {
    if (typeof this.connectFn !== "function") throw new Error("connect() factory is required");
    this.connecting = true;
    this.logEvent(`connecting to ${HL_WS_URL}`);
    await this.connectFn(this);
    this.connecting = false;
  }

  /** Production connect factory — real Hyperliquid WebSocket. */
  static async connectProduction(terminal) {
    if (typeof WebSocket === "undefined") {
      throw new Error("No WebSocket implementation available — Node ≥22 is required for the live terminal.");
    }
    const ws = new WebSocket(HL_WS_URL);
    terminal.ws = ws;
    ws.onopen = () => terminal.handleOpen();
    ws.onmessage = (ev) => terminal.handleMessage(String(ev.data));
    ws.onerror = () => terminal.logEvent("socket error — reconnect with [r] or restart");
    ws.onclose = () => terminal.handleClose();
  }

  handleOpen() {
    this.connected = true;
    this.logEvent("socket open — subscribing l2Book + trades");
    const sub = (t) => JSON.stringify({ method: "subscribe", subscription: { type: t, coin: this.symbol } });
    try {
      this.ws.send(sub("l2Book"));
      this.ws.send(sub("trades"));
      this.subscribed = true;
    } catch (e) {
      this.logEvent(`subscribe failed: ${e.message}`);
    }
  }

  handleClose() {
    this.connected = false;
    this.logEvent("socket closed — feed is DISCONNECTED, frames frozen (no fake data)");
  }

  /** Ingest one WS text frame. Unknown channels are ignored silently —
   *  HL pushes control-channel noise we did not subscribe to. */
  handleMessage(text) {
    this.lastMsgAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this.logEvent("non-JSON frame ignored");
      return;
    }
    if (msg.channel === "l2Book" && msg.data && msg.data.coin === this.symbol) {
      this.ingestBook(msg.data);
    } else if (msg.channel === "trades" && Array.isArray(msg.data)) {
      for (const t of msg.data) {
        if (t.coin !== this.symbol) continue;
        this.vpin.push({ sizeMinor: hlSizeToMinor(t.sz), side: t.side === "B" ? "buy" : "sell" });
      }
    }
    this.refreshGauges();
  }

  /** HL l2Book pushes carry the FULL book. Time regression poisons the
   *  frame: the book freezes (STALE) until a fresher push arrives — an old
   *  book is never rendered as if current. */
  ingestBook(data) {
    const t = Number(data.time);
    if (!Number.isFinite(t) || !Array.isArray(data.levels) || data.levels.length < 2) {
      this.logEvent("malformed l2Book push ignored");
      return;
    }
    if (this.lastBookTime !== null && t < this.lastBookTime) {
      this.stale = true;
      this.logEvent(`FEED REGRESSION: push time ${t} < last ${this.lastBookTime} — book FROZEN`);
      return;
    }
    // HL sends levels as [price, size] arrays; accept {price,size} objects too.
    const map = (levels) =>
      (levels || [])
        .map((l) => {
          const px = Array.isArray(l) ? l[0] : l.price;
          const sz = Array.isArray(l) ? l[1] : l.size;
          return { priceMinor: hlPriceToMinor(px), sizeMinor: hlSizeToMinor(sz) };
        })
        .filter((l) => l.priceMinor !== null && l.sizeMinor !== null);
    const bids = map(data.levels[0]);
    const asks = map(data.levels[1]);
    if (!bids.length || !asks.length) {
      this.logEvent("empty book side in push — ignored");
      return;
    }
    bids.sort((a, b) => (BigInt(b.priceMinor) > BigInt(a.priceMinor) ? 1 : -1));
    asks.sort((a, b) => (BigInt(a.priceMinor) > BigInt(b.priceMinor) ? 1 : -1));
    this.book = { bids: bids.slice(0, 15), asks: asks.slice(0, 15) };
    this.lastBookTime = t;
    if (this.stale) {
      this.stale = false;
      this.logEvent("fresher push received — book unfrozen");
    }
  }

  refreshGauges() {
    if (this.book) {
      const obi = orderBookImbalance(this.book, { levels: 10 });
      this.gauges.obi = obi.ok ? { value: obi.obi, signal: obi.obi < -0.65 ? "ask wall" : obi.obi > 0.65 ? "bid wall" : "balanced" } : null;
      const mp = microprice(this.book);
      this.gauges.micro = mp.ok ? { microMinor: mp.microMinor, midMinor: mp.midMinor, driftedBelowMid: BigInt(mp.microMinor) < BigInt(mp.midMinor) } : null;
      if (this.glftParams && this.gauges.micro) {
        const { glftQuotes } = require("./algoQuant");
        const g = glftQuotes({ midMinor: mp.midMinor, inventory: this.glftParams.inventory, ...this.glftParams });
        this.reservation = g.ok ? { bidMinor: g.bidMinor, askMinor: g.askMinor, reservationMinor: g.reservationMinor } : null;
      }
    }
    const v = this.vpin.verdict();
    this.gauges.vpin = v.ok ? v : null;
    if (this.fundingPer8h !== undefined && this.gauges.obi && this.gauges.vpin) {
      const cs = cascadeSignal({ fundingPer8h: this.fundingPer8h, obi: this.gauges.obi.value, vpin: this.gauges.vpin.vpin });
      if (cs.ok) this.cascade = { regime: cs.regime, score: cs.compositeScore };
    }
  }

  /** Hotkey: force re-subscribe / unfreeze (the honest version of "resync" —
   *  HL pushes full books, so a fresh subscription IS the resync). */
  resync() {
    this.logEvent("manual resync — re-subscribing channels");
    if (this.ws && this.connected) {
      try {
        this.ws.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "l2Book", coin: this.symbol } }));
        this.ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: this.symbol } }));
        this.stale = false;
      } catch (e) {
        this.logEvent(`resync failed: ${e.message}`);
      }
    } else {
      this.logEvent("resync ignored — socket not connected");
    }
  }

  /** Hotkey: PANIC. Default prints the command; --allow-panic spawns the
   *  real signed kill-switch (which still runs the risk engine and fails
   *  closed without a signer). */
  panic() {
    const cmd = `furlpay trading kill-switch --symbol ${this.symbol}`;
    if (!this.allowPanic) {
      this.logEvent(`PANIC requested — execute: ${cmd}`);
      return { spawned: false, cmd };
    }
    this.logEvent(`PANIC → spawning: ${cmd}`);
    const bin = process.argv[1];
    // require()-lazily so tests can stub the subprocess layer.
    const child = require("child_process").spawn(process.execPath, [bin, "trading", "kill-switch", "--symbol", this.symbol], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout.on("data", (d) => this.logEvent(`kill-switch: ${String(d).trim().slice(0, 80)}`));
    child.stderr.on("data", (d) => this.logEvent(`kill-switch ERR: ${String(d).trim().slice(0, 80)}`));
    child.on("close", (code) => this.logEvent(`kill-switch exited ${code}`));
    return { spawned: true, cmd };
  }

  /** Start: open socket, render loop at 4 FPS, keypress handler. */
  async run() {
    await this.open();
    this.enterAlternateScreen();
    this.renderLoop = setInterval(() => this.draw(), RENDER_INTERVAL_MS);
    this.draw();
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.attachKeys();
    });
  }

  attachKeys(stdin = process.stdin) {
    this.stdin = stdin;
    try {
      stdin.setRawMode(true);
    } catch { /* non-TTY — hotkeys unavailable, --once still works */ }
    stdin.resume();
    this.keyHandler = (key) => {
      const k = key === "\u0003" ? "ctrl-c" : key === "\u001b" ? "esc" : key === " " ? "space" : key;
      if (k === "q" || k === "ctrl-c" || k === "esc") {
        this.logEvent("quit");
        this.shutdown();
        if (this.resolveRun) this.resolveRun({ reason: "quit" });
      } else if (k === "space") {
        this.panic();
        this.draw();
      } else if (k === "r") {
        this.resync();
        this.draw();
      }
    };
    stdin.on("data", this.keyHandler);
  }

  detachKeys(stdin) {
    const target = stdin || this.stdin || process.stdin;
    target.removeListener("data", this.keyHandler);
    try {
      target.setRawMode(false);
    } catch { /* not a TTY */ }
    target.pause();
  }

  enterAlternateScreen() {
    this.write("\x1b[?1049h\x1b[H\x1b[2J"); // alt-screen, home, clear
  }

  leaveAlternateScreen() {
    this.write("\x1b[?1049l"); // back to the primary buffer — scrollback intact
  }

  draw() {
    const frame = renderFrame(this.state(), this.columns);
    this.write("\x1b[H\x1b[2J" + frame + "\n");
  }

  state() {
    return {
      symbol: this.symbol,
      connected: this.connected,
      connecting: this.connecting,
      stale: this.stale,
      lastMsgMsAgo: this.lastMsgAt === null ? null : Date.now() - this.lastMsgAt,
      book: this.book,
      gauges: this.gauges,
      cascade: this.cascade,
      reservation: this.reservation,
      vpinBucketVolume: this.vpinBucketVolume,
      log: this.log,
      allowPanic: this.allowPanic,
    };
  }

  shutdown() {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = null;
    this.detachKeys();
    if (this.ws) {
      try {
        this.ws.close();
      } catch { /* already closed */ }
    }
    this.connected = false;
    this.leaveAlternateScreen();
  }

  /** Non-interactive snapshot: fetch nothing, connect nothing — render the
   *  current in-memory state once (used by tests and --once diagnostics). */
  snapshotFrame() {
    return renderFrame(this.state(), this.columns);
  }
}

// HL sends decimal-string prices/sizes ("64821.5"). The engines run on
// integer minor. We scale by 1e5 (HL's 5-decimal tick convention) — honest
// because the terminal only ever DISPLAYS minors, and every displayed number
// is the exact scaled integer (no float rounding in the path).
const SCALE = 100000;
function hlPriceToMinor(px) {
  const n = Number(px);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(BigInt(Math.round(n * SCALE)));
}
function hlSizeToMinor(sz) {
  const n = Number(sz);
  if (!Number.isFinite(n) || n < 0) return null;
  return String(BigInt(Math.round(n * SCALE)));
}

module.exports = { LiveTerminal, renderFrame, HL_WS_URL, RENDER_INTERVAL_MS, hlPriceToMinor, hlSizeToMinor };

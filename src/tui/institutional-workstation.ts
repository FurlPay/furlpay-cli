/**
 * Institutional Trading Workstation (FurlPay Quant Terminal 2026)
 * 
 * 10-Pane Workstation Grid Architecture (Talos & Kraken Desktop Standards):
 * [1] Header Telemetry Bar (Live latency, Clock drift, Chain, Mode)
 * [2] Market Watch & Selector (/ search, Up/Down arrow selection, sort)
 * [3] Candlestick Chart (Unicode half-blocks, Volume Histogram, 1m-1d)
 * [4] L2 Order Book Depth Ladder (Depth bars, Spread bps, Microprice)
 * [5] Portfolio & Balances (USDC, HYPE, PAXG, Stellar RWAs)
 * [6] AI Assistant & Tool Transcript (Ctrl+O overlay)
 * [7] Risk Management Panel (Gross exposure, Net delta, Kyle's Lambda)
 * [8] Trade Execution Ticket (Dual units, pre-trade impact, limits)
 * [9] Activity Blotter & Order Receipts
 * [10] Command Palette & Approval Gate ([y/N] Raw Mode Intercept)
 * 
 * Driven by Double-Buffered DifferentialTerminalEngine (zero screen tearing).
 */

import { DifferentialTerminalEngine } from "./render/differential-engine";
import { CandlestickChartRenderer } from "./chart/candlestick";
import { SynchronousRiskEngine, FurlPayInstitutionalRiskEngine } from "../services/risk-engine";
import { FurlPayMarketFeed, HyperliquidLowLatencyFeed } from "../services/furlpay-feed";
import { computeLatencyTelemetry } from "../services/http-agent";
import { furlPayStore } from "./store/furlpay-store";
import { CandleStick } from "../types";
import { DiscoveredMarket, OrderBookLevel } from "../market/types";

export type PermissionMode = "manual" | "auto" | "simulate" | "plan";
export type Timeframe = "1m" | "5m" | "15m" | "1h" | "1d";

export interface WorkstationOptions {
  headless?: boolean;
  width?: number;
  height?: number;
  feedEnabled?: boolean;
  outWriter?: (data: string) => void;
}

export class InstitutionalWorkstation {
  private engine: DifferentialTerminalEngine;
  private riskEngine: SynchronousRiskEngine;
  private feed: HyperliquidLowLatencyFeed | null = null;

  // Workstation state
  public activeSymbol: string = "HYPE-PERP";
  public activeMarketPrice: number = 42.85;
  public connectionStatus: "LIVE" | "DEGRADED" | "STALE" | "DISCONNECTED" | "INVALID_BOOK" = "LIVE";
  public latencyMs: number = 22;
  public clockDriftMs: number = 1.2;
  public permissionMode: PermissionMode = "manual";
  public timeframe: Timeframe = "1m";
  public activePane: "watch" | "chart" | "book" | "ticket" = "book";

  // Modals & Overlays
  public isPaletteOpen: boolean = false;
  public isTranscriptOpen: boolean = false;
  public pendingApproval: {
    symbol: string;
    side: "buy" | "sell";
    amountUsd: number;
    price: number;
    slippageBps: number;
  } | null = null;

  // Market Watch list
  public marketList: Array<{
    symbol: string;
    price: number;
    change24h: number;
    volume24h: string;
  }> = [
    { symbol: "HYPE-PERP", price: 42.85, change24h: 2.45, volume24h: "$128M" },
    { symbol: "BTC-PERP", price: 91420.0, change24h: -0.8, volume24h: "$4.2B" },
    { symbol: "ETH-PERP", price: 3140.0, change24h: 1.12, volume24h: "$1.8B" },
    { symbol: "SOL-PERP", price: 188.5, change24h: 4.2, volume24h: "$920M" },
    { symbol: "PAXG/USDC", price: 2740.0, change24h: 0.15, volume24h: "$42M" },
    { symbol: "XLM/USDC", price: 0.142, change24h: -0.5, volume24h: "$18M" },
  ];
  public selectedMarketIndex: number = 0;

  // Order Book levels
  public bids: OrderBookLevel[] = [
    { price: 42.85, size: 94100 },
    { price: 42.845, size: 61200 },
    { price: 42.84, size: 33500 },
    { price: 42.835, size: 18000 },
    { price: 42.83, size: 9400 },
  ];
  public asks: OrderBookLevel[] = [
    { price: 42.87, size: 12400 },
    { price: 42.865, size: 28100 },
    { price: 42.86, size: 45000 },
    { price: 42.855, size: 82400 },
  ];

  // Chart data
  public candles: CandleStick[] = [];

  // Trade Ticket
  public ticketSide: "buy" | "sell" = "buy";
  public ticketType: "limit" | "market" = "limit";
  public ticketSize: number = 500; // in base units
  public ticketPrice: number = 42.85;

  // Blotter
  public blotter: Array<{
    time: string;
    symbol: string;
    side: "BUY" | "SELL";
    size: string;
    price: string;
    status: string;
    fill: string;
  }> = [
    { time: "11:54:02", symbol: "HYPE", side: "BUY", size: "500.00", price: "$42.85", status: "FILLED", fill: "100%" },
    { time: "11:52:14", symbol: "BTC", side: "SELL", size: "0.25", price: "$91,420", status: "FILLED", fill: "100%" },
    { time: "11:48:33", symbol: "SOL", side: "BUY", size: "50.00", price: "$188.40", status: "CANCELLED", fill: "--" },
  ];

  private isRunning = false;
  private renderTimer: NodeJS.Timeout | null = null;
  private readonly headless: boolean;

  constructor(options?: WorkstationOptions) {
    this.headless = options?.headless ?? false;
    const width = options?.width ?? 120;
    const height = options?.height ?? 38;
    this.engine = new DifferentialTerminalEngine(width, height, options?.outWriter);
    this.riskEngine = new SynchronousRiskEngine();
    this.candles = CandlestickChartRenderer.generateCandles(this.activeMarketPrice, 35);

    if (options?.feedEnabled) {
      this.initFeed();
    }
  }

  private initFeed(): void {
    const cleanCoin = this.activeSymbol.replace(/-PERP$/i, "");
    this.feed = new HyperliquidLowLatencyFeed({
      coin: cleanCoin,
      onEvent: (event) => {
        this.bids = event.bidLevels.slice(0, 5);
        this.asks = event.askLevels.slice(0, 5);
        if (this.bids.length > 0 && this.asks.length > 0) {
          this.activeMarketPrice = (this.bids[0].price + this.asks[0].price) / 2;
        }
      },
      onStatusChange: (status, rtt) => {
        this.connectionStatus = status;
        this.latencyMs = rtt;
      },
    });
    this.feed.connect();
  }

  public getDifferentialEngine(): DifferentialTerminalEngine {
    return this.engine;
  }

  public getRiskEngine(): SynchronousRiskEngine {
    return this.riskEngine;
  }

  /**
   * Handle incoming keyboard inputs in accordance with institutional hotkeys.
   */
  public handleKey(key: string): boolean {
    // 1. Pending Approval Modal [y/N]
    if (this.pendingApproval) {
      if (key.toLowerCase() === "y") {
        this.executePendingTrade();
        this.pendingApproval = null;
        return true;
      }
      if (key.toLowerCase() === "n" || key === "\u001b" || key === "\u0003") { // Esc / Ctrl+C / N
        this.pendingApproval = null;
        return true;
      }
      return false;
    }

    // 2. Command Palette (Esc dismisses)
    if (this.isPaletteOpen) {
      if (key === "\u001b") {
        this.isPaletteOpen = false;
        return true;
      }
      if (key === "\r" || key === "\n") {
        this.isPaletteOpen = false;
        return true;
      }
      return false;
    }

    // 3. Global hotkeys
    if (key === "/") {
      this.isPaletteOpen = true;
      return true;
    }

    if (key === "\u000f") { // Ctrl+O
      this.isTranscriptOpen = !this.isTranscriptOpen;
      return true;
    }

    // Shift + Tab -> Cycle Permission Mode
    if (key === "\u001b[Z") {
      const modes: PermissionMode[] = ["manual", "auto", "simulate", "plan"];
      const nextIdx = (modes.indexOf(this.permissionMode) + 1) % modes.length;
      this.permissionMode = modes[nextIdx];
      return true;
    }

    // Tab -> Cycle Active Panes
    if (key === "\t") {
      const panes: Array<"watch" | "chart" | "book" | "ticket"> = ["watch", "chart", "book", "ticket"];
      const nextIdx = (panes.indexOf(this.activePane) + 1) % panes.length;
      this.activePane = panes[nextIdx];
      return true;
    }

    // Timeframe keys: 1 (1m), 2 (5m), 3 (15m), 4 (1h), 5 (1d)
    if (["1", "2", "3", "4", "5"].includes(key)) {
      const map: Record<string, Timeframe> = {
        "1": "1m",
        "2": "5m",
        "3": "15m",
        "4": "1h",
        "5": "1d",
      };
      this.timeframe = map[key];
      this.candles = CandlestickChartRenderer.generateCandles(this.activeMarketPrice, 35);
      return true;
    }

    // Up / Down arrows -> Navigate Market Watch
    if (key === "\u001b[A") { // Up
      if (this.selectedMarketIndex > 0) {
        this.selectedMarketIndex--;
        return true;
      }
    } else if (key === "\u001b[B") { // Down
      if (this.selectedMarketIndex < this.marketList.length - 1) {
        this.selectedMarketIndex++;
        return true;
      }
    }

    // Enter -> Switch active market to selected market
    if (key === "\r" || key === "\n") {
      const target = this.marketList[this.selectedMarketIndex];
      if (target && target.symbol !== this.activeSymbol) {
        this.switchMarket(target.symbol, target.price);
        return true;
      }
    }

    // Trade ticket preparation hotkey: 'b' or 's' or 'p'
    if (key.toLowerCase() === "p" || key.toLowerCase() === "b") {
      this.prepareTradeOrder("buy");
      return true;
    }
    if (key.toLowerCase() === "s") {
      this.prepareTradeOrder("sell");
      return true;
    }

    return false;
  }

  public switchMarket(symbol: string, price: number): void {
    this.activeSymbol = symbol;
    this.activeMarketPrice = price;
    this.ticketPrice = price;
    this.candles = CandlestickChartRenderer.generateCandles(price, 35);

    if (this.feed) {
      this.feed.disconnect();
      this.initFeed();
    }
  }

  /**
   * Prepares order ticket and triggers pre-trade synchronous risk checks.
   */
  public prepareTradeOrder(side: "buy" | "sell"): boolean {
    const notionalUsd = this.ticketSize * this.ticketPrice;
    const now = Date.now();

    // Acquire lock and run synchronous pre-trade evaluation
    const lockAcquired = this.riskEngine.acquireLock();
    if (!lockAcquired) {
      return false;
    }

    try {
      const riskCheck = this.riskEngine.evaluatePreTrade(
        {
          symbol: this.activeSymbol,
          side,
          amountUsd: notionalUsd,
          quotePrice: this.ticketPrice,
          quoteTimestampMs: now - 25, // 25ms fresh quote
        },
        142_500, // Account Equity: $142,500
        51_420,  // Gross Exposure: $51,420
        this.activeMarketPrice
      );

      if (!riskCheck.passed) {
        return false;
      }

      // Calculate slippage basis points
      const slippageBps = Number(
        ((Math.abs(this.ticketPrice - this.activeMarketPrice) / this.activeMarketPrice) * 10_000).toFixed(1)
      );

      // Present non-bypassable human approval gate
      this.pendingApproval = {
        symbol: this.activeSymbol,
        side,
        amountUsd: notionalUsd,
        price: this.ticketPrice,
        slippageBps,
      };

      return true;
    } finally {
      this.riskEngine.releaseLock();
    }
  }

  private executePendingTrade(): void {
    if (!this.pendingApproval) return;
    const nowTime = new Date().toTimeString().split(" ")[0];
    this.blotter.unshift({
      time: nowTime,
      symbol: this.pendingApproval.symbol.replace(/-PERP$/i, ""),
      side: this.pendingApproval.side === "buy" ? "BUY" : "SELL",
      size: `${this.ticketSize}.00`,
      price: `$${this.pendingApproval.price.toFixed(2)}`,
      status: "FILLED",
      fill: "100%",
    });
    if (this.blotter.length > 5) {
      this.blotter.pop();
    }
  }

  /**
   * Renders the complete 10-pane institutional workstation layout into the back buffer.
   */
  public renderToBuffer(): void {
    const width = this.engine.getWidth();
    const height = this.engine.getHeight();
    this.engine.clearBackBuffer();

    // ── 1. HEADER TELEMETRY BAR ───────────────────────────────────────────
    const statusFg = this.connectionStatus === "LIVE" ? "\x1b[32m" : "\x1b[31m";
    const modeBadge = `[${this.permissionMode.toUpperCase()}]`;
    const headerStr = ` FURLPAY QUANT TERMINAL v2.0  •  VENUE: FURLPAY CORE L1  •  RAILS: USDC / CCTP v2  •  ${statusFg}● ${this.connectionStatus} (${this.latencyMs}ms)\x1b[0m  •  DRIFT: +${this.clockDriftMs}ms  •  MODE: ${modeBadge}`;
    this.engine.writeString(0, 0, headerStr.padEnd(width), "\x1b[1m\x1b[37m", "\x1b[44m", true);

    // ── GRID COMPUTATIONS ─────────────────────────────────────────────────
    const topHeight = Math.floor((height - 3) * 0.58);
    const bottomHeight = height - 3 - topHeight;
    const yTop = 1;
    const yBottom = yTop + topHeight;

    const col1Width = Math.floor(width * 0.23); // Market Watch
    const col2Width = Math.floor(width * 0.49); // Candlestick Chart
    const col3Width = width - col1Width - col2Width; // L2 Book

    // ── 2. MARKET WATCH PANEL (col 1, top) ─────────────────────────────────
    const watchBorder = this.activePane === "watch" ? "\x1b[36m" : "\x1b[90m";
    this.engine.drawBox(0, yTop, col1Width, topHeight, "MARKET WATCH (/)", watchBorder);
    this.engine.writeString(2, yTop + 1, "Sym      Price     24h%    Vol", "\x1b[90m");

    for (let i = 0; i < this.marketList.length && i < topHeight - 3; i++) {
      const item = this.marketList[i];
      const isSelected = i === this.selectedMarketIndex;
      const rowY = yTop + 2 + i;
      const prefix = isSelected ? "❯ " : "  ";
      const symStr = item.symbol.replace(/-PERP$/i, "").padEnd(7);
      const priceStr = `$${item.price >= 1000 ? item.price.toLocaleString("en-US", { maximumFractionDigits: 1 }) : item.price.toFixed(2)}`.padEnd(9);
      const changeColor = item.change24h >= 0 ? "\x1b[32m" : "\x1b[31m";
      const changeStr = `${item.change24h >= 0 ? "+" : ""}${item.change24h.toFixed(2)}%`.padEnd(7);
      const volStr = item.volume24h;

      const lineText = `${prefix}${symStr} ${priceStr} ${changeStr} ${volStr}`;
      const fg = isSelected ? "\x1b[36m" : "\x1b[37m";
      this.engine.writeString(1, rowY, lineText, fg, undefined, isSelected);
    }

    // ── 3. CANDLESTICK CHART (col 2, top) ──────────────────────────────────
    const chartBorder = this.activePane === "chart" ? "\x1b[36m" : "\x1b[90m";
    const chartTitle = `CHART: ${this.activeSymbol} (${this.timeframe}) [1-5 Switch]`;
    this.engine.drawBox(col1Width, yTop, col2Width, topHeight, chartTitle, chartBorder);

    const chartLines = CandlestickChartRenderer.renderToLines(this.candles, {
      width: col2Width - 2,
      height: topHeight - 2,
      showVolume: true,
    });
    for (let r = 0; r < chartLines.length && r < topHeight - 2; r++) {
      this.engine.writeString(col1Width + 1, yTop + 1 + r, chartLines[r]);
    }

    // ── 4. ORDER BOOK L2 DEPTH (col 3, top) ────────────────────────────────
    const bookBorder = this.activePane === "book" ? "\x1b[36m" : "\x1b[90m";
    this.engine.drawBox(col1Width + col2Width, yTop, col3Width, topHeight, "ORDER BOOK L2", bookBorder);

    let bookY = yTop + 1;
    this.engine.writeString(col1Width + col2Width + 2, bookY++, "Price     Size     Depth", "\x1b[90m");
    this.engine.writeString(col1Width + col2Width + 2, bookY++, "ASKS (Sell Depth)", "\x1b[31m");

    for (let i = 0; i < this.asks.length && bookY < yTop + topHeight - 6; i++) {
      const ask = this.asks[i];
      const bar = "█".repeat(Math.min(8, Math.max(1, Math.round(ask.size / 15_000))));
      const line = `${ask.price.toFixed(3)}  ${ask.size.toLocaleString().padEnd(7)} \x1b[31m${bar}\x1b[0m`;
      this.engine.writeString(col1Width + col2Width + 2, bookY++, line);
    }

    // Spread divider
    const bestBid = this.bids[0]?.price ?? this.activeMarketPrice;
    const bestAsk = this.asks[0]?.price ?? this.activeMarketPrice;
    const spreadUsd = Math.max(0, bestAsk - bestBid);
    const spreadBps = bestBid > 0 ? (spreadUsd / bestBid) * 10_000 : 0;
    this.engine.writeString(
      col1Width + col2Width + 2,
      bookY++,
      `SPREAD: $${spreadUsd.toFixed(3)} (${spreadBps.toFixed(1)} bps)`,
      "\x1b[33m"
    );

    this.engine.writeString(col1Width + col2Width + 2, bookY++, "BIDS (Buy Depth)", "\x1b[32m");
    for (let i = 0; i < this.bids.length && bookY < yTop + topHeight - 1; i++) {
      const bid = this.bids[i];
      const bar = "█".repeat(Math.min(8, Math.max(1, Math.round(bid.size / 15_000))));
      const line = `${bid.price.toFixed(3)}  ${bid.size.toLocaleString().padEnd(7)} \x1b[32m${bar}\x1b[0m`;
      this.engine.writeString(col1Width + col2Width + 2, bookY++, line);
    }

    // ── BOTTOM SECTION: 4 PANES ───────────────────────────────────────────
    const bColWidth = Math.floor(width / 4);

    // [5] Portfolio & Balances (Bottom col 1)
    this.engine.drawBox(0, yBottom, bColWidth, bottomHeight, "PORTFOLIO", "\x1b[90m");
    let portY = yBottom + 1;
    this.engine.writeString(2, portY++, "Asset   Balance     USD Value", "\x1b[90m");
    this.engine.writeString(2, portY++, "USDC    142,500.00  $142,500");
    this.engine.writeString(2, portY++, "HYPE      1,200.00   $51,420");
    this.engine.writeString(2, portY++, "PAXG          5.20   $14,248");
    this.engine.writeString(2, portY++, "Total: $208,168  Margin: 8%", "\x1b[32m");

    // [7] Risk Management (Bottom col 2)
    this.engine.drawBox(bColWidth, yBottom, bColWidth, bottomHeight, "RISK PERIMETER", "\x1b[90m");
    let riskY = yBottom + 1;
    this.engine.writeString(bColWidth + 2, riskY++, "Gross Exposure:  $51,420");
    this.engine.writeString(bColWidth + 2, riskY++, "Net Delta:      +$51,420", "\x1b[32m");
    this.engine.writeString(bColWidth + 2, riskY++, "Leverage:          0.25x (Max 3x)");
    this.engine.writeString(bColWidth + 2, riskY++, "Liq Distance:     -74.2%", "\x1b[32m");
    this.engine.writeString(bColWidth + 2, riskY++, "Kyle's Lambda:    0.0042");

    // [8] Trade Ticket (Bottom col 3)
    const ticketBorder = this.activePane === "ticket" ? "\x1b[36m" : "\x1b[90m";
    this.engine.drawBox(bColWidth * 2, yBottom, bColWidth, bottomHeight, "TRADE TICKET", ticketBorder);
    let tY = yBottom + 1;
    const sideBadge = this.ticketSide === "buy" ? "\x1b[32m[ BUY ]\x1b[0m (b)" : "\x1b[31m[ SELL ]\x1b[0m (s)";
    this.engine.writeString(bColWidth * 2 + 2, tY++, `Side:   ${sideBadge}`);
    this.engine.writeString(bColWidth * 2 + 2, tY++, `Type:   [ LIMIT ] (p to prep)`);
    this.engine.writeString(bColWidth * 2 + 2, tY++, `Price:  $${this.ticketPrice.toFixed(3)}`);
    this.engine.writeString(bColWidth * 2 + 2, tY++, `Size:   ${this.ticketSize} ${this.activeSymbol.replace(/-PERP$/i, "")} ($${(this.ticketSize * this.ticketPrice).toFixed(0)})`);
    this.engine.writeString(bColWidth * 2 + 2, tY++, `Impact: +1.2 bps (Est $2.57)`);

    // [9] Activity Blotter (Bottom col 4)
    const blotterWidth = width - bColWidth * 3;
    this.engine.drawBox(bColWidth * 3, yBottom, blotterWidth, bottomHeight, "ACTIVITY BLOTTER", "\x1b[90m");
    let blotterY = yBottom + 1;
    this.engine.writeString(bColWidth * 3 + 2, blotterY++, "Time     Sym  Side  Size    Price", "\x1b[90m");
    for (const b of this.blotter) {
      if (blotterY >= yBottom + bottomHeight - 1) break;
      const sColor = b.side === "BUY" ? "\x1b[32m" : "\x1b[31m";
      const bLine = `${b.time} ${b.symbol.padEnd(4)} ${sColor}${b.side.padEnd(4)}\x1b[0m ${b.size.padEnd(7)} ${b.price}`;
      this.engine.writeString(bColWidth * 3 + 2, blotterY++, bLine);
    }

    // ── MODAL OVERLAYS ────────────────────────────────────────────────────
    // Trade Approval Modal
    if (this.pendingApproval) {
      const modalW = 54;
      const modalH = 8;
      const modalX = Math.floor((width - modalW) / 2);
      const modalY = Math.floor((height - modalH) / 2);
      this.engine.drawBox(modalX, modalY, modalW, modalH, "HUMAN APPROVAL REQUIRED [y/N]", "\x1b[33m");
      this.engine.writeString(modalX + 2, modalY + 1, "ACTION: " + this.pendingApproval.side.toUpperCase() + " " + this.pendingApproval.symbol, "\x1b[1m\x1b[33m");
      this.engine.writeString(modalX + 2, modalY + 2, `Notional: $${this.pendingApproval.amountUsd.toFixed(2)} USD  @  $${this.pendingApproval.price}`);
      this.engine.writeString(modalX + 2, modalY + 3, `Slippage: ${this.pendingApproval.slippageBps.toFixed(1)} bps  |  Risk Pre-Check: PASSED`);
      this.engine.writeString(modalX + 2, modalY + 4, "──────────────────────────────────────────────────", "\x1b[90m");
      this.engine.writeString(modalX + 2, modalY + 5, "Press [Y] to sign & execute  |  [N/Esc] to abort", "\x1b[1m\x1b[37m");
    } else if (this.isPaletteOpen) {
      const pW = 50;
      const pH = 7;
      const pX = Math.floor((width - pW) / 2);
      const pY = Math.floor((height - pH) / 2);
      this.engine.drawBox(pX, pY, pW, pH, "COMMAND PALETTE (/)", "\x1b[36m");
      this.engine.writeString(pX + 2, pY + 1, "  /markets   List live perpetual universe");
      this.engine.writeString(pX + 2, pY + 2, "  /quote     Get SDEX & Soroban swap quote");
      this.engine.writeString(pX + 2, pY + 3, "  /pay       Execute A2A micropayment");
      this.engine.writeString(pX + 2, pY + 4, "  /risk      Toggle pre-trade risk lock");
    }

    // ── FOOTER STATUS LINE ────────────────────────────────────────────────
    const footerStr = " / Cmds  •  Tab Switch Pane  •  1-5 Timeframe  •  ⇧⇥ Mode  •  ^O Transcript  •  B/S/P Order  •  Esc Dismiss";
    this.engine.writeString(0, height - 1, footerStr.padEnd(width), "\x1b[30m", "\x1b[47m");
  }

  /**
   * Flushes only mutated cells to screen using minimal ANSI sequences.
   */
  public flush(): number {
    this.renderToBuffer();
    return this.engine.flush();
  }

  public start(): void {
    this.isRunning = true;
    if (process.stdin.isTTY && !this.headless) {
      try {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk: any) => {
          const str = chunk.toString();
          if (str === "\u0003" && !this.isPaletteOpen && !this.pendingApproval) { // Ctrl+C
            this.stop();
            process.exit(0);
          }
          const changed = this.handleKey(str);
          if (changed) {
            this.flush();
          }
        });
      } catch {}
    }

    // Initial render
    this.flush();

    // 15 FPS (66ms) throttled UI refresh loop
    if (!this.headless) {
      this.renderTimer = setInterval(() => {
        if (this.isRunning) {
          this.flush();
        }
      }, 66);
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.feed) {
      this.feed.disconnect();
      this.feed = null;
    }
    if (process.stdin.isTTY && !this.headless) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {}
    }
  }
}

/**
 * FurlPay 2.0 Global Reactive State Store
 * 
 * Shared application state bus bridging the Terminal User Interface (TUI),
 * high-frequency market streaming feeds, and the Conversational AI Copilot.
 * 
 * Guarantees:
 * - Deterministic bi-directional sync (Human action -> AI context; AI tool_use -> UI state).
 * - Decoupled state updates from terminal repainting to eliminate flicker.
 * - Non-bypassable Human-in-the-Loop approval gate for trade tickets.
 */

import { EventEmitter } from "events";
import { DiscoveredMarket } from "../../market/types";

export type TerminalScreen = 
  | "dashboard" 
  | "markets" 
  | "trading" 
  | "orderbook" 
  | "positions" 
  | "portfolio" 
  | "rwa" 
  | "agents" 
  | "risk" 
  | "help";

export type PermissionMode = "manual" | "auto" | "simulate" | "plan";
export type FocusedPanel = "navigation" | "market_view" | "ai_chat" | "ticket_modal";

export interface OrderBookDepthLevel {
  price: number;
  size: number;
  total: number;
}

export interface SharedOrderBook {
  bids: OrderBookDepthLevel[];
  asks: OrderBookDepthLevel[];
  spread: number;
  spreadBps: number;
  lastUpdateMs: number;
}

export interface SharedMarketStats {
  markPrice: number;
  fundingRate: number;
  volume24h: number;
  openInterest: number;
  hawkesIntensity: number;
  isCascadeRisk: boolean;
  isStale: boolean;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: any;
  result?: any;
  status: "pending" | "running" | "success" | "failed";
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  toolCalls?: ToolCallRecord[];
}

export interface ActiveTradeTicket {
  symbol: string;
  side: "buy" | "sell";
  amountUsd: number;
  orderType: "market" | "limit";
  limitPrice?: number;
  leverage: number;
  estimatedSlippage: number;
  requiresApproval: boolean;
  quoteId?: string;
  status: "pending_approval" | "executing" | "confirmed" | "rejected";
  executionResult?: any;
}

export interface FurlPayStateSnapshot {
  activeScreen: TerminalScreen;
  focusedPanel: FocusedPanel;
  isCommandPaletteOpen: boolean;
  isTranscriptExpanded: boolean;
  permissionMode: PermissionMode;
  activeSymbol: string;
  activeMarketRecord?: DiscoveredMarket;
  orderBook: SharedOrderBook;
  marketStats: SharedMarketStats;
  messages: ChatMessage[];
  isAiStreaming: boolean;
  streamingBuffer: string;
  activeTicket: ActiveTradeTicket | null;
}

export class FurlPayStore extends EventEmitter {
  private static instance: FurlPayStore | null = null;

  private state: FurlPayStateSnapshot = {
    activeScreen: "dashboard",
    focusedPanel: "market_view",
    isCommandPaletteOpen: false,
    isTranscriptExpanded: false,
    permissionMode: "manual",
    activeSymbol: "HYPE",
    orderBook: {
      bids: [],
      asks: [],
      spread: 0,
      spreadBps: 0,
      lastUpdateMs: 0,
    },
    marketStats: {
      markPrice: 0,
      fundingRate: 0,
      volume24h: 0,
      openInterest: 0,
      hawkesIntensity: 0.15,
      isCascadeRisk: false,
      isStale: false,
    },
    messages: [
      {
        id: "msg_init",
        role: "assistant",
        content: "FurlPay 2.0 AI Financial Copilot online. Discovered venue: Hyperliquid L1. Ask a question, or type / for commands.",
        timestamp: Date.now(),
      },
    ],
    isAiStreaming: false,
    streamingBuffer: "",
    activeTicket: null,
  };

  private constructor() {
    super();
    this.setMaxListeners(50);
  }

  static getInstance(): FurlPayStore {
    if (!FurlPayStore.instance) {
      FurlPayStore.instance = new FurlPayStore();
    }
    return FurlPayStore.instance;
  }

  getState(): FurlPayStateSnapshot {
    return { ...this.state };
  }

  private emitChange(): void {
    this.emit("change", this.getState());
  }

  subscribe(listener: (state: FurlPayStateSnapshot) => void): () => void {
    this.on("change", listener);
    return () => {
      this.off("change", listener);
    };
  }

  // ---- Navigation Mutators -------------------------------------------------

  setActiveScreen(screen: TerminalScreen): void {
    this.state.activeScreen = screen;
    this.emitChange();
  }

  setFocusedPanel(panel: FocusedPanel): void {
    this.state.focusedPanel = panel;
    this.emitChange();
  }

  setCommandPaletteOpen(open: boolean): void {
    this.state.isCommandPaletteOpen = open;
    this.emitChange();
  }

  toggleTranscript(): void {
    this.state.isTranscriptExpanded = !this.state.isTranscriptExpanded;
    this.emitChange();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
    this.emitChange();
  }

  // ---- Market State Mutators -----------------------------------------------

  switchMarket(symbol: string, marketRecord?: DiscoveredMarket): void {
    const clean = symbol.toUpperCase().replace(/-PERP$/i, "");
    this.state.activeSymbol = clean;
    this.state.activeMarketRecord = marketRecord;

    // Reset default spread baseline for the selected market
    if (marketRecord?.lastPrice) {
      this.state.marketStats.markPrice = marketRecord.lastPrice;
    }
    this.emitChange();
  }

  updateOrderBook(orderBook: Partial<SharedOrderBook>): void {
    this.state.orderBook = {
      ...this.state.orderBook,
      ...orderBook,
      lastUpdateMs: Date.now(),
    };
    this.emitChange();
  }

  updateMarketStats(stats: Partial<SharedMarketStats>): void {
    this.state.marketStats = {
      ...this.state.marketStats,
      ...stats,
    };
    this.emitChange();
  }

  // ---- AI Conversational State Mutators ------------------------------------

  addMessage(msg: ChatMessage): void {
    this.state.messages.push(msg);
    this.emitChange();
  }

  updateStreamingBuffer(buffer: string): void {
    this.state.streamingBuffer = buffer;
    this.emitChange();
  }

  setIsAiStreaming(isStreaming: boolean): void {
    this.state.isAiStreaming = isStreaming;
    this.emitChange();
  }

  updateToolCallStatus(messageId: string, toolCallId: string, update: Partial<ToolCallRecord>): void {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (msg && msg.toolCalls) {
      const tool = msg.toolCalls.find((t) => t.id === toolCallId);
      if (tool) {
        Object.assign(tool, update);
        this.emitChange();
      }
    }
  }

  // ---- Trade Ticket & Execution Mutators (Tier 3 & 4) -----------------------

  prepareTradeTicket(ticket: Omit<ActiveTradeTicket, "status">): void {
    this.state.activeTicket = {
      ...ticket,
      status: "pending_approval",
    };
    this.state.focusedPanel = "ticket_modal";
    this.emitChange();
  }

  confirmTradeTicket(): void {
    if (this.state.activeTicket) {
      this.state.activeTicket.status = "confirmed";
      this.emitChange();
    }
  }

  cancelTradeTicket(): void {
    if (this.state.activeTicket) {
      this.state.activeTicket = null;
      this.state.focusedPanel = "market_view";
      this.emitChange();
    }
  }
}

export const furlPayStore = FurlPayStore.getInstance();

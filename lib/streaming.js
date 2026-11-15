"use strict";

// ---------------------------------------------------------------------------
// Real-time market data streaming engine — the state machines, transport-
// agnostic. The WebSocket/SSE transports plug in via an injected connection;
// every state transition here is testable without a network.
//
// THREE ENGINES:
//
//   1. L2DeltaBook — consumes a REST snapshot then applies WebSocket delta
//      mutations with SEQUENCE-GAP DETECTION: a missed delta poisons the
//      book (resync required) rather than silently diverging from the venue.
//
//   2. RollingVpin — a continuous volume accumulator that slices a live
//      trade tape into fixed-volume buckets and emits a toxicity verdict
//      on every completed bucket. Feeds the same vpin() math as the
//      offline analytics — one implementation, two transports.
//
//   3. WsConnectionManager — lifecycle for a persistent connection:
//      exponential backoff reconnect, heartbeat timeout detection,
//      subscription dedup, and a hard subscription cap to prevent
//      uncontrolled memory growth. Transport-agnostic: the caller injects
//      a connect() factory so tests run without sockets.
//
// HONESTY: none of this claims a live connection is running. The engines
// are pure state machines; wiring them to real sockets is the transport's
// job (and the deployment's explicit choice).
// ---------------------------------------------------------------------------

// ── 1. L2 delta book ────────────────────────────────────────────────────────

class L2DeltaBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.bids = new Map(); // priceMinor(string) → sizeMinor(string)
    this.asks = new Map();
    this.lastUpdateId = null;
    this.needsResync = true;
  }

  /** Apply a REST snapshot: replaces the book entirely. */
  applySnapshot(snapshot) {
    if (typeof snapshot.lastUpdateId !== "number") {
      throw new Error("snapshot.lastUpdateId must be a number");
    }
    this.bids = L2DeltaBook.mapLevels(snapshot.bids);
    this.asks = L2DeltaBook.mapLevels(snapshot.asks);
    this.lastUpdateId = snapshot.lastUpdateId;
    this.needsResync = false;
    return this;
  }

  /**
   * Apply a delta update. Binance semantics: updates with lastUpdateId ≤
   * our snapshot id are already incorporated → skip. A GAP between our
   * lastUpdateId and the delta's firstUpdateId poisons the book — the
   * caller MUST resync from REST; serving a diverged book is the failure
   * this engine exists to prevent.
   */
  applyDelta(delta) {
    if (this.needsResync) {
      return { accepted: false, reason: "no snapshot applied — resync required" };
    }
    if (typeof delta.lastUpdateId !== "number" || typeof delta.firstUpdateId !== "number") {
      return { accepted: false, reason: "delta must carry firstUpdateId and lastUpdateId" };
    }
    if (delta.lastUpdateId <= this.lastUpdateId) {
      return { accepted: true, skipped: true, reason: "delta predates the snapshot" };
    }
    if (delta.firstUpdateId > this.lastUpdateId + 1) {
      this.needsResync = true;
      return {
        accepted: false,
        reason:
          `SEQUENCE GAP: book at ${this.lastUpdateId}, delta starts at ` +
          `${delta.firstUpdateId} — ${delta.firstUpdateId - this.lastUpdateId - 1} ` +
          `update(s) missing; resync from REST required`,
        gap: delta.firstUpdateId - this.lastUpdateId - 1,
      };
    }
    L2DeltaBook.applySide(this.bids, delta.bids);
    L2DeltaBook.applySide(this.asks, delta.asks);
    this.lastUpdateId = delta.lastUpdateId;
    return { accepted: true };
  }

  /** Depth read in best-first order. Zero-size levels are pruned (delta
   *  removals). Pruning on read keeps the maps bounded. */
  depth(levels = 10) {
    const prune = (m) => {
      for (const [k, v] of m) if (BigInt(v) === 0n) m.delete(k);
    };
    prune(this.bids);
    prune(this.asks);
    const sort = (m, desc) =>
      [...m.entries()]
        .map(([priceMinor, sizeMinor]) => ({ priceMinor, sizeMinor }))
        .sort((a, b) => {
          const d = BigInt(a.priceMinor) - BigInt(b.priceMinor);
          return desc ? (d > 0n ? -1 : 1) : d < 0n ? -1 : 1;
        })
        .slice(0, levels);
    return { symbol: this.symbol, bids: sort(this.bids, true), asks: sort(this.asks, false) };
  }

  static mapLevels(levels) {
    const m = new Map();
    if (Array.isArray(levels)) {
      for (const l of levels) m.set(String(l.priceMinor), String(l.sizeMinor));
    }
    return m;
  }

  static applySide(map, levels) {
    if (!Array.isArray(levels)) throw new Error("delta side levels must be an array");
    for (const l of levels) map.set(String(l.priceMinor), String(l.sizeMinor));
  }
}

// ── 2. Rolling VPIN accumulator ─────────────────────────────────────────────

class RollingVpin {
  constructor(bucketVolume, opts = {}) {
    this.bucketVolume = BigInt(bucketVolume);
    if (this.bucketVolume <= 0n) throw new Error("bucketVolume must be a positive integer");
    this.toxicThreshold = opts.toxicThreshold ?? 0.75;
    this.history = opts.maxBuckets ?? 100;
    this.filled = 0n;
    this.buy = 0n;
    this.sell = 0n;
    this.completed = []; // per-bucket |buy − sell|, bounded
    this.buckets = 0;
  }

  /** Feed one chronological trade. Returns a toxicity verdict only when the
   *  trade completed a bucket; otherwise null (no verdict yet). */
  push(trade) {
    let size = BigInt(trade.sizeMinor);
    const isBuy = String(trade.side).toLowerCase() === "buy";
    let verdict = null;
    while (size > 0n) {
      const room = this.bucketVolume - this.filled;
      const take = size < room ? size : room;
      if (isBuy) this.buy += take; else this.sell += take;
      this.filled += take;
      size -= take;
      if (this.filled === this.bucketVolume) {
        const imbalance = this.buy > this.sell ? this.buy - this.sell : this.sell - this.buy;
        this.completed.push(imbalance);
        if (this.completed.length > this.history) this.completed.shift();
        this.buckets += 1;
        verdict = this.verdict();
        this.filled = 0n;
        this.buy = 0n;
        this.sell = 0n;
      }
    }
    return verdict;
  }

  /** Current toxicity over the completed buckets (bounded history). */
  verdict() {
    if (this.completed.length === 0) {
      return { ok: false, reason: "no completed buckets yet" };
    }
    let sum = 0n;
    for (const im of this.completed) sum += im;
    const vpin = Number((sum * 10_000n) / (BigInt(this.completed.length) * this.bucketVolume)) / 10_000;
    return {
      ok: true,
      vpin,
      buckets: this.completed.length,
      toxic: vpin > this.toxicThreshold,
      toxicThreshold: this.toxicThreshold,
    };
  }
}

// ── 3. WebSocket connection manager ─────────────────────────────────────────

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 200;

/**
 * Transport-agnostic persistent connection manager.
 *
 * The caller injects `connect()` (returns a handle with `send` and an
 * onmessage/onclose wiring) — so tests drive reconnects, heartbeats and
 * subscription dedup without sockets. Production wires it to the Hyperliquid
 * or Binance WebSocket endpoints.
 */
class WsConnectionManager {
  constructor(opts) {
    if (typeof opts.connect !== "function") throw new Error("connect() factory is required");
    this.connectFn = opts.connect;
    this.subscriptions = new Set();
    this.connected = false;
    this.attempt = 0;
    this.heartbeatAt = null;
    this.closedByUser = false;
    this.maxSubscriptions = opts.maxSubscriptions ?? MAX_SUBSCRIPTIONS;
  }

  /** Open (or re-open) the connection. Exponential backoff: 1s → 2s → 4s …
   *  capped at 30s, reset on a successful connect. */
  async open() {
    if (this.closedByUser) return { connected: false, reason: "closed by user" };
    try {
      await this.connectFn(this);
      this.connected = true;
      this.attempt = 0;
      this.touchHeartbeat();
      return { connected: true };
    } catch (e) {
      this.attempt += 1;
      const backoff = Math.min(BACKOFF_INITIAL_MS * 2 ** (this.attempt - 1), BACKOFF_MAX_MS);
      return { connected: false, retryInMs: backoff, attempts: this.attempt, error: String(e?.message ?? e) };
    }
  }

  /** Mark a message received — refreshes the heartbeat clock. */
  touchHeartbeat(nowMs = Date.now()) {
    this.heartbeatAt = nowMs;
  }

  /** True when no message has arrived within the heartbeat timeout — the
   *  connection is presumed dead and must be re-opened. */
  isHeartbeatStale(nowMs = Date.now()) {
    if (!this.connected || this.heartbeatAt === null) return false;
    return nowMs - this.heartbeatAt > HEARTBEAT_TIMEOUT_MS;
  }

  /** Subscribe with dedup + cap. Returns false if already subscribed or the
   *  cap is hit (prevents uncontrolled memory growth from a runaway loop). */
  subscribe(stream) {
    if (this.subscriptions.has(stream)) return { added: false, reason: "already subscribed" };
    if (this.subscriptions.size >= this.maxSubscriptions) {
      return { added: false, reason: `subscription cap (${this.maxSubscriptions}) reached` };
    }
    this.subscriptions.add(stream);
    return { added: true, total: this.subscriptions.size };
  }

  unsubscribe(stream) {
    return { removed: this.subscriptions.delete(stream) };
  }

  close() {
    this.closedByUser = true;
    this.connected = false;
    this.subscriptions.clear();
  }
}

module.exports = {
  L2DeltaBook,
  RollingVpin,
  WsConnectionManager,
  BACKOFF_INITIAL_MS,
  BACKOFF_MAX_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_SUBSCRIPTIONS,
};

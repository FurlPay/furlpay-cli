/**
 * Capability Registry & Live Gate (2026-11-17 readiness gap P1)
 *
 * One mechanical source of truth for what each surface can do, and ONE choke
 * point every code path that signs or broadcasts must pass:
 *
 *   assertLiveAllowed(surfaceId)
 *
 * Live execution requires an explicit operator opt-in (FURLPAY_LIVE=1).
 * Default is OFF everywhere — a simulated surface cannot be mistaken for
 * live, and a live code path cannot run by accident. Surfaces declare their
 * honest mode here; the finance orchestrator's settlementCapabilities()
 * and the honesty docs stay consistent with this registry by construction.
 */

export type SurfaceMode = "live" | "simulated" | "analysis" | "local" | "none";

export interface CapabilityEntry {
  id: string;
  mode: SurfaceMode;
  /** True when the surface signs/broadcasts — it MUST call assertLiveAllowed. */
  signsOrBroadcasts: boolean;
  venue?: string;
  note: string;
}

export const CAPABILITIES: Record<string, CapabilityEntry> = {
  "hyperliquid.market-data": { id: "hyperliquid.market-data", mode: "live", signsOrBroadcasts: false, venue: "Hyperliquid", note: "real /info responses; read-only" },
  "hyperliquid.perp-execution": { id: "hyperliquid.perp-execution", mode: "live", signsOrBroadcasts: true, venue: "Hyperliquid", note: "signed EIP-712 orders through the exchange endpoint" },
  "hyperliquid.hlp-deposit": { id: "hyperliquid.hlp-deposit", mode: "live", signsOrBroadcasts: true, venue: "Hyperliquid", note: "signed vaultTransfer" },
  "hyperliquid.hlp-withdraw": { id: "hyperliquid.hlp-withdraw", mode: "live", signsOrBroadcasts: true, venue: "Hyperliquid", note: "signed vaultTransfer" },
  "binance.spot": { id: "binance.spot", mode: "live", signsOrBroadcasts: true, venue: "Binance", note: "signed REST orders; testnet by default, explicit mainnet opt-in" },
  "stellar.sdex": { id: "stellar.sdex", mode: "simulated", signsOrBroadcasts: false, venue: "Stellar", note: "labeled local simulation — no Horizon broadcast in this build" },
  "stellar.path-payment": { id: "stellar.path-payment", mode: "simulated", signsOrBroadcasts: false, venue: "Stellar", note: "labeled local simulation" },
  "stellar.soroban-swap": { id: "stellar.soroban-swap", mode: "simulated", signsOrBroadcasts: false, venue: "Stellar", note: "labeled local simulation" },
  "stellar.tx-verify": { id: "stellar.tx-verify", mode: "live", signsOrBroadcasts: false, venue: "Horizon", note: "real lookup; never claimed as re-verification" },
  "stellar.faucet": { id: "stellar.faucet", mode: "live", signsOrBroadcasts: false, venue: "Friendbot", note: "testnet/futurenet only; mainnet refused" },
  "x402.settlement": { id: "x402.settlement", mode: "simulated", signsOrBroadcasts: false, note: "SIMULATED / LOCAL_SIMULATION — no live facilitator" },
  "escrow.tracker": { id: "escrow.tracker", mode: "local", signsOrBroadcasts: false, note: "local ledger state machine; no on-chain contract" },
  "finance.ledger": { id: "finance.ledger", mode: "local", signsOrBroadcasts: false, note: "local double-entry ledger of record" },
  "finance.payments": { id: "finance.payments", mode: "local", signsOrBroadcasts: false, note: "records and governs; settlement via evidence attachment, no live adapter" },
};

/** Every registered surface, stable order — feeds `furlpay capabilities`. */
export function listCapabilities(): CapabilityEntry[] {
  return Object.values(CAPABILITIES);
}

export function getCapability(surfaceId: string): CapabilityEntry | undefined {
  return CAPABILITIES[surfaceId];
}

export function isLiveOptIn(): boolean {
  return process.env.FURLPAY_LIVE === "1";
}

/**
 * THE choke point. Every code path that signs or broadcasts calls this with
 * its registry id. Refusal is loud and actionable: the operator either opts
 * in deliberately (FURLPAY_LIVE=1) or the surface stays inert. Unknown
 * surface ids refuse — a signing path that never registered itself does not
 * get a default pass.
 */
export function assertLiveAllowed(surfaceId: string): void {
  const cap = CAPABILITIES[surfaceId];
  if (!cap) {
    throw new Error(`LIVE_GATE_UNKNOWN_SURFACE: "${surfaceId}" is not in the capability registry. Register it in src/capabilities/registry.ts before it can execute.`);
  }
  if (!cap.signsOrBroadcasts) {
    // Analysis/simulated/local surfaces are not gated — they never move value.
    return;
  }
  if (cap.mode !== "live") {
    throw new Error(`LIVE_GATE_MODE_REFUSED: "${surfaceId}" is registered as ${cap.mode} and cannot execute a signed action.`);
  }
  if (!isLiveOptIn()) {
    throw new Error(
      `LIVE_GATE_CLOSED: "${surfaceId}" signs or broadcasts real value and requires explicit opt-in. ` +
        `Set FURLPAY_LIVE=1 to enable live execution; the default is simulation/inert.`
    );
  }
}

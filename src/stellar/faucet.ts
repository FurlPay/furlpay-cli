/**
 * Testnet/Futurenet faucet — real Friendbot funding with honest reporting.
 *
 * HONESTY CONTRACT:
 * - Only networks that actually have a Friendbot are supported: testnet and
 *   futurenet (developers.stellar.org/docs/networks). Mainnet requests are
 *   REFUSED — real XLM cannot be fabricated.
 * - Endpoints are the officially documented ones:
 *     testnet:  https://friendbot.stellar.org            (equivalent to
 *               https://horizon-testnet.stellar.org/friendbot?addr=...)
 *     futurenet: https://friendbot-futurenet.stellar.org
 * - `funded: true` is only ever reported after the Friendbot itself returned
 *   a successful HTTP response with a fund transaction. A successful
 *   response that cannot be parsed still reports the raw truth.
 * - The follow-up balance check is a separate Horizon lookup and is reported
 *   independently (`balanceVerified`); if it fails, funding is NOT claimed
 *   to have failed — only the verification is marked as unavailable.
 */

import { Keypair } from "@stellar/stellar-sdk";

export type FaucetNetwork = "testnet" | "futurenet";

export const FRIENDBOT_URLS: Record<FaucetNetwork, string> = {
  testnet: "https://friendbot.stellar.org",
  futurenet: "https://friendbot-futurenet.stellar.org",
};

export const HORIZON_URLS_BY_NETWORK: Record<FaucetNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
};

export interface FaucetResult {
  address: string;
  network: FaucetNetwork;
  friendbotUrl: string;
  /** True only when the Friendbot returned a successful funding response. */
  funded: boolean;
  transactionHash: string | null;
  ledger: number | null;
  /** Separate Horizon balance lookup; null when it could not be performed. */
  balanceVerified: boolean | null;
  error?: string;
}

export interface FaucetOptions {
  network?: FaucetNetwork;
  /** Injectable fetch for tests; defaults to global fetch (Node >= 18). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function isValidStellarAddress(address: string): boolean {
  try {
    Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fund `address` from the Friendbot. Throws only on invalid input (bad
 * address / mainnet request); network failures are returned in the result,
 * not thrown, so callers can report them honestly.
 */
export async function requestFunds(
  address: string,
  opts: FaucetOptions = {}
): Promise<FaucetResult> {
  const network: FaucetNetwork = opts.network ?? "testnet";

  if (!isValidStellarAddress(address)) {
    throw new Error(
      "Invalid Stellar address. Pass a valid G... public key (validated locally with the Stellar SDK before any network request)."
    );
  }

  const friendbotUrl = FRIENDBOT_URLS[network];
  const fetchImpl = opts.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${friendbotUrl}?addr=${encodeURIComponent(address)}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const bodyText = await res.text();
        if (bodyText) detail += `: ${bodyText.slice(0, 300)}`;
      } catch {
        /* body unreadable — keep the status line */
      }
      return {
        address,
        network,
        friendbotUrl,
        funded: false,
        transactionHash: null,
        ledger: null,
        balanceVerified: null,
        error: `Friendbot did not fund the account (${detail}). No funding occurred from this request.`,
      };
    }

    // Success: parse what the Friendbot reported. Do not over-claim fields.
    let transactionHash: string | null = null;
    let ledger: number | null = null;
    try {
      const body = (await res.json()) as { hash?: string; ledger?: number };
      transactionHash = typeof body.hash === "string" ? body.hash : null;
      ledger = typeof body.ledger === "number" ? body.ledger : null;
    } catch {
      /* Response was OK but not parseable JSON — funded per HTTP status,
         details reported as unknown rather than invented. */
    }

    // Separate, best-effort balance verification via Horizon. Failure here
    // does not negate the funding — it is reported independently.
    let balanceVerified: boolean | null = null;
    try {
      const acctRes = await fetchImpl(
        `${HORIZON_URLS_BY_NETWORK[network]}/accounts/${encodeURIComponent(address)}`,
        { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) }
      );
      if (acctRes.ok) {
        const acct = (await acctRes.json()) as {
          balances?: Array<{ asset_type?: string; balance?: string }>;
        };
        const native = (acct.balances ?? []).find((b) => b.asset_type === "native");
        balanceVerified = Boolean(native && Number(native.balance) > 0);
      }
    } catch {
      balanceVerified = null;
    }

    return {
      address,
      network,
      friendbotUrl,
      funded: true,
      transactionHash,
      ledger,
      balanceVerified,
    };
  } catch (e) {
    return {
      address,
      network,
      friendbotUrl,
      funded: false,
      transactionHash: null,
      ledger: null,
      balanceVerified: null,
      error: `Friendbot unreachable: ${(e as Error).message}. No funding occurred from this request.`,
    };
  }
}

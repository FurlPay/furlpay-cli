/**
 * Honest transaction verification against Stellar Horizon.
 *
 * HONESTY CONTRACT:
 * - This is an API LOOKUP of what a Horizon instance reports about the
 *   finalized ledger history. It is NOT an independent cryptographic
 *   re-verification of the transaction (no signature checking, no ledger
 *   header validation). The result says exactly what was and was not
 *   verified.
 * - A 404 from Horizon does NOT mean the transaction does not exist.
 *   Horizon ingests from finalized ledgers: a just-submitted transaction
 *   may not be visible yet, and a hash may simply belong to a different
 *   network. NOT_FOUND is reported as such — never as "failed" and never
 *   as "confirmed".
 * - Horizon endpoint: GET /transactions/{hash}
 *   (developers.stellar.org, "Retrieve a Transaction"). The `successful`
 *   field distinguishes a transaction that was included in a ledger and
 *   succeeded from one that was included but failed.
 * - Timeout and 5xx responses classify as UNAVAILABLE: an outage of the
 *   lookup service must never be reported as evidence about the tx.
 */

export type TxVerifyStatus =
  | "CONFIRMED_SUCCESS"
  | "CONFIRMED_FAILED"
  | "NOT_FOUND"
  | "INVALID_HASH"
  | "UNAVAILABLE";

export type StellarNetwork = "mainnet" | "testnet";

export interface TxFoundDetails {
  successful: boolean;
  ledger: number | null;
  createdAt: string | null;
  sourceAccount: string | null;
  operationCount: number | null;
  feePaidStroops: string | null;
  resultXdr: string | null;
}

export interface TxVerificationResult {
  hash: string;
  network: StellarNetwork;
  horizonUrl: string;
  status: TxVerifyStatus;
  found: TxFoundDetails | null;
  verifiedAt: string;
  /** Precise statement of what this lookup established. */
  whatWasVerified: string;
  /** Precise statement of what this lookup did NOT establish. */
  whatWasNotVerified: string;
  error?: string;
}

export const HORIZON_URLS: Record<StellarNetwork, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

/** A Stellar transaction hash is a 64-character lowercase hex SHA-256. */
export function isValidTxHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

export interface TxVerifyOptions {
  network?: StellarNetwork;
  horizonUrl?: string;
  /** Injectable fetch for tests; defaults to global fetch (Node >= 18). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface HorizonTxResponse {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
  source_account?: string;
  operation_count?: number;
  fee_charged?: string;
  result_xdr?: string;
}

export async function verifyTransaction(
  rawHash: string,
  opts: TxVerifyOptions = {}
): Promise<TxVerificationResult> {
  const network: StellarNetwork = opts.network ?? "mainnet";
  const horizonUrl = opts.horizonUrl ?? HORIZON_URLS[network];
  const hash = String(rawHash ?? "").trim().toLowerCase();
  const verifiedAt = new Date().toISOString();

  if (!isValidTxHash(hash)) {
    return {
      hash,
      network,
      horizonUrl,
      status: "INVALID_HASH",
      found: null,
      verifiedAt,
      whatWasVerified: "Nothing — the input is not a valid Stellar transaction hash.",
      whatWasNotVerified:
        "A Stellar transaction hash is 64 lowercase hexadecimal characters (SHA-256 of the envelope). No lookup was performed.",
      error: "Expected 64 lowercase hex characters",
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${horizonUrl.replace(/\/$/, "")}/transactions/${hash}`;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });

    if (res.status === 200) {
      const body = (await res.json()) as HorizonTxResponse;
      const successful = body.successful === true;
      const found: TxFoundDetails = {
        successful,
        ledger: typeof body.ledger === "number" ? body.ledger : null,
        createdAt: body.created_at ?? null,
        sourceAccount: body.source_account ?? null,
        operationCount: typeof body.operation_count === "number" ? body.operation_count : null,
        feePaidStroops: body.fee_charged ?? null,
        resultXdr: body.result_xdr ?? null,
      };
      return {
        hash,
        network,
        horizonUrl,
        status: successful ? "CONFIRMED_SUCCESS" : "CONFIRMED_FAILED",
        found,
        verifiedAt,
        whatWasVerified: `Horizon (${horizonUrl}) reports this transaction as included in finalized ledger ${
          found.ledger ?? "?"
        }${found.createdAt ? ` at ${found.createdAt}` : ""} with result ${
          successful ? "txSUCCESS" : "FAILED"
        }.`,
        whatWasNotVerified:
          "This is an API lookup of Horizon's finalized-ledger history, not an independent cryptographic re-verification: signatures and ledger headers were not re-validated locally. Decode result_xdr (e.g. in Stellar Lab) if you need the per-operation result codes.",
      };
    }

    if (res.status === 404) {
      return {
        hash,
        network,
        horizonUrl,
        status: "NOT_FOUND",
        found: null,
        verifiedAt,
        whatWasVerified:
          "Horizon's finalized-ledger history on this network contains no transaction with this hash (HTTP 404).",
        whatWasNotVerified:
          "A 404 is NOT proof the transaction does not exist: it may have been submitted but not yet included in a ledger, Horizon history may lag, or the hash may belong to a different network. Check the correct network or retry after a few seconds.",
      };
    }

    return {
      hash,
      network,
      horizonUrl,
      status: "UNAVAILABLE",
      found: null,
      verifiedAt,
      whatWasVerified: "Nothing — the lookup service returned an unexpected response.",
      whatWasNotVerified: "An outage of the lookup service is not evidence about the transaction.",
      error: `Horizon responded HTTP ${res.status}`,
    };
  } catch (e) {
    return {
      hash,
      network,
      horizonUrl,
      status: "UNAVAILABLE",
      found: null,
      verifiedAt,
      whatWasVerified: "Nothing — the lookup service could not be reached.",
      whatWasNotVerified: "A network outage is not evidence about the transaction.",
      error: (e as Error).message,
    };
  }
}

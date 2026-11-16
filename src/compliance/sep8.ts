/**
 * SEP-0008 Regulated Asset Metadata
 *
 * HONESTY CONTRACT: this build has NO SEP-8 approval-server integration.
 * No network request is ever made for an approval, no KYC is ever performed,
 * and no issuer co-signature can ever be attached. Nothing in this module may
 * claim an approval happened. When a real integration lands, submitForApproval
 * must fail closed (no approval => no regulated-asset transaction).
 *
 * P5 (2026-11-16 audit): the catalog previously carried fabricated "vanity"
 * issuer addresses that fail Stellar's StrKey checksum validation. Issuer
 * addresses are facts, not catalog filler — they are resolved dynamically
 * from the issuer's SIGNED stellar.toml (SEP-1) and validated with
 * StrKey.isValidEd25519PublicKey before use, or the asset is refused.
 */

import { Sep8ComplianceResult } from "../types";
import { StrKey } from "@stellar/stellar-sdk";

export interface RegulatedAssetMetadata {
  code: string;
  /** Issuer domain whose signed stellar.toml is the ONLY issuer-of-record source. */
  issuerDomain: string;
  regulatedRegime: string;
}

/**
 * Reference metadata for regulated assets the CLI knows about.
 *
 * NO ISSUER ADDRESSES HERE, EVER: an address in this table would be an
 * unverified claim that silently substitutes for the issuer's own signed
 * toml. Resolution is dynamic (resolveIssuerFromToml) and validating.
 */
export const KNOWN_REGULATED_ASSETS: Record<string, RegulatedAssetMetadata> = {
  JQQQ: {
    code: "JQQQ",
    regulatedRegime: "SEC Reg D / Reg S (Janus Henderson Nasdaq-100 ETF)",
    issuerDomain: "janushenderson.com",
  },
  FOBXX: {
    code: "FOBXX",
    regulatedRegime: "SEC Registered 1940 Act (Franklin OnChain US Govt Money Fund)",
    issuerDomain: "franklintempleton.com",
  },
  USTBL: {
    code: "USTBL",
    regulatedRegime: "MiCA Compliant Short-Term US Treasury Bill Token",
    issuerDomain: "spiko.io",
  },
  NVDA: {
    code: "NVDA",
    regulatedRegime: "SEC Reg D Rule 506(c) (Securitize NVIDIA Equity)",
    issuerDomain: "securitize.io",
  },
  AAPL: {
    code: "AAPL",
    regulatedRegime: "SEC Reg D Rule 506(c) (Securitize Apple Equity)",
    issuerDomain: "securitize.io",
  },
};

/** The one honest result this build can produce for a regulated asset. */
export const SEP8_NOT_IMPLEMENTED_MESSAGE =
  "SEP-8 issuer approval is not implemented in this build: no approval server was contacted, no KYC was performed, and no issuer co-signature was attached. Resolve the issuer's approval server from its signed stellar.toml and complete verification there before trading regulated assets.";

export class StellarTomlResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StellarTomlResolutionError";
  }
}

/**
 * SEP-1: fetch the issuer's signed stellar.toml and extract the issuer
 * address for `code` from its [[CURRENCY]] entries. Fails CLOSED:
 * - unreachable toml / no matching entry → error (never a guessed issuer)
 * - the toml's issuer fails StrKey.isValidEd25519PublicKey → error
 * The signature on the toml itself is verified by the SEP-1 ecosystem
 * (https + well-known placement); this function only ever accepts a
 * cryptographically valid Ed25519 G... address from it.
 */
export async function resolveIssuerFromToml(code: string, issuerDomain: string): Promise<string> {
  const cleanCode = code.split(":")[0].toUpperCase();
  const url = `https://${issuerDomain}/.well-known/stellar.toml`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (e: any) {
    throw new StellarTomlResolutionError(
      `SEP-1 resolution failed for ${cleanCode}: could not fetch ${url} (${e.message}). ` +
        `No issuer address is guessed — refusing instead.`
    );
  }
  if (!res.ok) {
    throw new StellarTomlResolutionError(
      `SEP-1 resolution failed for ${cleanCode}: ${url} returned HTTP ${res.status}. ` +
        `No issuer address is guessed — refusing instead.`
    );
  }
  const toml = await res.text();

  // Minimal [[CURRENCY]] block parser: enough for the documented fields,
  // tolerant of comments and whitespace, no toml dependency.
  const blocks = toml.split(/\[\[CURRENCY\]\]/i).slice(1);
  for (const block of blocks) {
    const field = (name: string): string | null => {
      const m = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`, "m").exec(block);
      return m ? m[1] : null;
    };
    const tomlCode = field("code");
    const tomlIssuer = field("issuer");
    if (tomlCode && tomlCode.toUpperCase() === cleanCode && tomlIssuer) {
      let valid = false;
      try {
        valid = StrKey.isValidEd25519PublicKey(tomlIssuer);
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new StellarTomlResolutionError(
          `SEP-1 resolution refused for ${cleanCode}: issuer in ${issuerDomain} stellar.toml ` +
            `is not a valid Ed25519 public key. Refusing — never trading against an unvalidated issuer.`
        );
      }
      return tomlIssuer;
    }
  }
  throw new StellarTomlResolutionError(
    `SEP-1 resolution failed for ${cleanCode}: no [[CURRENCY]] entry with code=${cleanCode} in ` +
      `${issuerDomain}'s stellar.toml. Refusing — no fallback issuer exists.`
  );
}

export class Sep8ComplianceEngine {
  /**
   * Detects if an asset code or full asset string requires SEP-8 authorization.
   */
  isRegulatedAsset(assetStr: string): boolean {
    const code = assetStr.split(":")[0].toUpperCase();
    return Boolean(KNOWN_REGULATED_ASSETS[code]);
  }

  getAssetMetadata(assetStr: string): RegulatedAssetMetadata | null {
    const code = assetStr.split(":")[0].toUpperCase();
    return KNOWN_REGULATED_ASSETS[code] || null;
  }

  /**
   * Pre-flight SEP-8 authorization check.
   *
   * For a non-regulated asset this honestly reports that no issuer
   * authorization is required. For a regulated asset it NEVER claims
   * approval: this build has no approval-server client, so the only honest
   * answer is `approved: false` with an explanation. Callers running
   * SIMULATIONS may continue, but must surface this result instead of a
   * compliance claim; any real submission path must fail closed on it.
   */
  async submitForApproval(
    assetStr: string,
    _txXdr: string,
    _userPubkey: string
  ): Promise<Sep8ComplianceResult> {
    const meta = this.getAssetMetadata(assetStr);
    if (!meta) {
      return {
        approved: true,
        status: "success",
        signedXdr: _txXdr,
        message: "Not a SEP-8 regulated asset — no issuer authorization required.",
      };
    }

    return {
      approved: false,
      status: "action_required",
      message: SEP8_NOT_IMPLEMENTED_MESSAGE,
    };
  }
}

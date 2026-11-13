/**
 * SEP-0008 Regulated Asset Metadata
 *
 * HONESTY CONTRACT: this build has NO SEP-8 approval-server integration.
 * No network request is ever made, no KYC is ever performed, and no issuer
 * co-signature can ever be attached. Nothing in this module may claim an
 * approval happened. When a real integration lands, submitForApproval must
 * fail closed (no approval => no regulated-asset transaction).
 */

import { Sep8ComplianceResult } from "../types";

export interface RegulatedAssetMetadata {
  code: string;
  issuer: string;
  regulatedRegime: string;
  issuerDomain: string;
}

/**
 * Reference metadata for regulated assets the CLI knows about.
 *
 * UNVERIFIED REFERENCE DATA: issuer addresses and regime descriptions are
 * illustrative catalog entries, not on-chain-verified facts. Before any real
 * use, resolve the issuer and its SEP-8 approval server from the issuer's
 * signed stellar.toml — never from this table.
 */
export const KNOWN_REGULATED_ASSETS: Record<string, RegulatedAssetMetadata> = {
  JQQQ: {
    code: "JQQQ",
    issuer: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
    regulatedRegime: "SEC Reg D / Reg S (Janus Henderson Nasdaq-100 ETF)",
    issuerDomain: "janushenderson.com",
  },
  FOBXX: {
    code: "FOBXX",
    issuer: "GBNX66T6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QFOBXX",
    regulatedRegime: "SEC Registered 1940 Act (Franklin OnChain US Govt Money Fund)",
    issuerDomain: "franklintempleton.com",
  },
  USTBL: {
    code: "USTBL",
    issuer: "GSPK77X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSPK77",
    regulatedRegime: "MiCA Compliant Short-Term US Treasury Bill Token",
    issuerDomain: "spiko.io",
  },
  NVDA: {
    code: "NVDA",
    issuer: "GCR88X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    regulatedRegime: "SEC Reg D Rule 506(c) (Securitize NVIDIA Equity)",
    issuerDomain: "securitize.io",
  },
  AAPL: {
    code: "AAPL",
    issuer: "GCAP99X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    regulatedRegime: "SEC Reg D Rule 506(c) (Securitize Apple Equity)",
    issuerDomain: "securitize.io",
  },
};

/** The one honest result this build can produce for a regulated asset. */
export const SEP8_NOT_IMPLEMENTED_MESSAGE =
  "SEP-8 issuer approval is not implemented in this build: no approval server was contacted, no KYC was performed, and no issuer co-signature was attached. Resolve the issuer's approval server from its signed stellar.toml and complete verification there before trading regulated assets.";

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

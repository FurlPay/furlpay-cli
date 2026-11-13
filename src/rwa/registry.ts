/**
 * Reference catalog of tokenized stocks & RWAs on Stellar.
 *
 * HONESTY CONTRACT:
 *  - No `apy` field exists here. Yields are issuer-reported, time-varying
 *    facts; a hardcoded figure would be fabrication. Display yield only from
 *    a live issuer/registry data source, never from this catalog.
 *  - No approval-server URLs are bundled. Invented compliance URLs are a
 *    fabrication vector — resolve the real SEP-8 server from the issuer's
 *    signed stellar.toml.
 *  - Issuer addresses and regulatory entries are UNVERIFIED REFERENCE DATA
 *    (illustrative catalog entries). Verify on-chain and against SEC EDGAR /
 *    the issuer before any real use.
 */

import { RwaAsset, RwaCategory } from "../types";

export const INSTITUTIONAL_RWAS: RwaAsset[] = [
  {
    code: "JQQQ",
    issuer: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
    name: "Janus Henderson Nasdaq-100 Equity ETF Token",
    category: "equities",
    requiresSep8: true,
    regime: "SEC Reg D Rule 506(c) / Reg S (reference — verify against EDGAR)",
    cik: "0001968812",
    description: "Tokenized institutional shares of Janus Henderson's flagship Nasdaq-100 ETF.",
  },
  {
    code: "FOBXX",
    issuer: "GBNX66T6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QFOBXX",
    name: "Franklin OnChain U.S. Government Money Fund (Benji)",
    category: "treasuries",
    requiresSep8: true,
    regime: "SEC Registered 1940 Act (reference — verify against EDGAR)",
    cik: "0001786958",
    description: "First U.S.-registered mutual fund to process transactions directly on Stellar.",
  },
  {
    code: "USTBL",
    issuer: "GSPK77X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSPK77",
    name: "Spiko Short-Term US Treasury Bill Token",
    category: "treasuries",
    requiresSep8: true,
    regime: "EU MiCA Regulated Money Market Fund (reference — verify with the issuer)",
    description: "MiCA-compliant short-duration treasury bill fund.",
  },
  {
    code: "NVDA",
    issuer: "GCR88X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    name: "Securitize NVIDIA Tokenized Equity",
    category: "equities",
    requiresSep8: true,
    regime: "SEC Reg D Rule 506(c) (reference — verify against EDGAR)",
    cik: "0001742918",
    description: "Digitally native 1:1 backed NVIDIA Common Stock shares with DTCC bridge parity.",
  },
  {
    code: "AAPL",
    issuer: "GCAP99X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    name: "Securitize Apple Inc Tokenized Equity",
    category: "equities",
    requiresSep8: true,
    regime: "SEC Reg D Rule 506(c) (reference — verify against EDGAR)",
    description: "Digitally native 1:1 backed Apple Common Stock shares.",
  },
];

export class RwaRegistry {
  list(category?: RwaCategory): RwaAsset[] {
    if (!category || category === "all") {
      return INSTITUTIONAL_RWAS;
    }
    return INSTITUTIONAL_RWAS.filter((r) => r.category === category);
  }

  inspect(assetStr: string): RwaAsset | null {
    const code = assetStr.split(":")[0].toUpperCase();
    return INSTITUTIONAL_RWAS.find((r) => r.code === code) || null;
  }

  /**
   * SEP-8 KYC onboarding entry point.
   *
   * HONESTY CONTRACT: this build integrates with NO KYC provider and NO
   * issuer approval server, so it never reports APPROVED and never invents
   * an onboarding URL. It returns NOT_IMPLEMENTED and points at the issuer's
   * own domain (stellar.toml) where the real flow must be resolved.
   */
  startKycFlow(assetStr: string, interactive: boolean = false): {
    asset: string;
    status: "NOT_IMPLEMENTED" | "PENDING_INPUT";
    issuerDomain: string | null;
    instructions: string;
  } {
    const meta = this.inspect(assetStr);
    if (!meta) throw new Error(`Unknown RWA asset: ${assetStr}`);

    return {
      asset: meta.code,
      status: "NOT_IMPLEMENTED",
      issuerDomain: this.issuerDomainFor(meta.code),
      instructions:
        `SEP-8 issuer KYC is not implemented in this build: no identity verification was ` +
        `performed and no approval was granted. Complete verification with the issuer of ` +
        `${meta.code}${this.issuerDomainFor(meta.code) ? ` (${this.issuerDomainFor(meta.code)})` : ""} — ` +
        `resolve the approval server from the issuer's signed stellar.toml${interactive ? ", then retry from a SEP-8-capable wallet" : ""}.`,
    };
  }

  private issuerDomainFor(code: string): string | null {
    const domains: Record<string, string> = {
      JQQQ: "janushenderson.com",
      FOBXX: "franklintempleton.com",
      USTBL: "spiko.io",
      NVDA: "securitize.io",
      AAPL: "securitize.io",
    };
    return domains[code] ?? null;
  }
}

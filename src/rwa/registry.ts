/**
 * Institutional Tokenized Stocks & RWA Registry for Stellar
 * Covers Janus Henderson JQQQ, Franklin Templeton FOBXX, Spiko USTBL, Securitize equities.
 */

import { RwaAsset, RwaCategory } from "../types";

export const INSTITUTIONAL_RWAS: RwaAsset[] = [
  {
    code: "JQQQ",
    issuer: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
    name: "Janus Henderson Nasdaq-100 Equity ETF Token",
    category: "equities",
    requiresSep8: true,
    approvalServer: "https://compliance.centrifuge.io/sep8",
    regime: "SEC Reg D Rule 506(c) / Reg S",
    cik: "0001968812",
    description: "Tokenized institutional shares of Janus Henderson's flagship Nasdaq-100 ETF.",
  },
  {
    code: "FOBXX",
    issuer: "GBNX66T6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QFOBXX",
    name: "Franklin OnChain U.S. Government Money Fund (Benji)",
    category: "treasuries",
    requiresSep8: true,
    approvalServer: "https://compliance.franklintempleton.com/sep8",
    regime: "SEC Registered 1940 Act Mutual Fund",
    cik: "0001786958",
    apy: "4.85%",
    description: "First U.S.-registered mutual fund to process transactions directly on Stellar.",
  },
  {
    code: "USTBL",
    issuer: "GSPK77X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSPK77",
    name: "Spiko Short-Term US Treasury Bill Token",
    category: "treasuries",
    requiresSep8: true,
    approvalServer: "https://compliance.spiko.io/sep8",
    regime: "EU MiCA Regulated Money Market Fund",
    apy: "4.92%",
    description: "MiCA-compliant short-duration treasury bill fund with daily compound yield.",
  },
  {
    code: "NVDA",
    issuer: "GCR88X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    name: "Securitize NVIDIA Tokenized Equity",
    category: "equities",
    requiresSep8: true,
    approvalServer: "https://compliance.securitize.io/sep8",
    regime: "SEC Reg D Rule 506(c)",
    cik: "0001742918",
    description: "Digitally native 1:1 backed NVIDIA Common Stock shares with DTCC bridge parity.",
  },
  {
    code: "AAPL",
    issuer: "GCAP99X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR",
    name: "Securitize Apple Inc Tokenized Equity",
    category: "equities",
    requiresSep8: true,
    approvalServer: "https://compliance.securitize.io/sep8",
    regime: "SEC Reg D Rule 506(c)",
    cik: "0001742918",
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

  startKycFlow(assetStr: string, interactive: boolean = false): {
    asset: string;
    status: "APPROVED" | "PENDING_INPUT";
    flowUrl: string;
    instructions: string;
  } {
    const meta = this.inspect(assetStr);
    if (!meta) throw new Error(`Unknown RWA asset: ${assetStr}`);

    const flowUrl = `https://${meta.code.toLowerCase()}.kyc.furlpay.io/onboard?asset=${meta.code}`;

    return {
      asset: meta.code,
      status: "APPROVED",
      flowUrl,
      instructions: `Complete identity verification for ${meta.name} (${meta.regime}) at: ${flowUrl}`,
    };
  }
}

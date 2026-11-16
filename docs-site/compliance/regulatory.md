# Regulatory Overview

> Condensed from the full **Regulatory, Licensing & Compliance Research Report** embedded in the [repository README](https://github.com/FurlPay/furlpay-cli#furlpay-cli--regulatory-licensing-and-compliance-research-report) — the README version is authoritative.

## Legal characterization

The FurlPay CLI is an enterprise-grade interface integrating payments, cross-chain swaps, tokenized securities/RWAs, decentralized perpetual futures, card issuing and AI agent execution. Client-side non-custodial cryptography (local keystores, hardware signers, local signing) earns the **FinCEN FIN-2019-G001 software safe-harbor only for the pure client↔public-RPC loop**. Several features, once operated as a *platform*, cross statutory licensing thresholds:

1. **Hosted API dependencies** — commands coordinating value transfer or relaying sponsored transactions
2. **x402 clearing facilitator** — a multi-party settlement ledger positions the operator as a settlement institution
3. **ETSS escrow** — holding/enforcing escrow settlement is statutory escrow activity
4. **Tokenized securities catalog** — facilitating trades in SEC-regulated funds is broker-dealer/ATS activity
5. **Perpetual derivatives** — offering leveraged cash-settled contracts to retail violates the CEA without registration

## Master licensing matrix (summary)

| Feature surface | United States | European Union | United Kingdom | Singapore |
|---|---|---|---|---|
| A2A transfers & relayed payments | FinCEN MSB + 49 state MTLs (NMLS) | MiCA CASP Class 2 / EMI | FCA MLRs registration + API | MAS MPI (PSA 2019) |
| Cross-chain swaps & CCTP | MSB (VC exchanger) | MiCA CASP Class 2 | Registered cryptoasset firm | DPT service license |
| Tokenized stocks (JQQQ, NVDA, FOBXX) | SEC broker-dealer + FINRA + Form ATS | MiFID II investment firm / MTF | Part 4A permission + MTF | CMS license + RMO |
| Perpetuals & margin | CFTC FCM/DCM — **US retail prohibited**; ECP validation or geoblocking | MiFID II derivatives venue | **Retail crypto-derivatives ban** | CMS license (capital markets products) |
| Card issuing | BaaS sponsor bank + PCI-DSS L1 | EMI + Visa associate membership | AEMI | MPI (account issuance) |
| x402 clearing | MSB / state MTLs | MiCA CASP | PSR 2017 | Merchant acquisition (PSA) |
| Dispute escrow | State escrow licenses (e.g., CA DFPI) | Payment institution / trust | SPI or trust authorization | Trust Business Act license |

## Key statutes & precedents

- **US money transmission:** BSA 31 U.S.C. § 5330; 31 CFR § 1022.380; FIN-2019-G001; MTMA state harmonization (NMLS, tangible-net-worth floors, surety bonding, permissible-investment rules); NY BitLicense / Limited Purpose Trust
- **US securities:** Exchange Act § 15(a) (broker-dealer); FINRA Rule 1014; Regulation ATS (Rules 300–303); Rule 15c3-3 customer protection; Rule 506(c) accredited-investor verification
- **US derivatives:** CEA § 2(c)(2)(D) and § 4(a); ECP standard (7 U.S.C. § 1a(18), $10M assets); *CFTC v. bZeroX/Ooki DAO* (2022/23); CFTC orders vs Deridex/Opyn/ZeroEx (2023); Uniswap Labs settlement (2024) — **front-end interfaces carry registration liability**
- **EU:** MiCA (Regulation (EU) 2023/1114) — CASP Classes 1–3 (€50k/€125k/€150k capital + 25% fixed-overheads prudential floor); EMT framework for fiat stablecoins; MiFID II for tokenized financial instruments (€150k–€730k) + DORA
- **UK:** FCA MLRs 2017 cryptoasset registration; FSMA 2023; **PS20/10 retail crypto-derivatives ban**
- **Singapore:** PSA 2019 (MPI above S$3M monthly / S$5M e-money; S$250k capital, S$100k security deposit, PSN07 asset segregation with ≥50% cold storage); SFA for CMS/RMO

## Travel rule & sanctions

- FATF Recommendation 16 / FinCEN 31 CFR § 1010.410 / EU ToFR 2023/1113: transfers above **$3,000** (€1,000 EU) must transmit verified originator/beneficiary IVMS101 data to the receiving VASP
- Pre-flight OFAC SDN (plus UK HMT / EU / UN) screening on source and destination addresses; fail-closed abort on sanctioned-mixer or jurisdiction exposure

## Capital & timeline reality

Full multi-jurisdiction licensing is a **$3.5M–$10M+ capital, $13M–$28M aggregate surety-bond** undertaking over ~24 months. The report's phased roadmap:

1. **Phase 1 (months 1–6):** pure non-custodial client; partner rails (BaaS/Circle/Stripe); FinCEN MSB for treasury; hard US geoblocking of perps
2. **Phase 2 (6–14):** EU MiCA CASP Class 2 entity; Singapore MPI; global Travel Rule integration
3. **Phase 3 (14–24+):** 49-state MTL rollout; FINRA broker-dealer (Form BD) + Form ATS; state escrow licenses

The complete capital tables, surety-bond math, sequence diagrams and vendor stack (Persona/Sumsub, Chainalysis/TRM, Castellum, Notabene/TRISA, Hummingbird) are in the README report.

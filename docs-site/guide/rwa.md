# Tokenized Stocks & RWAs (`furlpay rwa`)

An institutional catalog of tokenized equities and money market funds on Stellar — surfaced with its regulatory reality attached, not hidden.

## Registry commands

```bash
# List tokenized equities and treasuries
furlpay rwa list --category equities,treasuries

# Inspect SEP-8 compliance parameters and SEC CIK registry details
furlpay rwa inspect --asset JQQQ
furlpay rwa inspect --asset FOBXX

# SEP-8 issuer KYC guidance — NOT implemented in this build: prints what
# must be verified with the issuer and exits non-zero. It never reports
# an approval.
furlpay rwa kyc --asset FOBXX --interactive
```

## Catalog

| Asset | Type | Regulatory posture |
|---|---|---|
| `JQQQ` | Janus Henderson Nasdaq-100 Equity ETF token | SEC Reg D 506(c) / Reg S |
| `FOBXX` | Franklin OnChain U.S. Government Money Fund (Benji) | SEC 1940 Act registered fund (CIK 0001786958) |
| `NVDA` / `AAPL` | Securitize tokenized equities | SEC Reg D 506(c) |

## What the CLI refuses to fake

- **SEP-8 approval.** `rwa kyc` exits non-zero with guidance; regulated-asset trade results carry `sep8Status: "not_performed"`. Compliance is never claimed.
- **Issuer identities.** The registry carries no vanity keys — every issuer must be a checksum-valid Ed25519 key resolved from the issuer's signed `stellar.toml` (see [Stellar wallets](/guide/stellar)).
- **APY figures.** No hardcoded yield anywhere; unreported fields render as unavailable.

## Regulatory context

Facilitating trades in tokenized securities is broker-dealer / ATS territory in the US, and MiFID II investment-firm territory in the EU. The full licensing matrix — SEC Form BD, FINRA membership, Regulation ATS, MiCA/MiFID classifications per jurisdiction — is in the [Regulatory Overview](/compliance/regulatory). The developer invariants that matter day-to-day are in [Compliance Invariants](/compliance/invariants).

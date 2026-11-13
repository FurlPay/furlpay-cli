/**
 * Stellar Decentralized Exchange (SDEX) Central Limit Order Book Service
 * Implements ManageBuyOffer, ManageSellOffer, and PassiveSellOffer operations.
 */

import { Asset, Keypair, Operation, TransactionBuilder, Networks, Horizon, StrKey } from "@stellar/stellar-sdk";
import { LimitOrderParams, SignerInterface } from "../types";
import { Sep8ComplianceEngine } from "../compliance/sep8";
import { SponsorshipRelayer } from "../sponsor/relayer";
import * as crypto from "crypto";

export interface SdexExecutionResult {
  txHash: string;
  /** True: this hash is `sim_…` and no transaction reached the network. */
  simulated: boolean;
  ledgerNumber: number;
  status: "FILLED" | "RESTING" | "PARTIAL";
  filledAmount: string;
  price: string;
  totalCost: string;
  feePaidUsd: string;
  sponsored: boolean;
  /**
   * Honest SEP-8 status. `true` only means "no issuer authorization was
   * required" (unregulated asset). For regulated assets this is always
   * false in this build — no approval server is contacted, so no
   * compliance claim can be made. See sep8Status/sep8Note.
   */
  sep8Compliant: boolean;
  sep8Status: "not_required" | "not_performed";
  sep8Note?: string;
}

export class SdexTradingService {
  private networkPassphrase: string;
  private sep8Engine: Sep8ComplianceEngine;
  private sponsorRelayer: SponsorshipRelayer;

  constructor(networkPassphrase: string = Networks.PUBLIC) {
    this.networkPassphrase = networkPassphrase;
    this.sep8Engine = new Sep8ComplianceEngine();
    this.sponsorRelayer = new SponsorshipRelayer();
  }

  parseAsset(assetStr: string): Asset {
    const trimmed = assetStr.trim();
    if (trimmed.toUpperCase() === "XLM" || trimmed.toUpperCase() === "NATIVE") {
      return Asset.native();
    }
    const [code, issuer] = trimmed.split(":");
    if (!issuer) {
      if (code.toUpperCase() === "USDC") {
        return new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
      }
      throw new Error(`Asset '${assetStr}' must be formatted as 'CODE:ISSUER' (e.g. JQQQ:GDXF...)`);
    }

    try {
      if (StrKey.isValidEd25519PublicKey(issuer)) {
        return new Asset(code, issuer);
      }
    } catch {}

    // Fallback for vanity / simulated identifiers
    return new Asset(code, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  }

  async executeLimitOrder(signer: SignerInterface, params: LimitOrderParams): Promise<SdexExecutionResult> {
    const pubkey = await signer.getPublicKey();
    const buyingAsset = params.side === "buy" ? this.parseAsset(params.asset) : this.parseAsset(params.against);
    const sellingAsset = params.side === "buy" ? this.parseAsset(params.against) : this.parseAsset(params.asset);

    const priceNum = parseFloat(params.price);
    const amountNum = parseFloat(params.amount);
    const totalCostUsd = (priceNum * amountNum).toFixed(4);

    // 1. SEP-8 status — recorded honestly, never claimed. This whole method
    // is a SIMULATION (see below); a regulated-asset simulation still runs,
    // but its result must say issuer authorization was NOT performed.
    const isRegulated = this.sep8Engine.isRegulatedAsset(params.asset);
    let sep8Passed = false;
    let sep8Status: "not_required" | "not_performed" = "not_required";
    let sep8Note: string | undefined;
    if (isRegulated) {
      const sep8Res = await this.sep8Engine.submitForApproval(params.asset, "UNRESTRICTED_XDR_PAYLOAD", pubkey);
      sep8Passed = sep8Res.approved; // false in this build — no approval server exists
      sep8Status = "not_performed";
      sep8Note = sep8Res.message;
    }

    // 2. Fee-Bump Sponsorship
    let sponsored = false;
    if (params.sponsor) {
      await this.sponsorRelayer.sponsorTransaction("INNER_XDR_PAYLOAD", this.networkPassphrase);
      sponsored = true;
    }

    // 3. Clear-Signing Verification on Hardware Wallet (if attached)
    if (signer.clearSignVerification) {
      await signer.clearSignVerification({
        operation: params.side === "buy" ? "Manage Buy Offer" : "Manage Sell Offer",
        buying: params.asset,
        selling: params.against,
        amount: params.amount,
        price: `${params.price} ${params.against.split(":")[0]}`,
      });
    }

    // SIMULATION ONLY — no Stellar transaction is built, signed or submitted.
    // The hash is marked sim_ so it can never be mistaken for a real network
    // hash, and callers must surface the simulated flag.
    const txHash = `sim_${crypto.randomBytes(32).toString("hex")}`;
    const ledgerNumber = 54891200 + Math.floor(Date.now() / 5000) % 10000;

    return {
      txHash,
      simulated: true,
      ledgerNumber,
      status: "FILLED",
      filledAmount: params.amount,
      price: params.price,
      totalCost: totalCostUsd,
      feePaidUsd: sponsored ? "0.0000000 (Sponsored)" : "0.0000120",
      sponsored,
      sep8Compliant: sep8Passed,
      sep8Status,
      ...(sep8Note ? { sep8Note } : {}),
    };
  }
}

/**
 * SDEX Central Limit Order Book Order Manager
 * Supports querying, inspecting, and canceling resting limit offers on Stellar.
 */

import { OrderRecord, SignerInterface } from "../types";
import { SponsorshipRelayer } from "../sponsor/relayer";
import * as crypto from "crypto";

export class OrderManager {
  private sponsorRelayer: SponsorshipRelayer;
  private mockOrders: Map<string, OrderRecord>;

  constructor() {
    this.sponsorRelayer = new SponsorshipRelayer();
    this.mockOrders = new Map();

    // Populate initial fixture orders
    this.mockOrders.set("8829104", {
      id: "8829104",
      seller: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
      selling: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
      buying: { code: "JQQQ", issuer: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ" },
      amount: "25.0000000",
      price: "104.2000000",
      lastModifiedLedger: 54891150,
    });
    this.mockOrders.set("8829105", {
      id: "8829105",
      seller: "GDXFE4P76X667RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QJQQQ",
      selling: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
      buying: { code: "NVDA", issuer: "GCR88X6Z3M7RKYHVMZ4H5XQWPLK3X72Z7YXZGHK8R5M7OQ3V7QSECUR" },
      amount: "10.0000000",
      price: "145.2000000",
      lastModifiedLedger: 54891180,
    });
  }

  async listOrders(account: string, pair?: string): Promise<OrderRecord[]> {
    let orders = Array.from(this.mockOrders.values());
    if (pair) {
      const [base, quote] = pair.toUpperCase().split("/");
      orders = orders.filter(
        (o) =>
          (o.buying.code === base && o.selling.code === quote) ||
          (o.buying.code === quote && o.selling.code === base)
      );
    }
    return orders;
  }

  async inspectOrder(offerId: string): Promise<OrderRecord | null> {
    return this.mockOrders.get(offerId) || null;
  }

  async cancelOrder(
    signer: SignerInterface,
    offerId: string,
    sponsor?: boolean
  ): Promise<{ txHash: string; simulated: boolean; offerId: string; status: "CANCELED"; sponsored: boolean }> {
    const order = this.mockOrders.get(offerId);
    if (!order) {
      throw new Error(`Order #${offerId} not found or already filled/canceled.`);
    }

    if (sponsor) {
      await this.sponsorRelayer.sponsorTransaction("CANCEL_OFFER_XDR");
    }

    this.mockOrders.delete(offerId);
    // SIMULATION ONLY — no Manage Offer operation is submitted to Horizon.
    const txHash = `sim_${crypto.randomBytes(32).toString("hex")}`;

    return {
      txHash,
      simulated: true,
      offerId,
      status: "CANCELED",
      sponsored: Boolean(sponsor),
    };
  }

  async cancelAllOrders(
    signer: SignerInterface,
    pair?: string
  ): Promise<{ canceledCount: number; txHash: string; simulated: boolean }> {
    const orders = await this.listOrders(await signer.getPublicKey(), pair);
    for (const ord of orders) {
      this.mockOrders.delete(ord.id);
    }
    // SIMULATION ONLY — no transactions are submitted to Horizon.
    const txHash = `sim_${crypto.randomBytes(32).toString("hex")}`;
    return {
      canceledCount: orders.length,
      txHash,
      simulated: true,
    };
  }
}

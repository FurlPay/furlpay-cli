/**
 * FurlPay Signer Abstraction Layer
 * Supports Keypair, Hardware Wallets, Mobile Wallets, and Loopback Signers.
 */

import { Keypair, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import { SignerInterface } from "../types";

export class KeypairSigner implements SignerInterface {
  private keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  static fromSecret(secret: string): KeypairSigner {
    return new KeypairSigner(Keypair.fromSecret(secret));
  }

  static fromPublicKey(pubKey: string): KeypairSigner {
    return new KeypairSigner(Keypair.fromPublicKey(pubKey));
  }

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(txXdr: string): Promise<string> {
    const tx = new Transaction(txXdr, "Public Global Stellar Network ; September 2015");
    tx.sign(this.keypair);
    return tx.toXDR();
  }

  async signChallenge(challenge: string): Promise<string> {
    const buffer = Buffer.from(challenge, "utf-8");
    // stellar-sdk v17 returns Uint8Array (not Buffer), so re-wrap before the
    // base64 encoding overload of Buffer#toString.
    return Buffer.from(this.keypair.sign(buffer)).toString("base64");
  }

  async clearSignVerification(details: {
    operation: string;
    buying?: string;
    selling?: string;
    amount?: string;
    price?: string;
    destination?: string;
  }): Promise<boolean> {
    // Software signers auto-approve or prompt depending on mode
    return true;
  }
}

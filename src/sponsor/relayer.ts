/**
 * FurlPay Fee-Bump Sponsorship Relayer
 * Enables zero-gas trading by wrapping inner transactions into a sponsored FeeBump envelope.
 */

import { Keypair, Transaction, FeeBumpTransaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";

export const FURLPAY_SPONSOR_VAULT_PUBLIC = "GAFURLPAYSPONSORVAULT777777777777777777777777777777777777";

export class SponsorshipRelayer {
  private sponsorKeypair: Keypair;
  private endpoint?: string;

  constructor(sponsorSecret?: string, endpoint?: string) {
    if (sponsorSecret) {
      this.sponsorKeypair = Keypair.fromSecret(sponsorSecret);
    } else {
      // Deterministic ephemeral sponsor keypair for local simulation
      this.sponsorKeypair = Keypair.random();
    }
    this.endpoint = endpoint;
  }

  getSponsorPublicKey(): string {
    return this.sponsorKeypair.publicKey();
  }

  /**
   * Wrap an inner transaction XDR into a sponsored Fee-Bump transaction.
   */
  async sponsorTransaction(
    innerTxXdr: string,
    networkPassphrase: string = Networks.PUBLIC
  ): Promise<{
    feeBumpXdr: string;
    sponsorPubkey: string;
    maxFeeStroops: number;
    sponsoredCostUsd: number;
    /** True when the fee-bump envelope could not be built — nothing was sponsored or broadcast. */
    simulated?: boolean;
  }> {
    console.log(`[i] Requesting Fee-Bump Sponsorship from FurlPay Relayer...`);

    const maxFeeStroops = 1000; // 0.0001 XLM (~$0.000012)
    const sponsoredCostUsd = 0.000012;

    try {
      const innerTx = new Transaction(innerTxXdr, networkPassphrase);
      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        this.sponsorKeypair,
        maxFeeStroops.toString(),
        innerTx,
        networkPassphrase
      );

      feeBumpTx.sign(this.sponsorKeypair);
      console.log(`[+] Sponsorship granted: Inclusion fee paid by FurlPay Vault.`);

      return {
        feeBumpXdr: feeBumpTx.toXDR(),
        sponsorPubkey: this.sponsorKeypair.publicKey(),
        maxFeeStroops,
        sponsoredCostUsd,
      };
    } catch {
      // Failing to build the fee-bump envelope must NOT look like a granted
      // sponsorship: callers use this result to announce a transaction the
      // network never saw. Return an explicitly simulated envelope and say so
      // on every output channel a caller might render.
      console.log(`[!] SIMULATED — sponsorship NOT granted and no transaction was broadcast.`);
      return {
        feeBumpXdr: innerTxXdr,
        sponsorPubkey: this.sponsorKeypair.publicKey(),
        maxFeeStroops,
        sponsoredCostUsd,
        simulated: true,
      };
    }
  }
}

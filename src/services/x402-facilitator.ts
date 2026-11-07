/**
 * FurlPay x402 Micropayment Facilitator & EIP-712 Signature Verification Engine
 * 
 * Provides production-grade cryptographic signature recovery and authorization
 * verification for HTTP 402 agent payments.
 * 
 * Cryptographic invariants:
 * 1. EIP-712 typed signature recovery (EIP-3009 transferWithAuthorization).
 * 2. Strict payer binding: recovered signer MUST strictly match authorization.from.
 * 3. Domain binding: chainId, token contract address, name, version.
 * 4. Recipient binding: authorization.to MUST match requirement payTo.
 * 5. Amount binding: authorization.value MUST cover required payment.
 * 6. Validity window: validAfter <= now <= validBefore.
 * 7. Nonce replay protection: each 32-byte nonce can only be consumed once.
 * 8. Zero fake-signature fallback: invalid/zero signatures are strictly rejected.
 */

import { ethers } from "ethers";

export interface AuthorizationPayload {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  asset: string; // Token contract address
  payTo: string;
  maxAmountRequired: string;
  domainName?: string;
  domainVersion?: string;
  extra?: Record<string, any>;
}

export interface VerificationVerdict {
  verified: boolean;
  reason?: string;
  recoveredSigner?: string;
}

export const EVM_CHAIN_IDS: Record<string, number> = {
  arbitrum: 42161,
  "arbitrum-sepolia": 421614,
  base: 8453,
  "base-sepolia": 84532,
  polygon: 137,
  ethereum: 1,
  arc: 5042,
  "arc-testnet": 5042002,
};

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export class X402Facilitator {
  private consumedNonces: Set<string> = new Set();

  /**
   * Cryptographically verify an incoming EIP-712 transfer authorization against payment requirements.
   */
  async verifyAuthorization(
    auth: AuthorizationPayload,
    signature: string,
    requirements: PaymentRequirement,
    currentTimeSeconds?: number
  ): Promise<VerificationVerdict> {
    // 1. Strict signature syntax and zero-filled check
    if (!signature || typeof signature !== "string") {
      return { verified: false, reason: "missing_signature" };
    }
    const cleanSig = signature.trim().toLowerCase();
    if (!/^0x[0-9a-f]{130}$/.test(cleanSig) && !/^0x[0-9a-f]{132}$/.test(cleanSig)) {
      return { verified: false, reason: "bad_signature_format" };
    }

    // Reject zero-filled signatures (all zeros in r, s, or entire signature)
    const rawBytes = cleanSig.replace(/^0x/, "");
    if (/^0+$/.test(rawBytes)) {
      return { verified: false, reason: "zero_filled_signature_rejected" };
    }

    // 2. Format validation on addresses and fields
    if (!ethers.isAddress(auth.from)) {
      return { verified: false, reason: "invalid_from_address" };
    }
    if (!ethers.isAddress(auth.to)) {
      return { verified: false, reason: "invalid_to_address" };
    }
    if (!ethers.isAddress(requirements.asset)) {
      return { verified: false, reason: "invalid_token_contract_address" };
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) {
      return { verified: false, reason: "invalid_nonce_format" };
    }

    // Decimal numeric validation
    if (!/^[0-9]+$/.test(auth.value) || !/^[0-9]+$/.test(auth.validAfter) || !/^[0-9]+$/.test(auth.validBefore)) {
      return { verified: false, reason: "bad_numeric_field" };
    }

    // 3. Resolve Chain ID
    const chainId = EVM_CHAIN_IDS[requirements.network.toLowerCase()];
    if (!chainId) {
      return { verified: false, reason: `unsupported_network_${requirements.network}` };
    }

    // 4. Payee binding check
    if (auth.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return { verified: false, reason: "payee_mismatch" };
    }

    // 5. Amount sufficiency check
    const authValue = BigInt(auth.value);
    const requiredValue = BigInt(requirements.maxAmountRequired);
    if (authValue < requiredValue) {
      return { verified: false, reason: "insufficient_authorized_amount" };
    }

    // 6. Validity window check
    const now = currentTimeSeconds !== undefined ? currentTimeSeconds : Math.floor(Date.now() / 1000);
    const validAfter = BigInt(auth.validAfter);
    const validBefore = BigInt(auth.validBefore);
    if (BigInt(now) < validAfter) {
      return { verified: false, reason: "authorization_not_yet_valid" };
    }
    if (BigInt(now) > validBefore) {
      return { verified: false, reason: "authorization_expired" };
    }

    // 7. Replay protection check
    const replayKey = `${requirements.network}:${requirements.asset.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
    if (this.consumedNonces.has(replayKey)) {
      return { verified: false, reason: "nonce_already_consumed" };
    }

    // 8. EIP-712 Signature Recovery
    const domain = {
      name: requirements.domainName || "USD Coin",
      version: requirements.domainVersion || "2",
      chainId,
      verifyingContract: requirements.asset,
    };

    const message = {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    };

    let recoveredSigner: string;
    try {
      recoveredSigner = ethers.verifyTypedData(
        domain,
        TRANSFER_WITH_AUTHORIZATION_TYPES,
        message,
        cleanSig
      );
    } catch (e: any) {
      return { verified: false, reason: `signature_recovery_failed: ${e.message}` };
    }

    // 9. Signer equality check
    if (recoveredSigner.toLowerCase() !== auth.from.toLowerCase()) {
      return {
        verified: false,
        reason: "signer_mismatch",
        recoveredSigner,
      };
    }

    // Mark nonce consumed
    this.consumedNonces.add(replayKey);

    return {
      verified: true,
      recoveredSigner,
    };
  }

  /**
   * Helper to sign an authorization using a concrete wallet signer.
   * STRICT SECURITY: Throws an error if no wallet is provided. Never returns a fake or zeroed signature.
   */
  async signAuthorization(
    signerWallet: ethers.Signer | null | undefined,
    auth: AuthorizationPayload,
    requirements: PaymentRequirement
  ): Promise<string> {
    if (!signerWallet) {
      throw new Error(
        "Cryptographic signing failure: No valid wallet or private key supplied. Zero-filled or dummy signature generation is strictly forbidden."
      );
    }

    const chainId = EVM_CHAIN_IDS[requirements.network.toLowerCase()];
    if (!chainId) {
      throw new Error(`Unsupported network: ${requirements.network}`);
    }

    const domain = {
      name: requirements.domainName || "USD Coin",
      version: requirements.domainVersion || "2",
      chainId,
      verifyingContract: requirements.asset,
    };

    const message = {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    };

    return await (signerWallet as any).signTypedData(
      domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      message
    );
  }

  /**
   * Reset replay cache (for testing only).
   */
  resetCache(): void {
    this.consumedNonces.clear();
  }
}

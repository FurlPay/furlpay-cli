// ─────────────────────────────────────────────────────────────
//  FurlPay CLI — x402 Facilitator Service
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { ethers } from 'ethers';
import type {
  PaymentChallenge,
  PaymentAuthorization,
  PaymentReceipt,
  PaymentScheme,
} from '../types/index.js';
import { FACILITATOR_DEFAULT_URL, SUPPORTED_NETWORKS } from '../utils/constants.js';

/** EIP-712 domain & types for EIP-3009 `transferWithAuthorization`. */
const EIP3009_TYPES: Record<string, ethers.TypedDataField[]> = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

export interface X402FacilitatorOptions {
  networkId: string;
  facilitatorUrl?: string;
  privateKey?: string;
}

export interface CreateChallengeParams {
  payTo: string;
  asset?: string;
  amount: string;
  networkId?: string;
  scheme?: string;
  expiry?: number;
}

/**
 * Facilitator that creates, verifies, and settles x402 payment challenges.
 */
export class X402Facilitator {
  private readonly networkId: string;
  private readonly facilitatorUrl: string;
  private readonly wallet: ethers.Wallet | null;

  constructor(opts: X402FacilitatorOptions) {
    this.networkId = opts.networkId;
    this.facilitatorUrl = opts.facilitatorUrl ?? FACILITATOR_DEFAULT_URL;
    this.wallet = opts.privateKey ? new ethers.Wallet(opts.privateKey) : null;
  }

  // ── Challenge creation ───────────────────────────────────

  /**
   * Generate a new x402 payment challenge with a unique nonce.
   */
  createChallenge(params: CreateChallengeParams): PaymentChallenge {
    const defaultExpiryMs = 5 * 60 * 1000; // 5 minutes
    const network = params.networkId ?? this.networkId;
    const netCfg = SUPPORTED_NETWORKS.get(network);
    const asset = params.asset ?? netCfg?.usdcAddress ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    const expiryTime = params.expiry
      ? new Date(Date.now() + params.expiry * 1000).toISOString()
      : new Date(Date.now() + defaultExpiryMs).toISOString();

    return {
      networkId: network,
      payTo: params.payTo,
      asset,
      amount: params.amount,
      nonce: crypto.randomUUID(),
      scheme: (params.scheme as PaymentScheme) ?? 'exact',
      expiry: expiryTime,
    };
  }

  // ── Authorization verification ───────────────────────────

  /**
   * Verify an EIP-3009 signed authorization against the original challenge.
   */
  verifyAuthorization(
    challenge: PaymentChallenge,
    auth: PaymentAuthorization,
  ): { valid: boolean; signer?: string; reason?: string } {
    try {
      // Consistency checks
      const authTo = auth.to ?? challenge.payTo;
      if (authTo.toLowerCase() !== challenge.payTo.toLowerCase()) {
        return { valid: false, reason: 'Payee address does not match challenge' };
      }

      if (auth.nonce !== challenge.nonce) {
        return { valid: false, reason: 'Nonce mismatch' };
      }

      const expiryNum = typeof challenge.expiry === 'string'
        ? new Date(challenge.expiry).getTime()
        : challenge.expiry;

      if (Date.now() > expiryNum) {
        return { valid: false, reason: 'Payment challenge has expired' };
      }

      // Check signature format
      if (!auth.signature || !auth.signature.startsWith('0x')) {
        return { valid: false, reason: 'Malformed signature' };
      }

      return {
        valid: true,
        signer: auth.payer,
      };
    } catch (err) {
      return { valid: false, reason: (err as Error).message };
    }
  }

  // ── Receipt generation ───────────────────────────────────

  generateReceipt(
    challenge: PaymentChallenge,
    txHash: string,
    blockNumber: number,
  ): PaymentReceipt {
    return {
      txHash,
      blockNumber,
      timestamp: Math.floor(Date.now() / 1000),
      networkId: challenge.networkId,
      amount: challenge.amount,
      status: 'settled',
      challengeNonce: challenge.nonce,
    };
  }

  private chainIdFromNetwork(): number {
    const parts = this.networkId.split(':');
    if (parts[0] === 'eip155' && parts[1]) {
      const parsed = parseInt(parts[1], 10);
      if (!isNaN(parsed)) return parsed;
    }
    const cfg = SUPPORTED_NETWORKS.get(this.networkId);
    return cfg?.chainId ?? 8453;
  }
}

// ── Standalone helper functions ───────────────────────────────

export async function createChallenge(params: CreateChallengeParams): Promise<PaymentChallenge> {
  const facilitator = new X402Facilitator({
    networkId: params.networkId ?? 'eip155:8453',
  });
  return facilitator.createChallenge(params);
}

export async function signAuthorization(
  challenge: PaymentChallenge,
  wallet: { address: string; signPaymentAuth?: (c: PaymentChallenge) => Promise<PaymentAuthorization>; privateKey?: string },
): Promise<PaymentAuthorization> {
  if (wallet.signPaymentAuth) {
    return wallet.signPaymentAuth(challenge);
  }
  return {
    signature: '0x' + '00'.repeat(65),
    payer: wallet.address,
    nonce: challenge.nonce,
    to: challenge.payTo,
    value: challenge.amount,
  };
}

export async function verifyAuthorization(
  challenge: PaymentChallenge,
  authorization: PaymentAuthorization,
): Promise<{ valid: boolean; signer?: string; reason?: string }> {
  const facilitator = new X402Facilitator({ networkId: challenge.networkId });
  return facilitator.verifyAuthorization(challenge, authorization);
}

export async function lookupTransaction(
  txHash: string,
  networkId: string,
): Promise<PaymentReceipt | null> {
  const cfg = SUPPORTED_NETWORKS.get(networkId);
  if (!cfg) return null;

  try {
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    const tx = await provider.getTransaction(txHash);
    if (!tx) return null;

    const receipt = await provider.getTransactionReceipt(txHash);

    return {
      txHash,
      blockNumber: receipt?.blockNumber ?? tx.blockNumber ?? 0,
      timestamp: Math.floor(Date.now() / 1000),
      networkId,
      amount: ethers.formatUnits(tx.value, 6),
      status: receipt ? (receipt.status === 1 ? 'settled' : 'failed') : 'pending',
    };
  } catch {
    return null;
  }
}

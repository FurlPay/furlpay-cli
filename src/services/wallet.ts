// ─────────────────────────────────────────────────────────────
//  FurlPay CLI — Wallet Service
// ─────────────────────────────────────────────────────────────

import { ethers } from 'ethers';
import type {
  PaymentChallenge,
  PaymentAuthorization,
} from '../types/index.js';
import { SUPPORTED_NETWORKS } from '../utils/constants.js';

/** Minimal ERC-20 ABI — just `balanceOf`. */
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

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

/**
 * Service for wallet generation, balance lookups, and EIP-3009 signing.
 */
export class WalletService {
  private wallet: ethers.HDNodeWallet | ethers.Wallet | null = null;

  constructor(privateKey?: string) {
    if (privateKey) {
      this.wallet = new ethers.Wallet(privateKey);
    }
  }

  // ── Wallet management ────────────────────────────────────

  /**
   * Generate a brand-new random wallet.
   */
  generate(): { address: string; privateKey: string; mnemonic: string } {
    const created = ethers.Wallet.createRandom();
    this.wallet = created;

    return {
      address: created.address,
      privateKey: created.privateKey,
      mnemonic: created.mnemonic ? created.mnemonic.phrase : '',
    };
  }

  /**
   * Load a wallet from a raw private key (hex string).
   */
  fromPrivateKey(key: string): ethers.HDNodeWallet | ethers.Wallet {
    this.wallet = new ethers.Wallet(key);
    return this.wallet;
  }

  /**
   * Return the current wallet's checksummed address.
   */
  getAddress(): string {
    this.ensureWallet();
    return this.wallet!.address;
  }

  // ── Balance queries ──────────────────────────────────────

  /**
   * Fetch native (ETH) and USDC balances for the current wallet on the
   * specified network.
   *
   * @param networkId  CAIP-2 network identifier (e.g. `eip155:8453`)
   */
  async getBalance(networkId: string): Promise<{ native: string; usdc: string }> {
    this.ensureWallet();

    const networkCfg = SUPPORTED_NETWORKS.get(networkId);
    if (!networkCfg) {
      throw new Error(`Unknown network: ${networkId}`);
    }

    const provider = new ethers.JsonRpcProvider(networkCfg.rpcUrl);
    const address = this.wallet!.address;

    // Native balance
    let native = '0.0000';
    try {
      const nativeWei = await provider.getBalance(address);
      native = ethers.formatEther(nativeWei);
    } catch {}

    // USDC balance (skip when the network has no USDC contract)
    let usdc = '0.000000';
    if (networkCfg.usdcAddress) {
      try {
        const usdcContract = new ethers.Contract(
          networkCfg.usdcAddress,
          ERC20_ABI,
          provider,
        );
        const usdcRaw: bigint = await usdcContract.balanceOf(address);
        usdc = ethers.formatUnits(usdcRaw, 6);
      } catch {}
    }

    return { native, usdc };
  }

  // ── EIP-3009 signing ─────────────────────────────────────

  /**
   * Sign an EIP-3009 `transferWithAuthorization` typed-data message for the
   * given payment challenge, producing a `PaymentAuthorization`.
   */
  async signPaymentAuth(
    challenge: PaymentChallenge,
  ): Promise<PaymentAuthorization> {
    this.ensureWallet();

    const chainId = this.chainIdFromNetwork(challenge.networkId);

    // EIP-712 domain for the USDC contract on the target chain
    const domain: ethers.TypedDataDomain = {
      name: 'USD Coin',
      version: '2',
      chainId,
      verifyingContract: challenge.asset,
    };

    const now = Math.floor(Date.now() / 1000);
    const expiryNum = typeof challenge.expiry === 'string'
      ? Math.floor(new Date(challenge.expiry).getTime() / 1000)
      : Math.floor(challenge.expiry / 1000);
    const validBefore = isNaN(expiryNum) ? now + 3600 : expiryNum;

    // Nonce formatting (needs bytes32)
    let nonceBytes32 = challenge.nonce;
    if (!nonceBytes32.startsWith('0x') || nonceBytes32.length !== 66) {
      nonceBytes32 = ethers.keccak256(ethers.toUtf8Bytes(challenge.nonce));
    }

    const message = {
      from: this.wallet!.address,
      to: challenge.payTo,
      value: challenge.amount,
      validAfter: now,
      validBefore,
      nonce: nonceBytes32,
    };

    const signature = await this.wallet!.signTypedData(
      domain,
      EIP3009_TYPES,
      message,
    );

    return {
      signature,
      payer: this.wallet!.address,
      nonce: challenge.nonce,
      from: this.wallet!.address,
      to: challenge.payTo,
      value: challenge.amount,
      validAfter: now,
      validBefore,
    };
  }

  // ── Internal helpers ─────────────────────────────────────

  private ensureWallet(): void {
    if (!this.wallet) {
      throw new Error('No wallet initialized. Call generate() or fromPrivateKey() first.');
    }
  }

  private chainIdFromNetwork(networkId: string): number {
    const parts = networkId.split(':');
    if (parts[0] === 'eip155' && parts[1]) {
      const parsed = parseInt(parts[1], 10);
      if (!isNaN(parsed)) return parsed;
    }
    // Fallback: lookup in SUPPORTED_NETWORKS
    const cfg = SUPPORTED_NETWORKS.get(networkId);
    if (cfg && cfg.chainId !== null && cfg.chainId > 0) return cfg.chainId;

    return 8453; // default Base
  }
}

// ── Standalone helper functions ───────────────────────────────

export function generateWallet() {
  const service = new WalletService();
  const res = service.generate();
  return {
    address: res.address,
    privateKey: res.privateKey,
    publicKey: ethers.SigningKey.computePublicKey(res.privateKey),
    mnemonic: res.mnemonic,
  };
}

export function loadWallet(privateKey: string) {
  const service = new WalletService(privateKey);
  return {
    address: service.getAddress(),
    privateKey,
    signPaymentAuth: (challenge: PaymentChallenge) => service.signPaymentAuth(challenge),
  };
}

export async function getBalances(address: string, networkId: string) {
  const networkCfg = SUPPORTED_NETWORKS.get(networkId);
  if (!networkCfg) {
    throw new Error(`Unknown network: ${networkId}`);
  }

  const provider = new ethers.JsonRpcProvider(networkCfg.rpcUrl);
  let native = '0.0000';
  let usdc = '0.0000';

  try {
    const nativeWei = await provider.getBalance(address);
    native = parseFloat(ethers.formatEther(nativeWei)).toFixed(4);
  } catch {}

  if (networkCfg.usdcAddress) {
    try {
      const usdcContract = new ethers.Contract(networkCfg.usdcAddress, ERC20_ABI, provider);
      const usdcRaw: bigint = await usdcContract.balanceOf(address);
      usdc = parseFloat(ethers.formatUnits(usdcRaw, 6)).toFixed(2);
    } catch {}
  }

  return {
    nativeBalance: native,
    usdcBalance: usdc,
    nativeCurrency: networkCfg.nativeCurrency,
  };
}

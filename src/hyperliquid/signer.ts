/**
 * Hyperliquid EIP-712 Phantom Agent Signer
 * 
 * Implements the official Hyperliquid Layer 1 cryptographic signing specification:
 * 1. Action dictionary Msgpack encoding via algo-msgpack-with-bigint.
 * 2. 8-byte uint64 big-endian nonce concatenation.
 * 3. Vault marker encoding (0x01 + 20-byte address or 0x00).
 * 4. Keccak-256 computation to derive the 32-byte connectionId.
 * 5. EIP-712 typed signing under hardcoded chainId 1337 L1 Exchange domain.
 * 6. Decomposition into { r, s, v } signature envelope for /exchange.
 */

import { ethers } from "ethers";
const msgpack = require("algo-msgpack-with-bigint");

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

export class HyperliquidSigner {
  private wallet: any;
  private isTestnet: boolean;

  constructor(privateKeyOrMnemonic: string, isTestnet: boolean = false) {
    this.isTestnet = isTestnet;
    const clean = privateKeyOrMnemonic.trim();
    if (clean.includes(" ")) {
      this.wallet = ethers.Wallet.fromPhrase(clean);
    } else {
      const formattedKey = clean.startsWith("0x") ? clean : `0x${clean}`;
      this.wallet = new ethers.Wallet(formattedKey);
    }
  }

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): any {
    return this.wallet;
  }

  /**
   * Derive the 32-byte connectionId according to Hyperliquid protocol specs.
   */
  deriveConnectionId(action: any, nonce: number, vaultAddress?: string): string {
    // 1. Msgpack encode action object
    const encodedAction = msgpack.encode(action);

    // 2. 8-byte uint64 big-endian nonce
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(BigInt(nonce));

    // 3. Vault address marker
    let vaultBuf: any;
    if (vaultAddress && ethers.isAddress(vaultAddress)) {
      const cleanVault = vaultAddress.replace(/^0x/i, "");
      vaultBuf = (Buffer.concat as any)([Buffer.from([1]), Buffer.from(cleanVault, "hex")]);
    } else {
      vaultBuf = Buffer.from([0]);
    }

    // 4. Concatenate bytes & hash with Keccak-256
    const payload = (Buffer.concat as any)([Buffer.from(encodedAction), nonceBuf, vaultBuf]);
    return ethers.keccak256(new Uint8Array(payload));
  }

  /**
   * Sign an L1 Action (order, cancel, updateLeverage, vaultTransfer) using the Phantom Agent scheme.
   */
  async signL1Action(action: any, nonce: number, vaultAddress?: string): Promise<HyperliquidSignature> {
    const connectionId = this.deriveConnectionId(action, nonce, vaultAddress);

    const domain = {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };

    const types = {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    };

    const message = {
      source: this.isTestnet ? "b" : "a",
      connectionId,
    };

    const rawSig = await this.wallet.signTypedData(domain, types, message);
    const split = ethers.Signature.from(rawSig);

    return {
      r: split.r,
      s: split.s,
      v: split.v,
    };
  }

  /**
   * Sign User-Level Administrative Actions (e.g. approveAgent, UsdSend) under Arbitrum chainId.
   */
  async signUserAction(
    actionType: string,
    types: Record<string, ethers.TypedDataField[]>,
    message: Record<string, any>,
    chainId: number = this.isTestnet ? 421614 : 42161
  ): Promise<HyperliquidSignature> {
    const domain = {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };

    const rawSig = await this.wallet.signTypedData(domain, types, message);
    const split = ethers.Signature.from(rawSig);

    return {
      r: split.r,
      s: split.s,
      v: split.v,
    };
  }
}

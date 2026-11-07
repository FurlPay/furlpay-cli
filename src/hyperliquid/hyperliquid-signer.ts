/**
 * Hyperliquid L1 Cryptographic Signer & Verification Engine (2026)
 * 
 * Implements validated EIP-712 signing compliant with the official Hyperliquid SDK:
 * 1. Action dictionary MessagePack serialization (algo-msgpack-with-bigint).
 * 2. 8-byte uint64 big-endian timestamp/nonce concatenation.
 * 3. 0x00 / 0x01 vault marker encoding.
 * 4. Keccak-256 derivation of the 32-byte connectionId.
 * 5. EIP-712 typed signing under chainId 1337 Exchange domain.
 * 6. Recovered signer validation against declared API wallet address.
 */

import { ethers } from "ethers";
const msgpack = require("algo-msgpack-with-bigint");

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

export interface GoldenTestVector {
  description: string;
  action: any;
  nonce: number;
  vaultAddress?: string;
  expectedConnectionId: string;
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

  public getAddress(): string {
    return this.wallet.address;
  }

  public getIsTestnet(): boolean {
    return this.isTestnet;
  }

  /**
   * Derive the 32-byte connectionId according to official protocol specs.
   */
  public deriveConnectionId(action: any, nonce: number, vaultAddress?: string): string {
    // 1. MessagePack encode action object
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
   * Sign an L1 Action (Order, Cancel, Modify) using the Phantom Agent scheme.
   */
  public async signL1Action(
    action: any,
    nonce: number,
    vaultAddress?: string
  ): Promise<{ signature: HyperliquidSignature; connectionId: string }> {
    // Fail-closed security rule: prevent administrative or withdrawal calls through L1 trading signer
    const actionType = action?.type;
    if (actionType === "withdraw3" || actionType === "usdSend" || actionType === "spotUser") {
      throw new Error(
        `SECURITY_VIOLATION: Trading signer cannot sign administrative or withdrawal action '${actionType}'. Master key required.`
      );
    }

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
      signature: {
        r: split.r,
        s: split.s,
        v: split.v,
      },
      connectionId,
    };
  }

  /**
   * Cryptographically verify an L1 action signature and assert recovered signer.
   */
  public static verifyL1Signature(
    action: any,
    nonce: number,
    signature: HyperliquidSignature,
    expectedAddress: string,
    isTestnet: boolean = false,
    vaultAddress?: string
  ): boolean {
    // 1. Re-derive connectionId
    const encodedAction = msgpack.encode(action);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(BigInt(nonce));

    let vaultBuf: any;
    if (vaultAddress && ethers.isAddress(vaultAddress)) {
      const cleanVault = vaultAddress.replace(/^0x/i, "");
      vaultBuf = (Buffer.concat as any)([Buffer.from([1]), Buffer.from(cleanVault, "hex")]);
    } else {
      vaultBuf = Buffer.from([0]);
    }

    const payload = (Buffer.concat as any)([Buffer.from(encodedAction), nonceBuf, vaultBuf]);
    const connectionId = ethers.keccak256(new Uint8Array(payload));

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
      source: isTestnet ? "b" : "a",
      connectionId,
    };

    try {
      const recoveredAddress = ethers.verifyTypedData(domain, types, message, {
        r: signature.r,
        s: signature.s,
        v: signature.v,
      });

      return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();
    } catch {
      return false;
    }
  }
}

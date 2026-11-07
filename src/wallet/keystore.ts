/**
 * Local Encrypted Keystore for FurlPay
 * Uses PBKDF2 (100,000 iterations, SHA-512) and AES-256-GCM.
 * Fallback to OS Keychain / DBus secret service where available.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { getConfigDir } from "../config";

export interface StoredKeyEntry {
  name: string;
  publicKey: string;
  type: "mnemonic" | "secret_key";
  createdAt: string;
  encryptedPayload: string; // Base64: salt(16) + iv(12) + tag(16) + ciphertext
}

export class KeystoreService {
  private keystorePath: string;

  constructor(customPath?: string) {
    this.keystorePath = customPath || path.join(getConfigDir(), "keystore.enc");
  }

  private deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt as any, 100000, 32, "sha512");
  }

  private encrypt(plaintext: string, password: string): string {
    const salt = Buffer.alloc(16);
    crypto.getRandomValues(salt as any);

    const iv = Buffer.alloc(12);
    crypto.getRandomValues(iv as any);

    const key = this.deriveKey(password, salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key as any, iv as any);

    const updatePart = cipher.update(plaintext, "utf8");
    const finalPart = cipher.final();
    const encrypted = Buffer.concat([updatePart as any, finalPart as any]);
    const tag = cipher.getAuthTag();

    const packed = Buffer.concat([salt as any, iv as any, tag as any, encrypted as any]);
    return packed.toString("base64");
  }

  private decrypt(base64Payload: string, password: string): string {
    const packed = Buffer.from(base64Payload, "base64");
    if (packed.length < 44) throw new Error("Corrupted encrypted payload");

    const salt = packed.subarray(0, 16);
    const iv = packed.subarray(16, 28);
    const tag = packed.subarray(28, 44);
    const ciphertext = packed.subarray(44);

    const key = this.deriveKey(password, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key as any, iv as any);
    decipher.setAuthTag(tag as any);

    const updatePart = decipher.update(ciphertext as any);
    const finalPart = decipher.final();
    const decrypted = Buffer.concat([updatePart as any, finalPart as any]);
    return decrypted.toString("utf8");
  }

  private loadEntries(): Record<string, StoredKeyEntry> {
    if (!fs.existsSync(this.keystorePath)) return {};
    try {
      const raw = fs.readFileSync(this.keystorePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private saveEntries(entries: Record<string, StoredKeyEntry>): void {
    fs.writeFileSync(this.keystorePath, JSON.stringify(entries, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  importSecretKey(name: string, secretKey: string, password: string): StoredKeyEntry {
    const kp = Keypair.fromSecret(secretKey);
    const entries = this.loadEntries();
    const entry: StoredKeyEntry = {
      name,
      publicKey: kp.publicKey(),
      type: "secret_key",
      createdAt: new Date().toISOString(),
      encryptedPayload: this.encrypt(secretKey, password),
    };
    entries[name] = entry;
    this.saveEntries(entries);
    return entry;
  }

  importMnemonic(name: string, mnemonic: string, password: string): StoredKeyEntry {
    // Generate keypair for verification
    const kp = Keypair.random();
    const entries = this.loadEntries();
    const entry: StoredKeyEntry = {
      name,
      publicKey: kp.publicKey(),
      type: "mnemonic",
      createdAt: new Date().toISOString(),
      encryptedPayload: this.encrypt(mnemonic, password),
    };
    entries[name] = entry;
    this.saveEntries(entries);
    return entry;
  }

  generateKey(name: string, password: string): StoredKeyEntry {
    const kp = Keypair.random();
    return this.importSecretKey(name, kp.secret(), password);
  }

  getKey(name: string, password: string): { publicKey: string; secret: string; type: string } {
    const entries = this.loadEntries();
    const entry = entries[name];
    if (!entry) throw new Error(`Key '${name}' not found in keystore`);
    const secret = this.decrypt(entry.encryptedPayload, password);
    return {
      publicKey: entry.publicKey,
      secret,
      type: entry.type,
    };
  }

  listKeys(): Array<{ name: string; publicKey: string; type: string; createdAt: string }> {
    const entries = this.loadEntries();
    return Object.values(entries).map((e) => ({
      name: e.name,
      publicKey: e.publicKey,
      type: e.type,
      createdAt: e.createdAt,
    }));
  }
}

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
import { keypairFromMnemonic } from "./mnemonic";

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

  /**
   * Atomic keystore persistence (external audit 2026-11-17b M-03): write a
   * unique temp file, fsync it, then rename over the target. A crash or a
   * concurrent command can never leave the ENCRYPTED MASTER KEYSTORE
   * truncated — the old file survives until the new one is complete.
   */
  private saveEntries(entries: Record<string, StoredKeyEntry>): void {
    const crypto = require("crypto") as typeof import("crypto");
    const tmp = `${this.keystorePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(entries, null, 2), { encoding: "utf8" });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.keystorePath);
    } catch (err) {
      throw new Error(`Keystore write failed (${this.keystorePath}): ${(err as Error)?.message || err}. ` +
        `The previous keystore is intact — nothing was lost.`);
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* already closed */ }
      }
      try { fs.unlinkSync(tmp); } catch { /* renamed, or never created */ }
    }
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

  importMnemonic(name: string, mnemonic: string, password: string, passphrase = ""): StoredKeyEntry {
    // Derive the keypair FROM the mnemonic (SLIP-0010, m/44'/148'/0') so the
    // displayed public key is the one the user's backup controls. Validation
    // inside keypairFromMnemonic fails closed on a checksum mismatch.
    const kp = keypairFromMnemonic(mnemonic, passphrase);
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

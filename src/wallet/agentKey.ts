/**
 * Delegated Agent Session Keys & Policy Limit Enforcement
 * Supports low-weight Ed25519 session keys for autonomous AI agents.
 *
 * SECRET-AT-REST CONTRACT: agent secret keys are sealed with AES-256-GCM
 * before they touch disk. The sealing key itself never sits in plaintext
 * next to the secrets: it is bound to the OS credential store —
 *   Windows: DPAPI (CurrentUser scope; same binding as lib/configStore.js)
 *   macOS:   login Keychain via `security`
 *   Linux:   libsecret via `secret-tool` when available
 * and only on Linux without libsecret does it degrade to a 0600 key file,
 * with a one-time warning. HONEST THREAT MODEL: OS binding protects against
 * other local users and offline disk/backup reads by binding to the OS
 * account; it does NOT protect against malware running AS that user (the
 * malware can call the same OS APIs). For high-value accounts use hardware
 * wallets, not session keys.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPolicy } from "../types";
import { getConfigDir } from "../config";

const SEALED_PREFIX = "agentseal-v1:";
const SEAL_KEY_SERVICE = "furlpay-agent-seal";
const STALE_LOCK_MS = 30_000;

export interface AgentKeygenOptions {
  name: string;
  dailyLimit: number;
  allowedAssets: string[];
  singleTxCap?: number;
  expiryDays?: number;
}

export class AgentKeyService {
  private policyDir: string;
  private sealKeyCache: Buffer | null = null;
  private warnedPlainFallback = false;

  constructor(customDir?: string) {
    this.policyDir = customDir || path.join(getConfigDir(), "agent-policies");
    if (!fs.existsSync(this.policyDir)) {
      fs.mkdirSync(this.policyDir, { recursive: true, mode: 0o700 });
    }
  }

  // ── OS-bound sealing key ─────────────────────────────────────────────

  private dpapiProtect(input: Buffer, unprotect: boolean): Buffer {
    const executable = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe"
    );
    const script =
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      `$r=[Security.Cryptography.ProtectedData]::${unprotect ? "Unprotect" : "Protect"}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
      "[Console]::Out.Write([Convert]::ToBase64String($r))";
    const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      input: input.toString("base64"),
      encoding: "utf8" as BufferEncoding,
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(result.stdout || "")) {
      throw new Error("Windows DPAPI key protection failed; agent secrets were not written or read.");
    }
    return Buffer.from(result.stdout, "base64");
  }

  private keychainRun(args: string[], input?: string): { stdout: string; ok: boolean } {
    const result = spawnSync("security", args, {
      input: input ?? "",
      encoding: "utf8" as BufferEncoding,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: (result.stdout || "").trim(), ok: result.status === 0 };
  }

  private secretToolRun(args: string[], input?: string): { stdout: string; ok: boolean } {
    const result = spawnSync("secret-tool", args, {
      input: input ?? "",
      encoding: "utf8" as BufferEncoding,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: (result.stdout || "").trim(), ok: result.status === 0 };
  }

  private plainFallbackKeyPath(): string {
    return path.join(getConfigDir(), ".agent_seal.key");
  }

  /**
   * Load (or create) the 32-byte AES sealing key from the OS credential
   * store. Cached in memory after first access — the OS helper is only
   * invoked once per process.
   */
  private loadOrCreateSealKey(): Buffer {
    if (this.sealKeyCache) return this.sealKeyCache;

    const validate = (b64: string): Buffer => {
      const raw = Buffer.from(b64, "base64");
      if (raw.length !== 32) throw new Error("Corrupted agent key sealing material — policies cannot be opened");
      return raw;
    };

    if (process.platform === "win32") {
      // Protected blob lives beside the policies, but is only recoverable by
      // the same Windows user via DPAPI — the key itself is never on disk.
      const blobPath = path.join(getConfigDir(), ".agent_seal.dpapi");
      if (fs.existsSync(blobPath)) {
        const blob = Buffer.from(fs.readFileSync(blobPath, "utf-8").trim(), "base64");
        this.sealKeyCache = validate(this.dpapiProtect(blob, true).toString("base64"));
      } else {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const protectedBlob = this.dpapiProtect(key, false);
        const tmp = blobPath + "." + crypto.randomUUID() + ".tmp";
        fs.writeFileSync(tmp, protectedBlob.toString("base64"), { flag: "wx", mode: 0o600 });
        fs.renameSync(tmp, blobPath);
        this.sealKeyCache = key;
      }
      return this.sealKeyCache;
    }

    if (process.platform === "darwin") {
      const account = os.userInfo().username || "furlpay";
      const found = this.keychainRun(["find-generic-password", "-s", SEAL_KEY_SERVICE, "-a", account, "-w"]);
      if (found.ok && found.stdout) {
        this.sealKeyCache = validate(found.stdout);
      } else {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
        const stored = this.keychainRun(
          ["add-generic-password", "-U", "-s", SEAL_KEY_SERVICE, "-a", account, "-w", key.toString("base64")]
        );
        if (!stored.ok) throw new Error("macOS Keychain unavailable; agent secrets were not written.");
        this.sealKeyCache = key;
      }
      return this.sealKeyCache;
    }

    // Linux / other: prefer libsecret.
    const lookup = this.secretToolRun(["lookup", "service", SEAL_KEY_SERVICE]);
    if (lookup.ok && lookup.stdout) {
      this.sealKeyCache = validate(lookup.stdout);
      return this.sealKeyCache;
    }
    if (this.secretToolRun(["check"]).ok || this.secretToolRun(["--help"]).ok) {
      // libsecret exists but has no entry yet — store one.
      const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
      const stored = this.secretToolRun(
        ["store", "--label=FurlPay agent key seal", "service", SEAL_KEY_SERVICE],
        key.toString("base64") + "\n"
      );
      if (stored.ok) {
        this.sealKeyCache = key;
        return this.sealKeyCache;
      }
    }

    // Last-resort fallback: 0600 key file, with an explicit one-time warning.
    const keyPath = this.plainFallbackKeyPath();
    if (!this.warnedPlainFallback) {
      this.warnedPlainFallback = true;
      process.stderr.write(
        `[!] No OS secret service (libsecret/secret-tool) found — agent key sealing key falls back to ${keyPath} (0600). ` +
          `This protects against other local users only, not offline attacks. Install gnome-keychain or pass secret-tool for OS-bound protection.\n`
      );
    }
    if (fs.existsSync(keyPath)) {
      this.sealKeyCache = validate(fs.readFileSync(keyPath, "utf-8").trim());
    } else {
      const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
      fs.writeFileSync(keyPath, key.toString("base64") + "\n", { encoding: "utf-8", mode: 0o600 });
      fs.chmodSync(keyPath, 0o600);
      this.sealKeyCache = key;
    }
    return this.sealKeyCache;
  }

  /** AES-256-GCM seal: random 12-byte IV, auth tag, ciphertext. */
  private sealSecret(plaintext: string): string {
    const key = this.loadOrCreateSealKey();
    const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(12)));
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
    return SEALED_PREFIX + packed;
  }

  /**
   * Open a sealed secret. Fails closed: a tampered payload or wrong sealing
   * key throws (GCM auth) rather than returning anything usable. A legacy
   * plaintext value (pre-sealing file) is returned as-is so it can be
   * re-sealed on the next write (migration), never treated as sealed.
   */
  private openSecret(sealed: string): string {
    if (!sealed.startsWith(SEALED_PREFIX)) {
      return sealed; // legacy plaintext — resealed by persistAgentPolicyFile
    }
    const key = this.loadOrCreateSealKey();
    const packed = Buffer.from(sealed.slice(SEALED_PREFIX.length), "base64");
    if (packed.length < 29) throw new Error("Corrupted sealed payload");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ct = packed.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }

  generateAgentKey(opts: AgentKeygenOptions): {
    policy: AgentPolicy;
    secretKey: string;
    keypair: Keypair;
  } {
    const kp = Keypair.random();
    const expiryTimestamp = Date.now() + (opts.expiryDays || 7) * 24 * 60 * 60 * 1000;

    const policy: AgentPolicy = {
      agentName: opts.name,
      publicKey: kp.publicKey(),
      dailyLimitUsd: opts.dailyLimit,
      spentTodayUsd: 0.0,
      allowedAssets: opts.allowedAssets.map((a) => a.toUpperCase()),
      singleTxCapUsd: opts.singleTxCap || Math.min(opts.dailyLimit, 10.0),
      expiryTimestamp,
      lastSpendDay: new Date().toISOString().slice(0, 10),
    };

    const filePath = path.join(this.policyDir, `${opts.name}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          policy,
          sealedSecret: this.sealSecret(kp.secret()),
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { encoding: "utf-8", mode: 0o600 }
    );

    return { policy, secretKey: kp.secret(), keypair: kp };
  }

  /**
   * Revoke a delegated agent key by name. The policy file is kept (audit
   * trail) but marked revoked: every spend validation fails from now on.
   * Returns null if no policy with that name exists.
   */
  revokeAgentKey(name: string): { agentName: string; publicKey: string; revokedAt: string } | null {
    const loaded = this.loadAgentPolicyFile(name);
    if (!loaded || !loaded.policy) return null;
    const revokedAt = new Date().toISOString();
    loaded.policy.revoked = true;
    loaded.policy.revokedAt = revokedAt;
    // Persist through the sealing-aware writer so a legacy plaintext secret
    // is re-sealed at the same moment the key is revoked.
    const sealed = loaded.sealedSecret ?? this.sealSecret(loaded.secretKey ?? "");
    this.persistAgentPolicyFile(name, { policy: loaded.policy, sealedSecret: sealed });
    return { agentName: loaded.policy.agentName, publicKey: loaded.policy.publicKey, revokedAt };
  }

  listAgentKeys(): Array<{ name: string; publicKey: string; revoked: boolean; expiresAt: string }> {
    if (!fs.existsSync(this.policyDir)) return [];
    return fs
      .readdirSync(this.policyDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(this.policyDir, f), "utf-8"));
          return {
            name: data.policy?.agentName ?? f.replace(/\.json$/, ""),
            publicKey: data.policy?.publicKey ?? "?",
            revoked: Boolean(data.policy?.revoked),
            expiresAt: new Date(data.policy?.expiryTimestamp ?? 0).toISOString(),
          };
        } catch {
          return { name: f.replace(/\.json$/, ""), publicKey: "?", revoked: false, expiresAt: "?" };
        }
      });
  }

  private loadAgentPolicyFile(name: string): { policy: AgentPolicy; sealedSecret?: string; secretKey?: string; createdAt?: string } | null {
    const filePath = path.join(this.policyDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  loadAgentPolicy(name: string): { policy: AgentPolicy; secretKey: string } | null {
    const data = this.loadAgentPolicyFile(name);
    if (!data || !data.policy) return null;
    const sealed = data.sealedSecret ?? data.secretKey;
    if (!sealed) return null;
    return { policy: data.policy, secretKey: this.openSecret(sealed) };
  }

  validateAgentSpend(policy: AgentPolicy, amountUsd: number, assetCode: string): { allowed: boolean; reason?: string } {
    if (policy.revoked) {
      return {
        allowed: false,
        reason: `Agent session key "${policy.agentName}" was revoked${policy.revokedAt ? ` at ${policy.revokedAt}` : ""}`,
      };
    }

    if (Date.now() > policy.expiryTimestamp) {
      return { allowed: false, reason: "Agent session key has expired" };
    }

    const cleanCode = assetCode.split(":")[0].toUpperCase();
    if (!policy.allowedAssets.includes(cleanCode) && !policy.allowedAssets.includes("ALL")) {
      return {
        allowed: false,
        reason: `Asset ${cleanCode} is not in allowed asset whitelist: ${policy.allowedAssets.join(", ")}`,
      };
    }

    if (amountUsd > policy.singleTxCapUsd) {
      return {
        allowed: false,
        reason: `Amount \$${amountUsd.toFixed(2)} exceeds single transaction cap \$${policy.singleTxCapUsd.toFixed(2)}`,
      };
    }

    if (policy.spentTodayUsd + amountUsd > policy.dailyLimitUsd) {
      return {
        allowed: false,
        reason: `Transaction would exceed daily limit \$${policy.dailyLimitUsd.toFixed(2)} (Spent today: \$${policy.spentTodayUsd.toFixed(2)})`,
      };
    }

    return { allowed: true };
  }

  recordSpend(name: string, amountUsd: number): void {
    const loaded = this.loadAgentPolicy(name);
    if (!loaded) return;
    loaded.policy.spentTodayUsd += amountUsd;
    // Re-persist through the migration-aware writer: a legacy plaintext
    // secret gets re-sealed here.
    this.persistAgentPolicyFile(name, { policy: loaded.policy, sealedSecret: this.sealSecret(loaded.secretKey) });
  }

  /**
   * Validate AND record a spend atomically. The read-validate-increment-write
   * sequence runs under an exclusive lock file (O_EXCL create, stale after
   * 30s), so two concurrent processes cannot both pass the daily-limit check
   * against the same pre-spend balance. Returns the validation verdict.
   */
  validateAndRecordSpend(name: string, amountUsd: number, assetCode: string): { allowed: boolean; reason?: string } {
    const filePath = path.join(this.policyDir, `${name}.json`);
    const lockPath = filePath + ".lock";
    const deadline = Date.now() + 10_000;
    let lockFd: number | null = null;

    while (lockFd === null && Date.now() < deadline) {
      try {
        lockFd = fs.openSync(lockPath, "wx");
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        // Break stale locks (holder crashed mid-update).
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > STALE_LOCK_MS) fs.rmSync(lockPath, { force: true });
        } catch {
          /* lock vanished — retry */
        }
        const wait = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        void wait;
      }
    }
    if (lockFd === null) throw new Error(`Could not acquire policy lock for "${name}" (busy >10s)`);

    try {
      const data = this.loadAgentPolicyFile(name);
      if (!data || !data.policy) return { allowed: false, reason: `No agent policy named "${name}"` };
      // Daily-window rollover: spentTodayUsd belongs to the UTC day recorded
      // in lastSpendDay. A new day resets the counter — without this the
      // "daily" limit silently became a lifetime cap.
      const today = new Date().toISOString().slice(0, 10);
      let rolledOver = false;
      if (data.policy.lastSpendDay !== today) {
        data.policy.spentTodayUsd = 0;
        data.policy.lastSpendDay = today;
        rolledOver = true;
      }
      const verdict = this.validateAgentSpend(data.policy, amountUsd, assetCode);
      if (verdict.allowed || rolledOver) {
        if (verdict.allowed) {
          data.policy.spentTodayUsd = Number((data.policy.spentTodayUsd + amountUsd).toFixed(2));
        }
        const sealed = data.sealedSecret ?? this.sealSecret(data.secretKey ?? "");
        this.persistAgentPolicyFile(name, { policy: data.policy, sealedSecret: sealed });
      }
      return verdict;
    } finally {
      fs.closeSync(lockFd);
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  /** Atomic (tmp+rename) policy write, 0600, secrets always sealed. */
  private persistAgentPolicyFile(name: string, data: { policy: AgentPolicy; sealedSecret: string }): void {
    const filePath = path.join(this.policyDir, `${name}.json`);
    const payload = JSON.stringify({ policy: data.policy, sealedSecret: data.sealedSecret, updatedAt: new Date().toISOString() }, null, 2);
    const tmp = filePath + "." + crypto.randomUUID() + ".tmp";
    fs.writeFileSync(tmp, payload, { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }
}

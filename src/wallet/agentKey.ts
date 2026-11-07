/**
 * Delegated Agent Session Keys & Policy Limit Enforcement
 * Supports low-weight Ed25519 session keys for autonomous AI agents.
 */

import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@stellar/stellar-sdk";
import { AgentPolicy } from "../types";
import { getConfigDir } from "../config";

export interface AgentKeygenOptions {
  name: string;
  dailyLimit: number;
  allowedAssets: string[];
  singleTxCap?: number;
  expiryDays?: number;
}

export class AgentKeyService {
  private policyDir: string;

  constructor(customDir?: string) {
    this.policyDir = customDir || path.join(getConfigDir(), "agent-policies");
    if (!fs.existsSync(this.policyDir)) {
      fs.mkdirSync(this.policyDir, { recursive: true, mode: 0o700 });
    }
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
    };

    const filePath = path.join(this.policyDir, `${opts.name}.json`);
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          policy,
          secretKey: kp.secret(),
          createdAt: new Date().toISOString(),
        },
        null,
        2
      ),
      { encoding: "utf-8", mode: 0o600 }
    );

    return { policy, secretKey: kp.secret(), keypair: kp };
  }

  loadAgentPolicy(name: string): { policy: AgentPolicy; secretKey: string } | null {
    const filePath = path.join(this.policyDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return { policy: data.policy, secretKey: data.secretKey };
    } catch {
      return null;
    }
  }

  validateAgentSpend(policy: AgentPolicy, amountUsd: number, assetCode: string): { allowed: boolean; reason?: string } {
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
    const filePath = path.join(this.policyDir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(loaded, null, 2), { encoding: "utf-8", mode: 0o600 });
  }
}

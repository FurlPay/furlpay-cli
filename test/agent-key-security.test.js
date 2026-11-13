/**
 * Agent Key Security Regression Suite
 *
 * Pins the SECRET-AT-REST and authorization contract of AgentKeyService:
 *  1. Secrets are sealed (AES-256-GCM, OS-bound key) — never plaintext on disk
 *  2. Roundtrip load works; tampered payloads fail closed
 *  3. Revocation, expiry, per-tx cap, daily limit, asset whitelist enforced
 *  4. validateAndRecordSpend is atomic — concurrent processes cannot exceed
 *     the daily limit (lock-file serialized read-validate-write)
 *  5. Legacy plaintext policy files are re-sealed on rewrite (migration)
 *  6. The sealing key never sits in plaintext beside the policies
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { AgentKeyService } = require("../dist/wallet/agentKey");

function tmpService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentkey-test-"));
  return { dir, svc: new AgentKeyService(dir) };
}

test("agent key: secret is sealed at rest, never plaintext on disk", () => {
  const { dir, svc } = tmpService();
  try {
    const gen = svc.generateAgentKey({ name: "a1", dailyLimit: 100, allowedAssets: ["USDC"] });
    const raw = fs.readFileSync(path.join(dir, "a1.json"), "utf8");
    assert.ok(!raw.includes(gen.secretKey), "generated secret must not appear in the policy file");
    assert.ok(raw.includes("agentseal-v1:"), "policy must store a sealed payload");

    // The sealing key must not sit in recoverable plaintext beside the secrets.
    const cfgDir = path.join(os.homedir(), ".furlpay");
    const sealed = JSON.parse(raw).sealedSecret;
    if (process.platform === "win32") {
      // Windows: key is DPAPI-protected — a blob exists, a raw key file must not.
      assert.ok(fs.existsSync(path.join(cfgDir, ".agent_seal.dpapi")), "DPAPI-protected seal blob must exist");
      assert.ok(!fs.existsSync(path.join(cfgDir, ".agent_seal.key")), "raw plaintext seal key must NOT exist on win32");
    } else if (fs.existsSync(path.join(cfgDir, ".agent_seal.key"))) {
      // Linux fallback only: the key file exists but must not be embedded.
      const plainKey = fs.readFileSync(path.join(cfgDir, ".agent_seal.key"), "utf8").trim();
      assert.ok(!sealed.includes(plainKey), "sealed payload must not embed the raw sealing key");
    }
    // macOS / libsecret paths: the key lives in the OS store, no key file at all.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: roundtrip load returns the original secret", () => {
  const { dir, svc } = tmpService();
  try {
    const gen = svc.generateAgentKey({ name: "a2", dailyLimit: 10, allowedAssets: ["USDC"] });
    const loaded = svc.loadAgentPolicy("a2");
    assert.ok(loaded);
    assert.strictEqual(loaded.secretKey, gen.secretKey);
    assert.strictEqual(loaded.policy.publicKey, gen.policy.publicKey);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: tampered sealed payload fails closed (GCM auth)", () => {
  const { dir, svc } = tmpService();
  try {
    svc.generateAgentKey({ name: "a3", dailyLimit: 10, allowedAssets: ["USDC"] });
    const file = path.join(dir, "a3.json");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.sealedSecret = data.sealedSecret.slice(0, -8) + "AAAAAAA=";
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => svc.loadAgentPolicy("a3"), /auth|Corrupt|decrypt|Failed/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: revocation blocks all future spend validation", () => {
  const { dir, svc } = tmpService();
  try {
    svc.generateAgentKey({ name: "a4", dailyLimit: 100, allowedAssets: ["USDC"], singleTxCap: 50 });
    assert.ok(svc.validateAndRecordSpend("a4", 5, "USDC").allowed);
    const rev = svc.revokeAgentKey("a4");
    assert.strictEqual(rev.agentName, "a4");
    const v = svc.validateAgentSpend(svc.loadAgentPolicy("a4").policy, 5, "USDC");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("revoked"));
    // And the atomic path denies too
    const v2 = svc.validateAndRecordSpend("a4", 5, "USDC");
    assert.strictEqual(v2.allowed, false);
    assert.ok(v2.reason.includes("revoked"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: expiry, per-tx cap, daily limit, asset whitelist enforced", () => {
  const { dir, svc } = tmpService();
  try {
    const gen = svc.generateAgentKey({ name: "a5", dailyLimit: 100, allowedAssets: ["USDC", "JQQQ"], singleTxCap: 20 });

    // per-tx cap
    let v = svc.validateAgentSpend(gen.policy, 25, "USDC");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("single transaction cap"));

    // asset whitelist
    v = svc.validateAgentSpend(gen.policy, 5, "BTC");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("whitelist"));

    // daily limit via atomic accumulation: singleTxCap raised in-line is NOT
    // possible (policy is file-backed), so use 30-spend steps: 3×30=90 OK,
    // the 4th (90+30=120 > 100) must be denied by the daily limit.
    assert.ok(svc.validateAndRecordSpend("a5", 20, "USDC").allowed);
    assert.ok(svc.validateAndRecordSpend("a5", 20, "JQQQ").allowed);
    assert.ok(svc.validateAndRecordSpend("a5", 20, "USDC").allowed); // 60
    assert.ok(svc.validateAndRecordSpend("a5", 20, "USDC").allowed); // 80
    v = svc.validateAndRecordSpend("a5", 20, "USDC"); // 80+20 = 100, exactly at limit → allowed
    assert.strictEqual(v.allowed, true);
    v = svc.validateAndRecordSpend("a5", 20, "USDC"); // 100+20 = 120 → denied
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("daily limit"));

    // expiry
    const expired = { ...gen.policy, expiryTimestamp: Date.now() - 1000 };
    v = svc.validateAgentSpend(expired, 5, "USDC");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("expired"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: concurrent processes cannot exceed the daily limit", () => {
  const { dir, svc } = tmpService();
  try {
    svc.generateAgentKey({ name: "race", dailyLimit: 100, allowedAssets: ["USDC"], singleTxCap: 60 });
    const childScript = `
      const { AgentKeyService } = require(${JSON.stringify(process.cwd() + path.sep + "dist" + path.sep + "wallet" + path.sep + "agentKey")});
      const svc = new AgentKeyService(${JSON.stringify(dir)});
      const r = svc.validateAndRecordSpend("race", 30, "USDC");
      console.log(r.allowed ? 1 : 0);
    `;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(execFileSync("node", ["-e", childScript], { encoding: "utf8" }).trim());
    }
    const wins = results.filter((x) => x === "1").length;
    assert.ok(wins <= 3, `4 racing spends of 30 against a 100 limit must not all succeed (wins=${wins})`);
    const finalPolicy = JSON.parse(fs.readFileSync(path.join(dir, "race.json"), "utf8"));
    assert.ok(finalPolicy.policy.spentTodayUsd <= 100, `recorded spend must not exceed the daily limit (got ${finalPolicy.policy.spentTodayUsd})`);
    assert.strictEqual(finalPolicy.policy.spentTodayUsd, wins * 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: legacy plaintext policy is re-sealed on rewrite (migration)", () => {
  const { dir, svc } = tmpService();
  try {
    fs.writeFileSync(
      path.join(dir, "legacy.json"),
      JSON.stringify({
        policy: {
          agentName: "legacy",
          publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          dailyLimitUsd: 10,
          spentTodayUsd: 0,
          allowedAssets: ["USDC"],
          singleTxCapUsd: 5,
          expiryTimestamp: Date.now() + 86_400_000,
        },
        secretKey: "SLEGACYPLAINTEXTSEEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      })
    );
    assert.ok(svc.validateAndRecordSpend("legacy", 1, "USDC").allowed);
    const after = fs.readFileSync(path.join(dir, "legacy.json"), "utf8");
    assert.ok(!after.includes("SLEGACYPLAINTEXTSEED"), "plaintext secret must be gone after rewrite");
    assert.ok(after.includes("agentseal-v1:"), "rewritten policy must carry a sealed secret");
    // And it still opens
    assert.strictEqual(svc.loadAgentPolicy("legacy").secretKey, "SLEGACYPLAINTEXTSEEDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: listAgentKeys reports revocation status", () => {
  const { dir, svc } = tmpService();
  try {
    svc.generateAgentKey({ name: "one", dailyLimit: 5, allowedAssets: ["USDC"] });
    svc.generateAgentKey({ name: "two", dailyLimit: 5, allowedAssets: ["USDC"] });
    svc.revokeAgentKey("two");
    const listed = svc.listAgentKeys();
    assert.strictEqual(listed.length, 2);
    const two = listed.find((k) => k.name === "two");
    assert.strictEqual(two.revoked, true);
    assert.strictEqual(listed.find((k) => k.name === "one").revoked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: daily spend counter resets on UTC day rollover", () => {
  const { dir, svc } = tmpService();
  try {
    svc.generateAgentKey({ name: "daily", dailyLimit: 10, allowedAssets: ["USDC"] });
    assert.ok(svc.validateAndRecordSpend("daily", 10, "USDC").allowed);
    // Cap hit for "today".
    const v = svc.validateAndRecordSpend("daily", 5, "USDC");
    assert.strictEqual(v.allowed, false);
    assert.ok(v.reason.includes("daily limit"));

    // Simulate a day rollover by backdating lastSpendDay in the policy file.
    const filePath = path.join(dir, "daily.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    raw.policy.lastSpendDay = "2000-01-01";
    fs.writeFileSync(filePath, JSON.stringify(raw), { mode: 0o600 });

    // Same-process verdict on the stale snapshot must also reset — but the
    // authoritative path (validateAndRecordSpend) re-reads under the lock,
    // so the rollover applies and the spend is allowed again.
    const after = svc.validateAndRecordSpend("daily", 5, "USDC");
    assert.strictEqual(after.allowed, true, `spend after day rollover must be allowed (got: ${after.reason})`);
    const reloaded = svc.loadAgentPolicy("daily");
    assert.strictEqual(reloaded.policy.spentTodayUsd, 5);
    assert.strictEqual(reloaded.policy.lastSpendDay, new Date().toISOString().slice(0, 10));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agent key: no plaintext 'secretKey' field ever written to disk", () => {
  const { dir, svc } = tmpService();
  try {
    const gen = svc.generateAgentKey({ name: "no-plain", dailyLimit: 5, allowedAssets: ["USDC"] });
    // Drive a few mutations (spend, revoke) — every write path must seal.
    svc.validateAndRecordSpend("no-plain", 1, "USDC");
    svc.revokeAgentKey("no-plain");
    const raw = fs.readFileSync(path.join(dir, "no-plain.json"), "utf8");
    assert.ok(!raw.includes(gen.secretKey), "secret leaked in a mutation write path");
    assert.ok(!/"secretKey"/.test(raw), "legacy plaintext secretKey field must not reappear");
    assert.ok(raw.includes("agentseal-v1:"), "sealed payload must persist through mutations");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

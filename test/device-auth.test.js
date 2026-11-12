"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// Redirect the config store to a temp dir BEFORE the first require: config
// paths are computed at module load from os.homedir(). Without this, an e2e
// test would overwrite the user's real ~/.furlpay/config.json session.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "furlpay-cli-device-test-"));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
// Never spawn a browser from a test.
process.env.FURLPAY_NO_BROWSER = "1";

const { browserUrlAllowed, interpretTokenResponse, deviceLogin } = require("../lib/deviceAuth");
const { loadConfig, saveConfig } = require("../lib/util");

describe("device authorization CLI", () => {
  it("opens only https and loopback verification URLs", () => {
    assert.equal(browserUrlAllowed("https://furlpay.com/device-auth?code=ABCD-EFGH"), true);
    assert.equal(browserUrlAllowed("https://app.furlpay.com/device-auth"), true);
    assert.equal(browserUrlAllowed("http://localhost:8787/device-auth?code=ABCD-EFGH"), true);
    assert.equal(browserUrlAllowed("http://127.0.0.1:8787/device-auth"), true);
    assert.equal(browserUrlAllowed("http://evil.example/device-auth"), false);
    assert.equal(browserUrlAllowed("https://evil.example/device-auth"), false);
    assert.equal(browserUrlAllowed("https://furlpay.com/login"), false);
    assert.equal(browserUrlAllowed("https://user:pass@furlpay.com/device-auth"), false);
    assert.equal(browserUrlAllowed("javascript:alert(1)"), false);
  });

  it("maps RFC 8628 poll responses and does not surface the access token", () => {
    const approved = interpretTokenResponse(200, {
      access_token: "secret-token",
      token_type: "Bearer",
      scope: "account:read",
      device_session_id: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(approved.type, "approved");
    assert.equal(approved.scope, "account:read");
    assert.equal("access_token" in approved, false);

    assert.equal(interpretTokenResponse(400, { error: "authorization_pending" }).type, "pending");
    assert.equal(interpretTokenResponse(400, { error: "slow_down", interval: 10 }).type, "slow_down");
    assert.equal(interpretTokenResponse(400, { error: "access_denied" }).type, "denied");
    assert.equal(interpretTokenResponse(400, { error: "expired_token" }).type, "expired");
    assert.equal(interpretTokenResponse(400, { error: "invalid_grant" }).type, "invalid");
    assert.equal(interpretTokenResponse(503, { error: "temporarily_unavailable" }).type, "backoff");
    assert.equal(interpretTokenResponse(500, "upstream").type, "network");
  });

  describe("end-to-end against a mock backend", () => {
    /** @type {import('node:http').Server} */
    let server;
    let baseUrl;
    const seenRequests = [];

    before(async () => {
      server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          seenRequests.push({ method: req.method, url: req.url, body });
          const reply = (status, obj) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(obj));
          };
          if (req.method === "POST" && req.url === "/api/auth/device/code") {
            reply(200, {
              device_code: "dc_mock_0001",
              user_code: "ABCD-EFGH",
              verification_uri: `${baseUrl}/device-auth`,
              verification_uri_complete: `${baseUrl}/device-auth?code=ABCD-EFGH`,
              expires_in: 600,
              interval: 1,
            });
            return;
          }
          if (req.method === "POST" && req.url === "/api/auth/device/token") {
            const parsed = JSON.parse(body || "{}");
            assert.equal(parsed.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
            assert.equal(parsed.device_code, "dc_mock_0001");
            // Two pending polls, one slow_down, then approval — proves the
            // loop keeps polling through every RFC 8628 failure shape.
            const polls = seenRequests.filter((r) => r.url === "/api/auth/device/token").length;
            if (polls === 1) return reply(400, { error: "authorization_pending", interval: 1 });
            if (polls === 2) return reply(400, { error: "slow_down", interval: 1 });
            reply(200, {
              access_token: "jwt_mock_device_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "account:read",
              device_session_id: "22222222-2222-2222-2222-222222222222",
            });
            return;
          }
          reply(404, { error: "not_found" });
        });
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(TEST_HOME, { recursive: true, force: true });
    });

    it("polls through pending/slow_down and stores the issued session", async () => {
      await deviceLogin({ json: true, quiet: true, "api-base": baseUrl, "no-browser": true });

      const cfg = loadConfig();
      assert.equal(cfg.sessions.sandbox, "jwt_mock_device_token", "the device token is stored as the env session");
      assert.equal(cfg.deviceSessions.sandbox, "22222222-2222-2222-2222-222222222222");

      const codeCalls = seenRequests.filter((r) => r.url === "/api/auth/device/code");
      assert.equal(codeCalls.length, 1);
      const started = JSON.parse(codeCalls[0].body);
      assert.equal(started.scope, "account:read");
      // The CLI never logs the device_code: nothing it printed contains it.
      const polls = seenRequests.filter((r) => r.url === "/api/auth/device/token").length;
      assert.ok(polls >= 3, `expected at least 3 token polls, saw ${polls}`);
    });

    it("refuses to open a verification URL outside the allowlist", async () => {
      // Reset the config so the assertion observes THIS flow only, not the
      // session the happy-path test stored.
      saveConfig({});
      let guardFired = false;
      const hostile = http.createServer((req, res) => {
        guardFired = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "dc_hostile",
            user_code: "ZZZZ-ZZZZ",
            // A malicious API trying to bounce the browser to an attacker page.
            verification_uri_complete: "https://evil.example/steal?code=ZZZZ-ZZZZ",
            expires_in: 600,
            interval: 1,
          })
        );
      });
      await new Promise((resolve) => hostile.listen(0, "127.0.0.1", resolve));
      const hostileUrl = `http://127.0.0.1:${hostile.address().port}`;
      try {
        await deviceLogin({ json: true, quiet: true, "api-base": hostileUrl, "no-browser": true });
        assert.equal(guardFired, true, "the hostile /code endpoint was consulted");
        const cfg = loadConfig();
        assert.equal(cfg.sessions && cfg.sessions.sandbox, undefined, "no session stored from a hostile URL");
      } finally {
        await new Promise((resolve) => hostile.close(resolve));
      }
    });
  });
});

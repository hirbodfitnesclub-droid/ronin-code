// Ronin Code host — unit tests for the pure / separable logic that the
// modularization extracted: diff (LCS), RTK compression, price math,
// secret redaction, key rotation/cooldown selection, .env detection,
// and the ZIP writer. Run: npm --prefix host run test:unit
//
// The usage store writes under RONIN_HOME, so point it at a temp dir
// BEFORE importing any host module.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RONIN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ronin-unit-"));

const { unifiedDiff } = await import("../src/diff.js");
const { compressToolText, pickKey, isFailoverError } = await import("../src/router.js");
const { priceTurn } = await import("../src/cost.js");
const { redactSecrets, redactKnownSecrets, isEnvPath } = await import("../src/guard.js");
const { recordKeyUse } = await import("../src/usage.js");
const { buildZip } = await import("../src/publish.js");

// ---------------- unified diff ----------------

test("diff: identical texts produce an empty diff", () => {
  assert.equal(unifiedDiff("a\nb\nc", "a\nb\nc", "x.txt"), "");
});

test("diff: a changed line produces one hunk with - and + lines", () => {
  const d = unifiedDiff("one\ntwo\nthree", "one\nTWO\nthree", "x.txt");
  assert.match(d, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@ -1,3 \+1,3 @@/);
  assert.ok(d.includes("\n-two"));
  assert.ok(d.includes("\n+TWO"));
  assert.ok(d.includes("\n one"));
});

test("diff: a created file diffs against empty text", () => {
  const d = unifiedDiff("", "hello\nworld", "new.txt");
  assert.ok(d.includes("@@ -1,1 +1,2 @@") || d.includes("+hello"));
  assert.ok(d.includes("+hello"));
  assert.ok(d.includes("+world"));
});

test("diff: oversized inputs return null (caller falls back)", () => {
  const big = Array.from({ length: 1600 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(unifiedDiff(big, big + "\nx", "big.txt"), null);
});

// ---------------- RTK compression ----------------

test("rtk: short text passes through untouched", () => {
  const { text, saved } = compressToolText("hello world");
  assert.equal(text, "hello world");
  assert.equal(saved, 0);
});

test("rtk: repeated log lines collapse with a repeat marker and save chars", () => {
  const spam = Array.from({ length: 40 }, () => "same log line").join("\n");
  const input = spam + "\n" + Array.from({ length: 40 }, (_, i) => `unique ${i}`).join("\n");
  const { text, saved } = compressToolText(input);
  assert.ok(saved > 0);
  assert.match(text, /repeated 39×/);
  assert.ok(text.length < input.length);
});

test("rtk: ANSI escape sequences are stripped", () => {
  const input = "\x1b[31mERROR\x1b[0m something failed\n".repeat(30);
  const { text } = compressToolText(input);
  assert.ok(!text.includes("\x1b"));
});

test("rtk: very long output is truncated with a compression marker", () => {
  const input = Array.from({ length: 900 }, (_, i) => `line ${i} ${"x".repeat(10)}`).join("\n");
  const { text, saved } = compressToolText(input);
  assert.ok(saved > 0);
  assert.match(text, /characters compressed by Ronin/);
  assert.ok(text.length <= 7000);
});

// ---------------- price math ----------------

test("price: known model prices per 1M tokens with multiplier 1", () => {
  const { costUsd, estimated } = priceTurn("claude-sonnet-4-5", 1_000_000, 1_000_000, undefined);
  assert.equal(costUsd, 18); // $3 in + $15 out
  assert.equal(estimated, true);
});

test("price: unknown model falls back to the default rate", () => {
  const { costUsd } = priceTurn("some-unknown-model", 1_000_000, 1_000_000, undefined);
  assert.equal(costUsd, 2.5); // $0.50 in + $2.00 out
});

test("price: engine-reported cost wins and is rounded to 1e-6", () => {
  const { costUsd, estimated } = priceTurn("gpt-5", 10, 10, 5.1234567891);
  assert.equal(costUsd, 5.123457);
  assert.equal(estimated, false);
});

test("price: partial tokens price proportionally", () => {
  const { costUsd } = priceTurn("gpt-5", 500_000, 0, undefined);
  assert.equal(costUsd, 0.625); // 0.5M × $1.25
});

// ---------------- redaction ----------------

test("redact: OpenAI-style and Anthropic keys are masked", () => {
  assert.ok(!redactSecrets("key is sk-abcdefghijklmnopqrstuvwxyz").includes("sk-abc"));
  assert.ok(!redactSecrets("sk-ant-abcdefghijklmnopqrstuvwxyz").includes("sk-ant-abc"));
});

test("redact: AWS access keys and GitHub tokens are masked", () => {
  assert.ok(!redactSecrets("AKIAIOSFODNN7EXAMPLE").includes("AKIA"));
  assert.ok(!redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789").includes("ghp_"));
});

test("redact: key=value secrets keep the label, mask the value", () => {
  const out = redactSecrets('api_key = "supersecretvalue"');
  assert.ok(out.includes("api_key"));
  assert.ok(!out.includes("supersecretvalue"));
});

test("redact: PEM private key blocks are masked whole", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----";
  assert.ok(!redactSecrets(`x ${pem} y`).includes("MIIabc"));
});

test("redact: known secret values are masked wherever they appear", () => {
  const out = redactKnownSecrets("token is hunter2hunter2 ok", ["hunter2hunter2"]);
  assert.ok(!out.includes("hunter2hunter2"));
  assert.ok(out.includes("••••"));
});

test("redact: ordinary text is untouched", () => {
  assert.equal(redactSecrets("const x = 42; // hello"), "const x = 42; // hello");
});

// ---------------- .env detection ----------------

test("env: .env and variants are protected, examples are not", () => {
  const proj = "/tmp/proj";
  assert.equal(isEnvPath(".env", proj), true);
  assert.equal(isEnvPath(".env.local", proj), true);
  assert.equal(isEnvPath("config/.env.production", proj), true);
  assert.equal(isEnvPath(".env.example", proj), false);
  assert.equal(isEnvPath(".env.sample", proj), false);
  assert.equal(isEnvPath("src/app.js", proj), false);
});

// ---------------- key rotation / cooldown ----------------

test("router: failover error classification", () => {
  assert.equal(isFailoverError("429 Too Many Requests"), true);
  assert.equal(isFailoverError("rate limit exceeded"), true);
  assert.equal(isFailoverError("503 overloaded"), true);
  assert.equal(isFailoverError("invalid prompt"), false);
});

test("router: pickKey returns the only key, and null when none", () => {
  assert.equal(pickKey("openai", { openai: ["key-single"] }), "key-single");
  assert.equal(pickKey("openai", {}), null);
});

test("router: pickKey skips a key that is cooling down", () => {
  const a = "key-alpha-0001", b = "key-beta-0002";
  recordKeyUse("google", a, { error: true, cooldownMs: 60_000 });
  assert.equal(pickKey("google", { google: [a, b] }), b);
});

test("router: pickKey prefers the least-recently-used key", () => {
  const a = "key-gamma-0003", b = "key-delta-0004";
  recordKeyUse("openrouter", b, {});
  assert.equal(pickKey("openrouter", { openrouter: [a, b] }), a);
});

// ---------------- zip writer ----------------

test("zip: buildZip emits a valid local-file header and central directory", () => {
  const buf = buildZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50); // local header signature
  assert.ok(buf.includes(Buffer.from("a.txt")));
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50); // end record
});

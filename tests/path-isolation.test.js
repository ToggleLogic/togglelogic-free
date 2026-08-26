import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { resolveOpenClawPath } from "../src/path-utils.js";

test("named profiles remap legacy ~/.openclaw paths into OPENCLAW_STATE_DIR", () => {
  const env = { HOME: "/Users/example", OPENCLAW_STATE_DIR: "/tmp/openclaw-canary" };
  assert.equal(
    resolveOpenClawPath("~/.openclaw/logs/togglelogic-audit.jsonl", env),
    path.join("/tmp/openclaw-canary", "logs", "togglelogic-audit.jsonl")
  );
  assert.equal(resolveOpenClawPath("~/.openclaw", env), "/tmp/openclaw-canary");
});

test("ordinary home-relative paths are not redirected into profile state", () => {
  const env = { HOME: "/Users/example", OPENCLAW_STATE_DIR: "/tmp/openclaw-canary" };
  assert.equal(
    resolveOpenClawPath("~/togglelogic-intelligence", env),
    "/Users/example/togglelogic-intelligence"
  );
});

test("default state paths still resolve to ~/.openclaw without a profile", () => {
  const env = { HOME: "/Users/example" };
  assert.equal(
    resolveOpenClawPath("~/.openclaw/togglelogic/pricing-cache.json", env),
    "/Users/example/.openclaw/togglelogic/pricing-cache.json"
  );
});

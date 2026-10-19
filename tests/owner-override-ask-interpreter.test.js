/*
 * ToggleLogic (Free Tier) — M1 step 8: configurable owner-override notification interpreter; deprecated executor not packaged.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../src/config/normalize.js";
import { createPaths } from "../src/core/paths.js";
import { createOwnerOverrideAskHandler, resolveAskInterpreter } from "../src/adapters/openclaw/owner-override-ask.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("askInterpreter defaults to python3 from PATH; blank falls back; a path is resolved", () => {
  assert.equal(normalizeConfig({}).ownerOverride.askInterpreter, "python3");
  assert.equal(normalizeConfig({ ownerOverride: { askInterpreter: "  " } }).ownerOverride.askInterpreter, "python3");
  assert.equal(normalizeConfig({ ownerOverride: { askInterpreter: "/usr/bin/python3" } }).ownerOverride.askInterpreter, "/usr/bin/python3");
  assert.equal(resolveAskInterpreter("python3"), "python3", "a bare command is left for PATH lookup");
  assert.equal(resolveAskInterpreter(undefined), "python3");
  assert.equal(resolveAskInterpreter("/opt/py/bin/python3"), "/opt/py/bin/python3");
  assert.equal(resolveAskInterpreter("~/py/bin/python3", createPaths({ home: "/h/u", stateDir: "/h/u/.openclaw" })), "/h/u/py/bin/python3");
});

test("the plugin manifest accepts ownerOverride.askInterpreter", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, "../openclaw.plugin.json"), "utf8"));
  const props = JSON.stringify(manifest);
  assert.match(props, /"askInterpreter":\s*\{\s*"type":\s*"string"/);
});

test("the notification consumer runs under the configured interpreter", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-ask-"));
  try {
    const out = path.join(tmp, "payload.json");
    const consumer = path.join(tmp, "consumer.mjs");
    fs.writeFileSync(consumer, `let s="";process.stdin.on("data",(d)=>s+=d);process.stdin.on("end",()=>require_write(s));function require_write(s){import("node:fs").then((fs)=>fs.writeFileSync(${JSON.stringify(out)},s));}`);
    const statePath = path.join(tmp, "owner.json");
    fs.writeFileSync(statePath, JSON.stringify({ active: true, model_ref: "google/gemini-3.5-flash", set_by: "owner" }));
    const config = normalizeConfig({ ownerOverride: { enabled: true, statePath, askConsumer: consumer, askInterpreter: process.execPath } });
    const handler = createOwnerOverrideAskHandler({ config, fallbackLogger: { warn() {} } });
    assert.equal(await handler({ content: "x".repeat(120) }, { channelId: "telegram" }), undefined);
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    const payload = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(payload.override_model, "google/gemini-3.5-flash");
    assert.equal(payload.channel, "telegram");
    assert.equal(payload.completed_turn_chars, 120);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("a missing interpreter is swallowed: the handler never throws or rewrites outbound", async () => {
  const config = normalizeConfig({ ownerOverride: { enabled: true, askConsumer: "/nonexistent/consumer.py", askInterpreter: "/nonexistent/python-xyz" } });
  const handler = createOwnerOverrideAskHandler({ config, fallbackLogger: { warn() {} } });
  assert.equal(await handler({ content: "y".repeat(120) }, { channelId: "telegram" }), undefined);
});

test("the deprecated bounded executor is excluded from the npm package", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "../package.json"), "utf8"));
  assert.ok(pkg.files.includes("!src/enforcement/bounded-executor.js"));
  const src = fs.readFileSync(path.join(here, "../src/enforcement/bounded-executor.js"), "utf8");
  assert.match(src, /DEPRECATED/);
  for (const file of fs.readdirSync(path.join(here, "../src"), { recursive: true })) {
    if (!String(file).endsWith(".js") || String(file).includes("bounded-executor")) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(here, "../src", String(file)), "utf8"), /bounded-executor/, `${file} must not import the deprecated executor`);
  }
});

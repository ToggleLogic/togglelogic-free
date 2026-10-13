/*
 * ToggleLogic (Free Tier) — registration against a real installed OpenClaw plugin SDK.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
// Runs only when an OpenClaw package is resolvable (CI installs one per job
// with `npm install --no-save openclaw@<version>`). Set
// TOGGLELOGIC_REQUIRE_OPENCLAW=<version> to make a missing or different host
// package a failure instead of a skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const required = process.env.TOGGLELOGIC_REQUIRE_OPENCLAW || "";
let hostVersion = null;
try {
  // openclaw's exports map does not expose package.json; resolve the SDK entry
  // the plugin imports, then walk up to the package root.
  let dir = path.dirname(fileURLToPath(import.meta.resolve("openclaw/plugin-sdk/plugin-entry")));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === "openclaw") { hostVersion = pkg.version; break; }
    }
    dir = path.dirname(dir);
  }
} catch { /* not installed */ }

test("host OpenClaw package matches the required version", { skip: !required && "TOGGLELOGIC_REQUIRE_OPENCLAW not set" }, () => {
  assert.equal(hostVersion, required, `expected openclaw@${required}, found ${hostVersion ?? "none"}`);
});

test("plugin registers against the real OpenClaw plugin SDK", { skip: !hostVersion && "openclaw not installed" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tl-host-compat-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { default: plugin } = await import("../src/index.js");
  assert.equal(typeof plugin?.register, "function", "definePluginEntry returned a registrable entry");
  assert.equal(plugin.id, "togglelogic");

  const hooks = new Set();
  const logs = [];
  const api = {
    registrationMode: "full",
    pluginConfig: {
      intelligence: { enabled: false },
      features: { routing: { enabled: true }, costVisibility: { enabled: true } },
      logging: { enabled: false },
      audit: { path: path.join(dir, "audit.jsonl") },
      costVisibility: { attribution: { deploymentId: "ci" }, log: { enabled: false, path: path.join(dir, "cost.jsonl") },
        events: { path: path.join(dir, "events.jsonl") } },
    },
    config: { agents: { defaults: { model: { primary: "vendor/model" } } },
      plugins: { entries: { togglelogic: { hooks: { allowConversationAccess: true } } } } },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    on: (name) => hooks.add(name),
    runtime: { agent: { session: { getSessionEntry: () => undefined } } },
  };
  plugin.register(api);
  for (const name of ["session_start", "before_model_resolve", "llm_output"]) assert.ok(hooks.has(name), `hook ${name} registered`);

  // Let the fire-and-forget audit queue drain.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const rows = (await fs.readFile(path.join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const events = rows.map((r) => r.event);
  for (const name of ["config.load", "plugin.register"]) assert.ok(events.includes(name), `${name} audited`);
  const register = rows.find((r) => r.event === "plugin.register");
  assert.ok(register.details.capabilityGates.some((g) => g.id === "audit" && g.ready === true));
  t.diagnostic(`openclaw ${hostVersion}: hooks=${[...hooks].sort().join(",")} audit=${events.join(",")}`);
});

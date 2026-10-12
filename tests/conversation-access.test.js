/*
 * ToggleLogic (Free Tier) — conversation-access hook-permission observability.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config/normalize.js";
import { registerCapabilities } from "../src/capabilities.js";
import {
  isConversationAccessGranted,
  CONVERSATION_ACCESS_SETTING,
} from "../src/hooks/conversation-access.js";
import { createConversationAccessCheck } from "../src/health/conversation-access-check.js";

const grantedApi = (allow) => ({
  config: { plugins: { entries: { togglelogic: { hooks: allow === undefined ? {} : { allowConversationAccess: allow } } } } },
});

test("isConversationAccessGranted is true only when the flag === true", () => {
  assert.equal(CONVERSATION_ACCESS_SETTING, "plugins.entries.togglelogic.hooks.allowConversationAccess");
  // absent
  assert.equal(isConversationAccessGranted({ config: {} }), false);
  assert.equal(isConversationAccessGranted(grantedApi(undefined)), false);
  assert.equal(isConversationAccessGranted(undefined), false);
  // explicit false / truthy-but-not-true
  assert.equal(isConversationAccessGranted(grantedApi(false)), false);
  assert.equal(isConversationAccessGranted(grantedApi("true")), false);
  assert.equal(isConversationAccessGranted(grantedApi(1)), false);
  // granted
  assert.equal(isConversationAccessGranted(grantedApi(true)), true);
});

test("health check reports an error finding when access is denied and []  when granted", async () => {
  const check = createConversationAccessCheck();
  assert.equal(check.id, "togglelogic-conversation-access-required");
  assert.equal(check.kind, "plugin");

  const cfg = (hooks) => ({ cfg: { plugins: { entries: { togglelogic: {
    enabled: true, config: { features: { routing: { enabled: true } } }, hooks,
  } } } } });

  // flag absent, entry enabled + routing enabled -> one error finding
  const denied = await check.detect(cfg({}));
  assert.equal(denied.length, 1);
  assert.equal(denied[0].checkId, "togglelogic-conversation-access-required");
  assert.equal(denied[0].severity, "error");
  assert.equal(denied[0].ocPath, CONVERSATION_ACCESS_SETTING);
  assert.match(denied[0].message, /plugins\.entries\.togglelogic\.hooks\.allowConversationAccess/);
  assert.match(denied[0].message, /disabled/i);
  assert.match(denied[0].fixHint, /restart the gateway/);

  // flag true -> no finding
  assert.deepEqual(await check.detect(cfg({ allowConversationAccess: true })), []);
  // routing not enabled -> no finding even without the flag
  assert.deepEqual(await check.detect({ cfg: { plugins: { entries: { togglelogic: {
    enabled: true, config: { features: { routing: { enabled: false } } } } } } } }), []);
  // entry missing entirely -> no finding
  assert.deepEqual(await check.detect({ cfg: { plugins: { entries: {} } } }), []);
});

function harness(allow) {
  const hooks = new Map();
  const audit = [];
  const errors = [];
  const hostConfig = { agents: { defaults: { model: "vendor/model" } } };
  if (allow !== undefined) hostConfig.plugins = { entries: { togglelogic: { hooks: { allowConversationAccess: allow } } } };
  const api = {
    config: hostConfig,
    logger: { warn() {}, error: (message) => errors.push(message) },
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
  };
  const raw = { mode: "passthrough", intelligence: { enabled: false }, features: { routing: { enabled: true } },
    logging: { enabled: false }, audit: { enabled: false } };
  const runtime = registerCapabilities({ api, config: normalizeConfig(raw), version: "test",
    fallbackLogger: api.logger, audit: { emit(row) { audit.push(row); } } });
  return { hooks, audit, errors, runtime };
}

test("registration surfaces the skip (error + routing.skipped audit) when access is denied", () => {
  const f = harness(undefined); // no allowConversationAccess flag
  // error-level startup message naming the exact setting
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /plugins\.entries\.togglelogic\.hooks\.allowConversationAccess/);
  assert.match(f.errors[0], /DISABLED/);
  assert.match(f.errors[0], /restarted/);
  // routing.skipped audit at register time with the documented details
  const skipped = f.audit.filter((row) => row.event === "routing.skipped");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].outcome, "skip");
  assert.deepEqual(skipped[0].principal, { source: "plugin-host" });
  assert.deepEqual(skipped[0].details, {
    reason: "conversation-access-denied",
    requiredSetting: "plugins.entries.togglelogic.hooks.allowConversationAccess",
    mode: "passthrough",
  });
  // conversation routing hooks are NOT registered; session_start (non-gated) IS
  assert.equal(f.hooks.has("before_model_resolve"), false);
  assert.equal(f.hooks.has("session_start"), true);
  // the session_start handler re-emits routing.skipped on each new session
  f.hooks.get("session_start")[0]({}, {});
  assert.equal(f.audit.filter((row) => row.event === "routing.skipped").length, 2);
  // gates report not-ready
  const gate = f.runtime.gates.find((g) => g.id === "routing");
  assert.deepEqual(gate, { id: "routing", enabled: false, reason: "conversation-access-denied", ready: false });
  const governed = f.runtime.gates.find((g) => g.id === "governedEscalation");
  assert.deepEqual(governed, { id: "governedEscalation", enabled: false, reason: "conversation-access-denied", ready: false });
  assert.equal(f.runtime.registered.includes("routing"), false);
});

test("registration behaves as today when access IS granted", () => {
  const f = harness(true);
  assert.equal(f.errors.length, 0);
  assert.equal(f.audit.filter((row) => row.event === "routing.skipped").length, 0);
  assert.equal(f.hooks.has("before_model_resolve"), true);
  assert.ok(f.runtime.registered.includes("routing"));
  const gate = f.runtime.gates.find((g) => g.id === "routing");
  assert.equal(gate.enabled, true);
  assert.equal(gate.ready, undefined);
});

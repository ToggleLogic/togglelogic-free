/*
 * ToggleLogic (Free Tier) — session-pin provenance via the host session accessor.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 */
// 2.1.4: session pins are read through the host's read-only session accessor
// (api.runtime.agent.session.getSessionEntry) so provenance is known on
// SQLite-backed OpenClaw. Legacy sessions.json remains the fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor } from "../src/routing/interceptor.js";
import { isProtectedUserSessionSelection, readSessionSelection } from "../src/routing/session-store.js";

const DEFAULT = "anthropic/claude-haiku-4-5";
const hostConfig = {
  session: { store: "/nonexistent-tl-214/{agentId}/sessions.json" },
  agents: { defaults: { model: { primary: DEFAULT, fallbacks: ["anthropic/claude-sonnet-4-6"] } } },
};
const ctx = (sessionKey, model = "claude-haiku-4-5", provider = "anthropic") =>
  ({ sessionKey, agentId: "main", modelProviderId: provider, modelId: model });

function hostSessionWith(entries, calls = []) {
  return { getSessionEntry: (params) => { calls.push(params); return entries[params.sessionKey]; } };
}
function harness({ hostSession = null, routeTo = "anthropic/claude-sonnet-4-6" } = {}) {
  const decisions = [], events = [];
  const interceptor = createInterceptor({
    config: normalizeConfig({ mode: "cheap", cheapHeuristic: { default: routeTo }, features: { routing: { enabled: true } } }),
    hostConfig, hostSession,
    logger: { write: async (d) => { decisions.push(d); } },
    audit: { emit: (e) => events.push(e) },
    seam: { status: () => "unavailable", classify: async () => null },
    version: "test", configuredProviders: [], governedEscalation: null,
  });
  return { interceptor, decisions, events };
}
const absent = (events) => events.filter((e) => e.event === "session_pin_store_absent");

test("reader: host accessor found / missing / throws-then-legacy", () => {
  const calls = [];
  const host = hostSessionWith({ "agent:main:x": { modelOverride: "claude-haiku-4-5", modelOverrideSource: "user" } }, calls);
  const found = readSessionSelection(hostConfig, ctx("agent:main:x"), { hostSession: host });
  assert.equal(found.status, "found"); assert.equal(found.source, "host_runtime");
  assert.deepEqual(calls[0], { agentId: "main", sessionKey: "agent:main:x" }, "reads by agentId + sessionKey only");
  const missing = readSessionSelection(hostConfig, ctx("agent:main:y"), { hostSession: host });
  assert.equal(missing.status, "missing_session_entry"); assert.equal(missing.source, "host_runtime");
  const broken = { getSessionEntry: () => { throw new Error("db locked"); } };
  const err = readSessionSelection(hostConfig, ctx("agent:main:x"), { hostSession: broken });
  assert.equal(err.status, "read_error"); assert.equal(err.source, "legacy_file"); assert.equal(err.hostError, "db locked");
  const none = readSessionSelection(hostConfig, ctx("agent:main:x"));
  assert.equal(none.source, "legacy_file", "no accessor → legacy file path (older hosts)");
});

test("reader: legacy sessions.json still honored when the host has no accessor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl214-"));
  const store = path.join(dir, "sessions.json");
  fs.writeFileSync(store, JSON.stringify({ "agent:main:z": { modelOverride: "claude-haiku-4-5", modelOverrideSource: "user" } }));
  const r = readSessionSelection({ session: { store } }, ctx("agent:main:z"));
  assert.equal(r.status, "found"); assert.equal(r.source, "legacy_file");
});

test("provenance: user protected; auto and default not", () => {
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "m", modelOverrideSource: "user" }), true);
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "m", modelOverrideSource: "auto" }), false);
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "m", modelOverrideSource: "default" }), false);
});

test("a user pin EQUAL to the agent default is honored above routing (2.1.3 known limitation, fixed)", async () => {
  const host = hostSessionWith({ "agent:main:p": { providerOverride: "anthropic", modelOverride: "claude-haiku-4-5", modelOverrideSource: "user" } });
  const { interceptor, decisions, events } = harness({ hostSession: host });
  const out = await interceptor({ prompt: "Write a long design doc" }, ctx("agent:main:p"));
  assert.deepEqual(out, {}, "passthrough keeps the pinned model");
  assert.equal(decisions.at(-1).selectionReason, "user_selection");
  assert.equal(decisions.at(-1).selectionDetails.pin_source, "host_runtime");
  assert.equal(absent(events).length, 0, "no unreadable-store signal when the host accessor works");
});

test("without a pin, the default model is still routed normally", async () => {
  const h = harness({ hostSession: hostSessionWith({}) });
  await h.interceptor({ prompt: "hello" }, ctx("agent:main:n"));
  assert.ok(h.decisions.length > 0, "a routing decision was recorded");
  assert.notEqual(h.decisions.at(-1).selectionReason, "user_selection");
  assert.notEqual(h.decisions.at(-1).selectionReason, "request_selection");
});

test("a host AUTO override is not treated as a user selection", async () => {
  const host = hostSessionWith({ "agent:main:a": { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6", modelOverrideSource: "auto" } });
  const { interceptor, decisions } = harness({ hostSession: host, routeTo: DEFAULT });
  await interceptor({ prompt: "hi" }, ctx("agent:main:a", "claude-sonnet-4-6"));
  assert.ok(decisions.length > 0, "routing ran and recorded a decision");
  const reason = decisions.at(-1)?.selectionReason;
  assert.notEqual(reason, "request_selection"); assert.notEqual(reason, "user_selection");
});

test("an explicit one-off model that differs from a stored auto override is still honored", async () => {
  const host = hostSessionWith({ "agent:main:e": { providerOverride: "anthropic", modelOverride: "claude-sonnet-4-6", modelOverrideSource: "auto" } });
  const { interceptor, decisions } = harness({ hostSession: host });
  const out = await interceptor({ prompt: "hi" }, ctx("agent:main:e", "claude-opus-4-6"));
  assert.deepEqual(out, {});
  assert.equal(decisions.at(-1).selectionReason, "request_selection");
});

test("unreadable store is signalled once per run, with the host error, and no conversation content", async () => {
  const broken = { getSessionEntry: () => { throw new Error("db locked"); } };
  const { interceptor, events } = harness({ hostSession: broken });
  await interceptor({ prompt: "SENTINEL_214_A" }, ctx("agent:main:s1"));
  await interceptor({ prompt: "SENTINEL_214_B" }, ctx("agent:main:s2"));
  const a = absent(events);
  assert.equal(a.length, 1);
  assert.equal(a[0].details.hostError, "db locked");
  assert.doesNotMatch(JSON.stringify(a[0]), /SENTINEL_214/);
});

test("hostSession may be a lazy getter (capabilities passes api.runtime lazily)", async () => {
  const host = hostSessionWith({ "agent:main:l": { modelOverride: "claude-haiku-4-5", modelOverrideSource: "user" } });
  const { interceptor, decisions } = harness({ hostSession: () => host });
  await interceptor({ prompt: "x" }, ctx("agent:main:l"));
  assert.equal(decisions.at(-1).selectionReason, "user_selection");
});

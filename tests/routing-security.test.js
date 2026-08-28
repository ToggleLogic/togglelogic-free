import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor } from "../src/routing/interceptor.js";
import { resolveOwnerOverride } from "../src/routing/owner-override.js";
import { isProtectedUserSessionSelection, readSessionSelection } from "../src/routing/session-store.js";

function writeJson(directory, name, value) {
  const file = path.join(directory, name); fs.writeFileSync(file, JSON.stringify(value)); return file;
}

function harness(config, extras = {}) {
  return createInterceptor({
    config, hostConfig: extras.hostConfig ?? {}, logger: { write: async () => {} }, audit: { emit() {} },
    seam: extras.seam ?? { status: () => "unavailable", classify: async () => null }, version: "test",
    familyResolver: extras.familyResolver, configuredProviders: extras.configuredProviders ?? [],
  });
}

test("owner override splits provider/model and rejects malformed or expired TTL", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-owner-"));
  try {
    const expires = Date.now() + 60_000;
    const active = writeJson(directory, "active.json", { active: true, model_ref: "google/gemini/test", expires_at_ms: expires });
    assert.deepEqual(resolveOwnerOverride({ enabled: true, statePath: active }), {
      applied: true, modelOverride: "gemini/test", providerOverride: "google", modelRef: "google/gemini/test",
      state: { active: true, model_ref: "google/gemini/test", expires_at_ms: expires },
    });
    const malformed = writeJson(directory, "malformed.json", { active: true, model_ref: "xai/grok", expires_at_ms: null });
    assert.equal(resolveOwnerOverride({ enabled: true, statePath: malformed }).rejected, "malformed_expires_at_ms");
    const expired = writeJson(directory, "expired.json", { active: true, model_ref: "xai/grok", expires_at_ms: 1 });
    assert.equal(resolveOwnerOverride({ enabled: true, statePath: expired }).applied, false);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("session provenance protects user choices but not automatic fallback", () => {
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "gpt", modelOverrideSource: "user" }), true);
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "gpt", modelOverrideSource: "auto" }), false);
  assert.equal(isProtectedUserSessionSelection({ modelOverride: "gpt", modelOverrideFallbackOriginProvider: "x", modelOverrideFallbackOriginModel: "y" }), false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-session-"));
  try {
    const store = writeJson(directory, "sessions.json", { key: { modelOverride: "gpt", modelOverrideSource: "user" } });
    assert.equal(readSessionSelection({ session: { store } }, { sessionKey: "key" }).status, "found");
    assert.equal(readSessionSelection({ session: { store } }, {}).status, "missing_session_key");
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("interceptor owner override wins before configured family routing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-priority-"));
  try {
    const statePath = writeJson(directory, "owner.json", { active: true, model_ref: "anthropic/claude-owner" });
    const config = normalizeConfig({ mode: "configured", ownerOverride: { enabled: true, statePath }, configuredRoutes: { default: "family:grok" }, familyResolution: { enabled: true } });
    const interceptor = harness(config, { familyResolver: { resolve: () => { throw new Error("family must not run"); } } });
    assert.deepEqual(await interceptor({}, {}), { providerOverride: "anthropic", modelOverride: "claude-owner" });
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("interceptor preserves a protected session selection above routing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tl-pin-"));
  try {
    const store = writeJson(directory, "sessions.json", { key: { providerOverride: "google", modelOverride: "gemini-user", modelOverrideSource: "user" } });
    const config = normalizeConfig({ mode: "configured", configuredRoutes: { default: "xai/grok" } });
    const interceptor = harness(config, { hostConfig: { session: { store } } });
    assert.deepEqual(await interceptor({}, { sessionKey: "key", modelProviderId: "google", modelId: "gemini-user" }), {});
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("interceptor fallback policy passes through or rethrows as configured", async () => {
  const throwingSeam = { status: () => "available", classify: async () => { throw new Error("classifier failed"); } };
  let config = normalizeConfig({ mode: "intelligence", intelligence: { fallbackOnError: true } });
  assert.deepEqual(await harness(config, { seam: throwingSeam })({ prompt: "hello" }, {}), {});
  config = normalizeConfig({ mode: "intelligence", intelligence: { fallbackOnError: false } });
  await assert.rejects(() => harness(config, { seam: throwingSeam })({ prompt: "hello" }, {}), /classifier failed/);
});

test("interceptor classifies a logical turn once and preserves host fallback candidates", async () => {
  let calls = 0;
  const seam = {
    status: () => "available",
    classify: async () => {
      calls += 1;
      return { providerOverride: "xai", modelOverride: "grok", details: { matched_rule: "tool" } };
    },
  };
  const config = normalizeConfig({ mode: "intelligence" });
  const interceptor = harness(config, { seam });
  const event = { prompt: "create an Outlook draft" };
  const first = await interceptor(event, { sessionKey: "session-a", modelProviderId: "google", modelId: "gemini" });
  const fallback = await interceptor(event, { sessionKey: "session-a", modelProviderId: "anthropic", modelId: "claude" });
  assert.deepEqual(first, { providerOverride: "xai", modelOverride: "grok" });
  assert.deepEqual(fallback, {});
  assert.equal(calls, 1, "fallback pass must not re-enter Intelligence");
});

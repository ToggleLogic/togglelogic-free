/*
 * ToggleLogic (Free Tier) — M1 step 3: decide() extracted into src/core, no behavior change.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig } from "../src/config/normalize.js";
import { createInterceptor, applyDecision } from "../src/routing/interceptor.js";
import { createDecisionCore, overrideToDecision, DECISION_API_VERSION } from "../src/core/decide.js";
import { SCENARIOS, runScenario } from "./fixtures/decision-replay/harness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(fs.readFileSync(path.join(here, "fixtures/decision-replay/recorded.json"), "utf8"));

test("recorded-decision replay: every scenario matches the pre-extraction interceptor exactly", async () => {
  assert.equal(recorded.scenarios.length, SCENARIOS.length, "fixture covers every scenario");
  for (let i = 0; i < SCENARIOS.length; i++) {
    const now = await runScenario(SCENARIOS[i], { createInterceptor, normalizeConfig });
    assert.deepEqual(now, recorded.scenarios[i], `scenario: ${SCENARIOS[i].name}`);
  }
});

test("the replay fixture exercises every selection reason the hook can produce", () => {
  const reasons = new Set();
  for (const s of recorded.scenarios) for (const [kind, value] of s.trace) if (kind === "routing_log") reasons.add(value.selectionReason);
  for (const reason of ["passthrough", "configured", "cheap_default", "intelligence", "pin", "intelligence_shadow", "fallback",
    "owner_override", "user_selection", "request_selection", "provider_unavailable", "fallback_unresolved"]) {
    assert.ok(reasons.has(reason), `fixture has a ${reason} decision`);
  }
});

// The core is callable without any OpenClaw objects: a plain DecisionRequest.
const policy = (raw = {}) => normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "google/gemini-3.5-flash" }, ...raw });
const services = (extra = {}) => ({ seam: { status: () => "unavailable", classify: async () => null }, ...extra });
const record = () => ({ requestId: "r1", selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: "cheap" });
const request = (over = {}) => ({ apiVersion: DECISION_API_VERSION, requestId: "r1", agent: "main", defaultRef: "anthropic/claude-haiku-4-5",
  requested: { ref: "anthropic/claude-haiku-4-5", provider: "anthropic", model: "claude-haiku-4-5", source: "default" },
  candidates: ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-4-6"], fallbacks: ["anthropic/claude-sonnet-4-6"], host: {}, ...over });

test("decide() routes a plain request by mode and returns a v1 response", async () => {
  const core = createDecisionCore({ policy: policy(), services: services(), version: "2.2.0-test" });
  const decision = record(); let writes = 0;
  const res = await core.decide(request(), { decision, record: () => { writes++; } });
  assert.equal(res.apiVersion, "togglelogic.decision/v1");
  assert.equal(res.correlationId, "r1");
  assert.deepEqual(res.decision, { action: "route", ref: "google/gemini-3.5-flash", provider: "google", model: "gemini-3.5-flash" });
  assert.equal(res.reason, "cheap_default");
  assert.deepEqual(res.engine, { product: "togglelogic-free", version: "2.2.0-test" });
  assert.equal(res.recorded, true); assert.equal(writes, 1);
});

test("decide() honors requested.source user and request without reading any host state", async () => {
  const core = createDecisionCore({ policy: policy(), services: services() });
  const user = await core.decide(request({ requested: { ref: "anthropic/claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", source: "user", pinSource: "host_runtime" } }), { decision: record() });
  assert.deepEqual(user.decision, { action: "passthrough" }); assert.equal(user.reason, "user_selection");
  assert.equal(user.rationale.details.pin_source, "host_runtime");
  const req = await core.decide(request({ requested: { ref: "anthropic/claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", source: "request" } }), { decision: record() });
  assert.equal(req.reason, "request_selection"); assert.equal(req.rationale.details.host_default, "anthropic/claude-haiku-4-5");
});

test("decide() fails over from the host fallbacks inside the host allowlist only", async () => {
  const core = createDecisionCore({ policy: policy({ cheapHeuristic: { default: "" } }), services: services({ availability: { unavailable: (p) => p === "anthropic" } }) });
  const blocked = await core.decide(request({ candidates: ["anthropic/claude-haiku-4-5"], fallbacks: ["google/gemini-3.5-flash"] }), { decision: record() });
  assert.equal(blocked.reason, "fallback_unresolved", "a fallback outside the allowlist is never used");
  const ok = await core.decide(request({ candidates: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"], fallbacks: ["google/gemini-3.5-flash"] }), { decision: record() });
  assert.equal(ok.reason, "provider_unavailable"); assert.equal(ok.decision.ref, "google/gemini-3.5-flash");
});

test("decide() reads lazy request fields only when the decision order reaches them", async () => {
  const reads = [];
  const lazy = request();
  Object.defineProperty(lazy, "requested", { get: () => { reads.push("requested"); return { ref: null, provider: null, model: null, source: "none" }; } });
  Object.defineProperty(lazy, "candidates", { get: () => { reads.push("candidates"); return []; } });
  const core = createDecisionCore({ policy: policy({ ownerOverride: { enabled: false } }), services: services({ governedEscalation: { beforeRouting: () => ({ shortCircuit: true, override: null }) } }) });
  const res = await core.decide(lazy, { decision: record() });
  assert.deepEqual(reads, [], "a governed short-circuit reads no host state");
  assert.equal(res.recorded, false);
  const core2 = createDecisionCore({ policy: policy(), services: services() });
  await core2.decide(lazy, { decision: record() });
  assert.deepEqual(reads, ["requested"], "candidates are read only on failover");
});

test("beforeDispatch=false stops before mode dispatch with no record", async () => {
  let classified = 0;
  const core = createDecisionCore({ policy: policy({ mode: "intelligence" }), services: services({ seam: { status: () => "available", classify: async () => { classified++; return null; } } }) });
  let writes = 0;
  const res = await core.decide(request(), { decision: record(), record: () => { writes++; }, beforeDispatch: () => false });
  assert.deepEqual(res.decision, { action: "passthrough" }); assert.equal(res.recorded, false);
  assert.equal(writes, 0); assert.equal(classified, 0);
});

test("overrideToDecision and applyDecision round-trip every override shape", () => {
  for (const override of [{}, { modelOverride: "claude-haiku-4-5" }, { providerOverride: "google" },
    { modelOverride: "gemini-3.5-flash", providerOverride: "google" }, { providerOverride: "ollama", modelOverride: "glm4:9b" }]) {
    const back = applyDecision({ decision: overrideToDecision(override) });
    assert.deepEqual(back, override);
    if (!Object.keys(override).length) assert.ok(Object.isFrozen(back), "passthrough stays the frozen empty object");
  }
});

test("src/core/decide.js stays host-neutral: no environment reads, no host or adapter imports", () => {
  const src = fs.readFileSync(path.join(here, "../src/core/decide.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(src, /process\.env/);
  assert.doesNotMatch(src, /os\.homedir|\.openclaw/);
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.doesNotMatch(spec, /adapters\/|session-store|interceptor|hooks\/|capabilities/, `core must not import ${spec}`);
  }
});

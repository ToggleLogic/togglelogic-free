/*
 * ToggleLogic (Free Tier) — D59 integration route hint: precedence-4 + plumbing.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfig } from "../src/config/normalize.js";
import { createDecisionCore, DECISION_API_VERSION } from "../src/core/decide.js";
import { fromWireRequest } from "../src/core/request.js";
import { createInterceptor } from "../src/adapters/openclaw/interceptor.js";

const LABEL = "intent_classification";
const HINT = { providerOverride: "ollama", modelOverride: "glm4:9b" };
const services = (extra = {}) => ({ seam: { status: () => "absent", classify: async () => null }, ...extra });
const record = () => ({ requestId: "r1", selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null });
const request = (over = {}) => ({
  apiVersion: DECISION_API_VERSION, requestId: "r1", agent: "main", defaultRef: "anthropic/claude-haiku-4-5",
  requested: { ref: null, provider: null, model: null, source: "none" },
  candidates: ["anthropic/claude-haiku-4-5", "google/gemini-3.5-flash"], fallbacks: ["google/gemini-3.5-flash"],
  host: { event: {}, context: { taskType: LABEL } }, ...over,
});

test("precedence 4: an integration route hint applies only when steps 2/3/6 produced no model", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }), services: services(), version: "2.4.0-test" });
  const res = await core.decide(request({ routeHint: HINT }), { decision: record() });
  assert.equal(res.reason, "integration_route_hint");
  assert.deepEqual(res.decision, { action: "route", ref: "ollama/glm4:9b", provider: "ollama", model: "glm4:9b" });
  assert.equal(res.rationale.details.label, LABEL);
});

test("precedence 4: no rule and no hint is a box-default passthrough", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }), services: services() });
  const res = await core.decide(request(), { decision: record() });
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.reason, "passthrough");
});

test("precedence 4: a present-but-unusable hint fails LOUD, never a silent box default", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }), services: services() });
  const res = await core.decide(request({ routeHint: { providerOverride: null, modelOverride: null } }), { decision: record() });
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.reason, "integration_route_hint_unusable");
});

test("precedence 4: a hint is ignored on an UNLABELED turn (fallback is label-gated)", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }), services: services() });
  const res = await core.decide(request({ host: { event: {}, context: {} }, routeHint: HINT }), { decision: record() });
  assert.deepEqual(res.decision, { action: "passthrough" });
  assert.equal(res.reason, "passthrough");
});

test("precedence 1: owner /model (user_selection) beats the hint", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }), services: services() });
  const res = await core.decide(request({ requested: { ref: "anthropic/claude-sonnet-4-6", provider: "anthropic", model: "claude-sonnet-4-6", source: "user" }, routeHint: HINT }), { decision: record() });
  assert.equal(res.reason, "user_selection");
});

test("precedence 2: an owner task pin beats the hint", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-hint-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "pins.json");
  fs.writeFileSync(statePath, JSON.stringify({ schema: "togglelogic-owner-pins/v2",
    pins: { [`task:${LABEL}`]: { active: true, model_ref: "anthropic/claude-opus-4-8", set_by: "togglelogic-pin", set_at_ms: 1, expires_at_ms: Date.now() + 86_400_000 } } }));
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough", ownerOverride: { enabled: true, statePath } }), services: services(), version: "2.4.0-test" });
  return core.decide(request({ routeHint: HINT }), { decision: record() }).then((res) => {
    assert.equal(res.reason, "task_pin");
    assert.equal(res.decision.ref, "anthropic/claude-opus-4-8");
  });
});

test("precedence 3: a configured route for the label beats the hint", async () => {
  const policy = normalizeConfig({ mode: "configured", configuredRoutes: { [LABEL]: "anthropic/claude-haiku-4-5" } });
  const core = createDecisionCore({ policy, services: services() });
  const res = await core.decide(request({ routeHint: HINT }), { decision: record() });
  assert.equal(res.reason, "configured");
  assert.equal(res.decision.ref, "anthropic/claude-haiku-4-5");
});

test("precedence 4: a hint to an unavailable provider FAILS OVER (never a silent box default)", async () => {
  const core = createDecisionCore({ policy: normalizeConfig({ mode: "passthrough" }),
    services: services({ availability: { unavailable: (p) => p === "ollama" } }) });
  const res = await core.decide(request({ routeHint: HINT }), { decision: record() });
  assert.equal(res.reason, "provider_unavailable");
  assert.equal(res.decision.ref, "google/gemini-3.5-flash");
});

test("plumbing: fromWireRequest maps work.routeHint to request.routeHint (present-but-empty preserved)", () => {
  const base = { apiVersion: DECISION_API_VERSION, candidates: [{ ref: "anthropic/claude-haiku-4-5" }] };
  assert.deepEqual(fromWireRequest({ ...base, work: { label: LABEL, routeHint: { providerOverride: "ollama", modelOverride: "glm4:9b" } } }).request.routeHint,
    { providerOverride: "ollama", modelOverride: "glm4:9b" });
  assert.deepEqual(fromWireRequest({ ...base, work: { routeHint: { providerOverride: " ", modelOverride: "" } } }).request.routeHint,
    { providerOverride: null, modelOverride: null }, "present-but-empty is kept so the core can loud-fail");
  assert.equal(fromWireRequest(base).request.routeHint, null, "absent work.routeHint maps to null");
});

test("plumbing: the OpenClaw adapter reads event.metadata.routeHint and binds the labeled turn", async () => {
  const config = normalizeConfig({ mode: "passthrough", features: { routing: { enabled: true } } });
  const resolve = createInterceptor({ config, hostConfig: {}, logger: { write: async () => {} },
    seam: { status: () => "absent", classify: async () => null }, version: "2.4.0-test", audit: { emit: () => {} } });
  const override = await resolve({ prompt: "classify this", metadata: { taskType: LABEL, routeHint: HINT } }, {});
  assert.deepEqual(override, { modelOverride: "glm4:9b", providerOverride: "ollama" });
});

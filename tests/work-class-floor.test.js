/*
 * ToggleLogic (Free Tier) — D60 work-class capability floor + latency budget.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeWorkClasses, warnWorkClassCollisions } from "../src/config/normalize.js";
import { dispatchByMode } from "../src/routing/modes.js";
import { evaluateWorkClassFloor } from "../src/routing/capability-floor.js";
import { createDecisionCore, DECISION_API_VERSION } from "../src/core/decide.js";

const LABEL = "intent_classification";
// A deterministic family resolver: lineage -> a concrete configured member ref.
const FAMILY = {
  "ollama/fast": "ollama/fast:1b",
  "ollama/slow": "ollama/glm4:9b",
  "openai/mini": "openai/gpt-5.5-mini",
};
const familyResolver = (lineage) => (FAMILY[lineage] ? { child: FAMILY[lineage], reason: "configured" } : null);

function cfg(over = {}) {
  return normalizeConfig({
    mode: "passthrough",
    workClasses: { [LABEL]: { requires: ["structured_output"], route: ["family:ollama/fast", "family:openai/mini"], latencyBudgetMs: 1500 } },
    capabilities: { structured_output: ["family:ollama/fast", "family:ollama/slow", "family:openai/mini"] },
    familyLatencyMs: { "family:ollama/fast": 800, "family:ollama/slow": 1600, "family:openai/mini": 1200 },
    ...over,
  });
}
const dispatch = (config, extra = {}) => dispatchByMode({
  mode: config.mode, event: { metadata: { taskType: LABEL } }, hookContext: {}, config,
  seam: { status: () => "absent" }, familyResolver, availability: null, ...extra });

test("work class: a fast, capable, reachable local family is eligible and chosen (local-first)", async () => {
  const result = await dispatch(cfg());
  assert.equal(result.selectionReason, "work_class");
  assert.equal(result.selectedModel, "ollama/fast:1b");
  assert.equal(result.selectionDetails.floorBasis, "config_capabilities");
  assert.equal(result.selectionDetails.p95Ms, 800);
});

test("work class: a local family over the latency budget is EXCLUDED, falling to the hosted family", async () => {
  const config = cfg({ workClasses: { [LABEL]: { requires: ["structured_output"], route: ["family:ollama/slow", "family:openai/mini"], latencyBudgetMs: 1500 } } });
  const result = await dispatch(config);
  assert.equal(result.selectionReason, "work_class");
  assert.equal(result.selectedModel, "openai/gpt-5.5-mini");
  assert.equal(result.selectionDetails.p95Ms, 1200);
});

test("work class: no eligible family (all over budget) is a LOUD work_class_floor_unmet, never a silent route", async () => {
  const config = cfg({ workClasses: { [LABEL]: { requires: ["structured_output"], route: ["family:ollama/slow"], latencyBudgetMs: 1500 } } });
  const result = await dispatch(config);
  assert.equal(result.selectionReason, "work_class_floor_unmet");
  assert.deepEqual(result.override, {});
  assert.equal(result.selectionDetails.excluded[0].reason, "latency_budget_exceeded");
});

test("work class: an unreachable local family is skipped to the hosted fallback", async () => {
  const result = await dispatch(cfg(), { availability: { unavailable: (p) => p === "ollama" } });
  assert.equal(result.selectionReason, "work_class");
  assert.equal(result.selectedModel, "openai/gpt-5.5-mini");
});

test("work class: an Intelligence-absent box with NO capability data LOUD-FAILS (no silent floor bypass)", async () => {
  const config = cfg({ capabilities: {} });
  const result = await dispatch(config);
  assert.equal(result.selectionReason, "work_class_floor_unmet");
  assert.ok(result.selectionDetails.excluded.every((e) => e.reason === "no_capability_data"));
});

test("work class: the licensed seam is authoritative for capabilities and observed p95", async () => {
  const config = cfg({ capabilities: {}, familyLatencyMs: {} }); // no config data: only the seam can answer
  const ok = await dispatch(config, { seam: { status: () => "available", queryCapability: () => ({ capabilities: ["structured_output"], p95Ms: 900 }) } });
  assert.equal(ok.selectionReason, "work_class");
  assert.equal(ok.selectionDetails.floorBasis, "intelligence_seam");
  assert.equal(ok.selectionDetails.p95Ms, 900);

  const excluded = await dispatch(config, { seam: { status: () => "available", queryCapability: () => ({ capabilities: ["structured_output"], p95Ms: 1600 }) } });
  assert.equal(excluded.selectionReason, "work_class_floor_unmet");
  assert.equal(excluded.selectionDetails.excluded[0].reason, "latency_budget_exceeded");

  const floor = await dispatch(config, { seam: { status: () => "available", queryCapability: () => ({ capabilities: [], p95Ms: 100 }) } });
  assert.equal(floor.selectionReason, "work_class_floor_unmet");
  assert.equal(floor.selectionDetails.excluded[0].reason, "capability_floor_unmet");
});

test("work class with no latency budget admits a capable family regardless of unknown p95", () => {
  const floor = evaluateWorkClassFloor({
    workClass: { requires: ["structured_output"], route: ["family:ollama/fast"], latencyBudgetMs: null },
    config: { capabilities: { structured_output: ["family:ollama/fast"] }, familyLatencyMs: {} },
    familyResolver,
  });
  assert.equal(floor.ok, true);
  assert.equal(floor.ref, "ollama/fast:1b");
  assert.equal(floor.p95Ms, null);
});

test("decide(): a met work class routes; an unmet floor stays LOUD and is NOT rescued by a route hint", async () => {
  const services = { seam: { status: () => "absent", classify: async () => null }, familyResolver: (l) => familyResolver(l) };
  const base = { apiVersion: DECISION_API_VERSION, requestId: "r1", agent: "main", defaultRef: "anthropic/claude-haiku-4-5",
    requested: { ref: null, provider: null, model: null, source: "none" }, candidates: ["anthropic/claude-haiku-4-5"], fallbacks: [],
    host: { event: { metadata: { taskType: LABEL } }, context: { taskType: LABEL } } };
  const dec = () => ({ requestId: "r1", selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null });

  const metCore = createDecisionCore({ policy: cfg(), services, version: "2.4.0-test" });
  const met = await metCore.decide(base, { decision: dec() });
  assert.equal(met.reason, "work_class");
  assert.equal(met.decision.ref, "ollama/fast:1b");

  // Floor unmet AND a hint present: the hint must NOT re-route capability-gated work.
  const unmetConfig = cfg({ workClasses: { [LABEL]: { requires: ["structured_output"], route: ["family:ollama/slow"], latencyBudgetMs: 1500 } } });
  const unmetCore = createDecisionCore({ policy: unmetConfig, services, version: "2.4.0-test" });
  const unmet = await unmetCore.decide({ ...base, routeHint: { providerOverride: "ollama", modelOverride: "glm4:9b" } }, { decision: dec() });
  assert.equal(unmet.reason, "work_class_floor_unmet");
  assert.deepEqual(unmet.decision, { action: "passthrough" });
});

test("workClasses config normalizes lineages, drops invalid routes, and warns on key collisions", () => {
  const filtered = normalizeWorkClasses({ other: { requires: ["Cap", " ", "cap"], route: ["family:ollama/good", "family:bad lineage", "provider/model", "nota-ref"], latencyBudgetMs: -5 } }).workClasses.other;
  assert.deepEqual(filtered.route, ["family:ollama/good", "provider/model"], "invalid family and non-ref route entries are dropped");
  assert.deepEqual(filtered.requires, ["cap"], "capability tokens are lowercased, trimmed and de-duplicated");
  assert.equal(filtered.latencyBudgetMs, null, "a non-positive budget normalizes to null");

  const { workClasses, collisions } = normalizeWorkClasses({
    " Intent-Classification ": { requires: ["structured_output"], route: ["family:ollama/fast"], latencyBudgetMs: 1500 },
    "intent-classification": { requires: [], route: ["family:openai/mini"], latencyBudgetMs: 900 },
  });
  assert.deepEqual(Object.keys(workClasses), ["intent-classification"]);
  assert.deepEqual(collisions, [{ normalized: "intent-classification", keys: [" Intent-Classification ", "intent-classification"] }]);
  assert.deepEqual(workClasses["intent-classification"].route, ["family:openai/mini"], "last colliding definition wins");

  let warned = false; let auditEvent = null;
  warnWorkClassCollisions(collisions, { audit: { emit: (e) => { auditEvent = e; } }, logger: { warn: () => { warned = true; } } });
  assert.equal(warned, true);
  assert.equal(auditEvent.details.check, "work_classes_collision");
  assert.equal(warnWorkClassCollisions([], {}), false);
});

test("additive config defaults: no workClasses/capabilities configured ⇒ empty, no behavior change", () => {
  const c = normalizeConfig({});
  assert.deepEqual(c.workClasses, {});
  assert.deepEqual(c.capabilities, {});
  assert.deepEqual(c.familyLatencyMs, {});
});

/*
 * ToggleLogic (Free Tier) — M1 step 5: Decision API v1 decision matrix (core and OpenClaw adapter legs).
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
import { createInterceptor, applyDecision } from "../src/adapters/openclaw/interceptor.js";
import { createDecisionCore, policyDigestOf, canonicalJson, DECISION_API_VERSION } from "../src/core/decide.js";
import { fromWireRequest } from "../src/core/request.js";
import { validate } from "./support/json-schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(fs.readFileSync(path.join(here, `../docs/design/schemas/decision-${name}.v1.schema.json`), "utf8"));
const REQUEST_SCHEMA = schema("request");
const RESPONSE_SCHEMA = schema("response");

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";
const FLASH = "google/gemini-3.5-flash";
const CONTENT_CANARY = "CANARY-content-never-leaves-the-request-7f3a";

const MODES = {
  passthrough: { mode: "passthrough" },
  configured_label: { mode: "configured", configuredRoutes: { summarize: FLASH } },
  configured_default: { mode: "configured", configuredRoutes: { default: SONNET } },
  cheap: { mode: "cheap", cheapHeuristic: { default: FLASH } },
  cheap_none: { mode: "cheap" },
  intelligence_absent: { mode: "intelligence" },
  auto_absent: { mode: "auto", cheapHeuristic: { default: SONNET } },
};
const SOURCES = { default: HAIKU, request: SONNET, user: SONNET, none: null };
const AVAILABILITY = { all_up: [], anthropic_down: ["anthropic"], google_down: ["google"], both_down: ["anthropic", "google"] };

function wireRow(mode, source, avail) {
  const requested = SOURCES[source];
  return {
    apiVersion: DECISION_API_VERSION,
    requestId: `m-${mode}-${source}-${avail}`,
    work: { label: mode === "configured_label" ? "summarize" : null, labelSource: mode === "configured_label" ? "host" : "none" },
    requested: requested ? { ref: requested, source } : { source: "none" },
    defaultRef: HAIKU,
    candidates: [{ ref: HAIKU }, { ref: SONNET }, { ref: FLASH }],
    fallbacks: [SONNET, FLASH],
    hostSignals: { unavailableProviders: AVAILABILITY[avail] },
    content: { messages: [{ role: "user", text: CONTENT_CANARY }] },
  };
}

const ROWS = [];
for (const mode of Object.keys(MODES)) for (const source of Object.keys(SOURCES)) for (const avail of Object.keys(AVAILABILITY)) ROWS.push({ mode, source, avail });

function newRecord(requestId) {
  return { requestId, selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null };
}

async function coreLeg(row, { pricing = null, usageEstimate = null } = {}) {
  const wire = wireRow(row.mode, row.source, row.avail);
  if (usageEstimate) wire.usageEstimate = usageEstimate;
  const { request, unavailableProviders } = fromWireRequest(wire);
  const sink = [];
  const policy = normalizeConfig(MODES[row.mode]);
  const core = createDecisionCore({ policy, version: "matrix", services: {
    seam: { status: () => "absent", classify: async () => null },
    availability: { unavailable: (p) => unavailableProviders.has(p) },
    audit: { emit: (e) => sink.push(e) },
    usageEvents: { emit: async (name, payload) => { sink.push([name, payload]); } },
    fallbackLogger: { warn: (m) => sink.push(m) },
    ...(pricing ? { pricing } : {}),
  } });
  const decision = newRecord(wire.requestId);
  const response = await core.decide(request, { decision, record: () => sink.push({ ...decision }) });
  return { wire, response, decision, sink, policy };
}

async function adapterLeg(row) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-matrix-"));
  try {
    const requested = SOURCES[row.source];
    const split = requested ? { modelProviderId: requested.split("/")[0], modelId: requested.split("/").slice(1).join("/") } : {};
    const context = { sessionKey: "agent:main:m", agentId: "main", ...split, ...(row.mode === "configured_label" ? { taskType: "summarize" } : {}) };
    const down = new Set(AVAILABILITY[row.avail]);
    const logged = [];
    const route = createInterceptor({
      config: normalizeConfig(MODES[row.mode]), version: "matrix",
      hostConfig: { agents: { defaults: { model: { primary: HAIKU, fallbacks: [SONNET, FLASH] }, models: { [HAIKU]: {}, [SONNET]: {}, [FLASH]: {} } } }, session: { store: path.join(tmp, "sessions.json") } },
      hostSession: row.source === "user" ? { getSessionEntry: () => ({ modelOverride: "claude-sonnet-4-6", providerOverride: "anthropic", modelOverrideSource: "user" }) } : null,
      logger: { write: async (d) => { logged.push(d); } },
      seam: { status: () => "absent", classify: async () => null },
      availability: { unavailable: (p) => down.has(p) },
      audit: { emit: () => {} }, usageEvents: { emit: async () => {} }, fallbackLogger: { warn: () => {} },
    });
    const out = await route({ prompt: CONTENT_CANARY }, context);
    await new Promise((resolve) => setImmediate(resolve));
    return { out, logged };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test("matrix: every wire request and every response conform to the v1 schemas", async () => {
  assert.ok(ROWS.length >= 100, `matrix has ${ROWS.length} rows`);
  for (const row of ROWS) {
    const { wire, response } = await coreLeg(row);
    assert.deepEqual(validate(REQUEST_SCHEMA, wire), [], `request ${wire.requestId}`);
    assert.deepEqual(validate(RESPONSE_SCHEMA, response), [], `response ${wire.requestId}: ${JSON.stringify(response)}`);
  }
});

test("matrix: the OpenClaw adapter leg returns exactly applyDecision(core response) with the same reason", async () => {
  for (const row of ROWS) {
    const { response } = await coreLeg(row);
    const { out, logged } = await adapterLeg(row);
    const id = `${row.mode}/${row.source}/${row.avail}`;
    assert.deepEqual({ ...out }, { ...applyDecision(response) }, `override ${id}`);
    assert.equal(logged.length, 1, `one routing record ${id}`);
    assert.equal(logged[0].selectionReason, response.reason, `reason ${id}`);
  }
});

test("matrix: request content is never read into a response, routing record, audit event or warning", async () => {
  for (const row of ROWS) {
    const { response, sink } = await coreLeg(row);
    const seen = JSON.stringify([response, sink]);
    assert.ok(!seen.includes(CONTENT_CANARY), `content leaked in ${row.mode}/${row.source}/${row.avail}`);
  }
});

test("matrix: precedence holds — user and request selections are never rerouted", async () => {
  for (const row of ROWS.filter((r) => r.source === "user" || r.source === "request")) {
    const { response } = await coreLeg(row);
    assert.deepEqual(response.decision, { action: "passthrough" });
    assert.equal(response.reason, row.source === "user" ? "user_selection" : "request_selection");
  }
});

test("D28: a decision that leaves the model unchanged audits as noop, a route as success", async () => {
  for (const row of ROWS.filter((r) => r.avail === "all_up" && (r.source === "default" || r.source === "none"))) {
    const { response, sink } = await coreLeg(row);
    const routing = sink.filter((e) => e?.event === "routing.decision");
    assert.equal(routing.length, 1, `${row.mode}/${row.source}`);
    assert.equal(routing[0].outcome, response.decision.action === "passthrough" ? "noop" : "success", `${row.mode}/${row.source}`);
  }
});

// A deterministic pricing service with the real interface (resolve + costUsd).
const fakePricing = {
  async resolve(ref) {
    if (ref.startsWith("ollama/")) return { ref, curated: false, priced: false };
    if (ref === SONNET) return { ref, curated: true, priced: false };
    return { ref, curated: true, priced: true, inputPerM: 2, outputPerM: 10 };
  },
  costUsd(info, usage) { return info.priced ? (usage.input * info.inputPerM + usage.output * info.outputPerM) / 1e6 : null; },
};

test("costEstimate: dollars when priced, loud unpriced reason otherwise, never a $0 stand-in", async () => {
  const usage = { inputTokens: 1000, outputTokens: 500 };
  const priced = await coreLeg({ mode: "cheap", source: "default", avail: "all_up" }, { pricing: fakePricing, usageEstimate: usage });
  assert.equal(priced.response.decision.ref, FLASH);
  assert.deepEqual(priced.response.costEstimate, { priced: true, usd: (1000 * 2 + 500 * 10) / 1e6, basis: "usage_estimate" });

  const passthroughPriced = await coreLeg({ mode: "passthrough", source: "default", avail: "all_up" }, { pricing: fakePricing, usageEstimate: usage });
  assert.equal(passthroughPriced.response.costEstimate.priced, true, "passthrough is priced on the host's requested model");

  const rows = [
    [{ mode: "configured_default", source: "default", avail: "all_up" }, { pricing: fakePricing, usageEstimate: usage }, "no_published_price"],
    [{ mode: "cheap", source: "default", avail: "all_up" }, { usageEstimate: usage }, "no_pricing_service"],
    [{ mode: "cheap", source: "default", avail: "all_up" }, { pricing: fakePricing }, "no_usage_estimate"],
    [{ mode: "passthrough", source: "none", avail: "all_up" }, { pricing: { ...fakePricing }, usageEstimate: usage }, null],
  ];
  for (const [row, opts, reason] of rows) {
    const { response } = await coreLeg(row, opts);
    assert.deepEqual(validate(RESPONSE_SCHEMA, response), []);
    if (reason) assert.deepEqual(response.costEstimate, { priced: false, usd: null, basis: "none", unpricedReason: reason });
    else assert.equal(response.costEstimate.priced, true, "passthrough with no requested model prices the host default");
  }

  const negative = await coreLeg({ mode: "cheap", source: "default", avail: "all_up" }, { pricing: fakePricing, usageEstimate: { inputTokens: -5, outputTokens: 10 } });
  assert.deepEqual(negative.response.costEstimate, { priced: false, usd: null, basis: "none", unpricedReason: "invalid_usage_estimate" });
  const costThrows = await coreLeg({ mode: "cheap", source: "default", avail: "all_up" }, { pricing: { ...fakePricing, costUsd: () => { throw new Error("bad math"); } }, usageEstimate: usage });
  assert.deepEqual(costThrows.response.costEstimate, { priced: false, usd: null, basis: "none", unpricedReason: "pricing_error" });

  const throwing = { resolve: async () => { throw new Error("feed down"); }, costUsd: () => 0 };
  const err = await coreLeg({ mode: "cheap", source: "default", avail: "all_up" }, { pricing: throwing, usageEstimate: usage });
  assert.deepEqual(err.response.costEstimate, { priced: false, usd: null, basis: "none", unpricedReason: "pricing_error" });

  const uncurated = createDecisionCore({ policy: normalizeConfig({ mode: "cheap", cheapHeuristic: { default: "ollama/glm4:9b" } }), services: { seam: { status: () => "absent", classify: async () => null }, pricing: fakePricing } });
  const local = await uncurated.decide(fromWireRequest({ ...wireRow("cheap", "default", "all_up"), usageEstimate: usage }).request, { decision: newRecord("u") });
  assert.deepEqual(local.costEstimate, { priced: false, usd: null, basis: "none", unpricedReason: "outside_price_catalog" });
});

test("policyDigest names the policy, not its key order, and changes when the policy does", () => {
  const a = normalizeConfig({ mode: "cheap", cheapHeuristic: { default: FLASH } });
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(policyDigestOf(a), policyDigestOf(reordered));
  assert.notEqual(policyDigestOf(a), policyDigestOf(normalizeConfig({ mode: "cheap", cheapHeuristic: { default: SONNET } })));
  assert.match(policyDigestOf(a), /^sha256:[a-f0-9]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] }), '{"a":[2,{"d":3}],"b":1}');
});

test("fromWireRequest rejects a wrong apiVersion and a missing candidates array", () => {
  assert.throws(() => fromWireRequest({ apiVersion: "togglelogic.decision/v0", candidates: [] }), /apiVersion/);
  assert.throws(() => fromWireRequest({ apiVersion: DECISION_API_VERSION }), /candidates/);
  const { request } = fromWireRequest({ apiVersion: DECISION_API_VERSION, candidates: [{ ref: FLASH }], content: { x: CONTENT_CANARY } });
  assert.ok(!JSON.stringify(request).includes(CONTENT_CANARY));
  assert.deepEqual(request.requested, { ref: null, provider: null, model: null, source: "none" });
});

test("matrix covers routing, failover and unresolved paths, and the schema checker rejects bad responses", async () => {
  const reasons = new Set(); let routes = 0;
  for (const row of ROWS) { const { response } = await coreLeg(row); reasons.add(response.reason); if (response.decision.action === "route") routes++; }
  for (const r of ["passthrough", "configured", "cheap_default", "user_selection", "request_selection", "provider_unavailable", "fallback_unresolved"]) assert.ok(reasons.has(r), `matrix reaches ${r}`);
  assert.ok(routes >= 20, `matrix has ${routes} route decisions`);
  const good = (await coreLeg({ mode: "cheap", source: "default", avail: "all_up" })).response;
  for (const bad of [{ ...good, recorded: true }, { ...good, policyDigest: "sha256:xyz" }, { ...good, decision: { action: "route" } },
    { ...good, decision: { action: "route", ref: FLASH, provider: null } }, { ...good, costEstimate: { priced: false, usd: 0 } }, { ...good, reason: "guess" }]) {
    assert.notDeepEqual(validate(RESPONSE_SCHEMA, bad), [], JSON.stringify(bad).slice(0, 120));
  }
});

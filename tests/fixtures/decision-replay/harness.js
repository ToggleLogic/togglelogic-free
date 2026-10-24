/*
 * ToggleLogic (Free Tier) — recorded-decision replay harness (M1 step 3 proof).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 *
 * Drives the before_model_resolve routing hook through one scenario per branch
 * of the decision order (design M1 §4.3) and records everything a host or an
 * auditor can observe: the hook's return value, the routing-log record, audit
 * events, usage events, fallback warnings, correlation calls and seam calls.
 *
 * recorded.json was produced by running this harness against the 2.1.6-based
 * interceptor before decide() was extracted (commit 015d0a5). The replay test
 * runs the same harness against the current code and requires an exact match.
 * Volatile values (request ids, timestamps, durations, temp paths) are
 * normalized; everything else must be identical.
 *
 * M6 (Free 2.3.0) rebaseline: R1 moved owner pins BELOW protected user
 * selection, so for the two active-owner-override scenarios decide() now reads
 * the session store (emitting session_pin_store_absent + a warn) before the pin
 * applies. The pin's routing_log, routing.decision audit and hook return value
 * are unchanged; only that pre-pin session read was added. See recordedFrom.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-6";
const FLASH = "google/gemini-3.5-flash";
const LOCAL = "ollama/glm4:9b";

const hostConfig = (extra = {}) => ({
  agents: { defaults: { model: { primary: HAIKU, fallbacks: [SONNET, FLASH] }, models: { [HAIKU]: {}, [SONNET]: {}, [FLASH]: {} } } },
  ...extra,
});
const ctx = (over = {}) => ({ sessionKey: "agent:main:s1", agentId: "main", ...over });
const onDefault = { modelProviderId: "anthropic", modelId: "claude-haiku-4-5" };
const down = (...providers) => ({ unavailable: (p) => providers.includes(p) });
const seamOf = (status, classify) => ({ status: () => status, classify });

// Each scenario: config (raw, passed to normalizeConfig), interceptor options,
// and an ordered list of calls. `setup(tmp)` may write state files.
export const SCENARIOS = [
  { name: "passthrough mode, host default", config: { mode: "passthrough" }, calls: [{ event: { prompt: "a" }, context: ctx(onDefault) }] },
  { name: "configured mode, task label match", config: { mode: "configured", configuredRoutes: { summarize: FLASH } },
    calls: [{ event: { prompt: "b" }, context: ctx({ ...onDefault, taskType: "summarize" }) }] },
  { name: "configured mode, label miss falls to default route", config: { mode: "configured", configuredRoutes: { default: SONNET } },
    calls: [{ event: { prompt: "c", metadata: { taskType: "other" } }, context: ctx(onDefault) }] },
  { name: "configured mode, no route", config: { mode: "configured", configuredRoutes: { summarize: FLASH } }, calls: [{ event: { prompt: "d" }, context: ctx(onDefault) }] },
  { name: "configured mode, family alias", config: { mode: "configured", configuredRoutes: { default: "family:flash" } }, calls: [{ event: { prompt: "e" }, context: ctx(onDefault) }] },
  { name: "cheap mode", config: { mode: "cheap", cheapHeuristic: { default: FLASH } }, calls: [{ event: { prompt: "f" }, context: ctx(onDefault) }] },
  { name: "cheap mode, model-only ref", config: { mode: "cheap", cheapHeuristic: { default: "claude-haiku-4-5" } }, calls: [{ event: { prompt: "f2" }, context: ctx(onDefault) }] },
  { name: "cheap mode, nothing configured", config: { mode: "cheap" }, calls: [{ event: { prompt: "g" }, context: ctx(onDefault) }] },
  { name: "auto mode, seam unavailable, cheap default", config: { mode: "auto", cheapHeuristic: { default: SONNET } }, calls: [{ event: { prompt: "h" }, context: ctx(onDefault) }] },
  { name: "intelligence routes", config: { mode: "intelligence" },
    options: { seam: seamOf("available", async () => ({ modelOverride: "gemini-3.5-flash", providerOverride: "google", details: { tier: "general_purpose" } })) },
    calls: [{ event: { prompt: "i", attachments: [{ mimeType: "image/png" }] }, context: ctx(onDefault) }] },
  { name: "intelligence provider-only recommendation", config: { mode: "intelligence" },
    options: { seam: seamOf("available", async () => ({ providerOverride: "google" })) }, calls: [{ event: { prompt: "i2" }, context: ctx(onDefault) }] },
  { name: "intelligence pin honored", config: { mode: "intelligence" },
    options: { seam: seamOf("available", async () => ({ modelOverride: "claude-sonnet-4-6", providerOverride: "anthropic", details: { pin_matched: "drafts", pin_resolution: "honored" } })) },
    calls: [{ event: { prompt: "j" }, context: ctx(onDefault) }] },
  { name: "intelligence shadow", config: { mode: "intelligence" },
    options: { seam: seamOf("available", async () => ({ shadow: true, details: { would: FLASH } })) }, calls: [{ event: { prompt: "k" }, context: ctx(onDefault) }] },
  { name: "intelligence declined", config: { mode: "intelligence" }, options: { seam: seamOf("detecting", async () => null) }, calls: [{ event: { prompt: "l" }, context: ctx(onDefault) }] },
  { name: "explicit intelligence unavailable", config: { mode: "intelligence" }, calls: [{ event: { prompt: "m" }, context: ctx(onDefault) }] },
  { name: "seam throws, fallbackOnError on", config: { mode: "intelligence" },
    options: { seam: seamOf("available", async () => { throw new Error("seam boom"); }) }, calls: [{ event: { prompt: "n" }, context: ctx(onDefault) }] },
  { name: "seam throws, fallbackOnError off", config: { mode: "intelligence", intelligence: { fallbackOnError: false } },
    options: { seam: seamOf("available", async () => { throw new Error("seam boom"); }) }, calls: [{ event: { prompt: "o" }, context: ctx(onDefault) }] },
  { name: "owner override", config: { mode: "cheap", cheapHeuristic: { default: SONNET } }, owner: { active: true, model_ref: FLASH },
    calls: [{ event: { prompt: "p" }, context: ctx({ modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" }) }] },
  { name: "owner override with provider override, provider down", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    owner: { active: true, model_ref: FLASH, provider_override: "google" }, options: { availability: down("google") }, calls: [{ event: { prompt: "q" }, context: ctx(onDefault) }] },
  { name: "owner override inactive", config: { mode: "cheap", cheapHeuristic: { default: SONNET } }, owner: { active: false, model_ref: FLASH }, calls: [{ event: { prompt: "r" }, context: ctx(onDefault) }] },
  { name: "user pin via host session", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    options: { hostSession: { getSessionEntry: () => ({ modelOverride: "claude-haiku-4-5", providerOverride: "anthropic", modelOverrideSource: "user" }) } },
    calls: [{ event: { prompt: "s" }, context: ctx(onDefault) }] },
  { name: "user pin, provider down", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    options: { availability: down("anthropic"), hostSession: () => ({ getSessionEntry: () => ({ modelOverride: "claude-haiku-4-5", modelOverrideSource: "user" }) }) },
    calls: [{ event: { prompt: "t" }, context: ctx(onDefault) }] },
  { name: "user pin via legacy session file", config: { mode: "cheap", cheapHeuristic: { default: SONNET } }, legacySession: { "agent:main:s1": { modelOverride: "claude-haiku-4-5" } },
    calls: [{ event: { prompt: "u" }, context: ctx(onDefault) }] },
  { name: "request selection", config: { mode: "cheap", cheapHeuristic: { default: HAIKU } },
    calls: [{ event: { prompt: "v" }, context: ctx({ modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" }) }] },
  { name: "request selection, provider down", config: { mode: "cheap", cheapHeuristic: { default: HAIKU } }, options: { availability: down("google") },
    calls: [{ event: { prompt: "w" }, context: ctx({ modelProviderId: "google", modelId: "gemini-3.5-flash" }) }] },
  { name: "host auto selection is routed", config: { mode: "cheap", cheapHeuristic: { default: HAIKU } },
    options: { hostSession: { getSessionEntry: () => ({ modelOverride: "claude-sonnet-4-6", providerOverride: "anthropic", modelOverrideSource: "auto" }) } },
    calls: [{ event: { prompt: "x" }, context: ctx({ modelProviderId: "anthropic", modelId: "claude-sonnet-4-6" }) }] },
  { name: "host session read error, signalled once", config: { mode: "cheap", cheapHeuristic: { default: SONNET } }, brokenLegacy: true,
    options: { hostSession: { getSessionEntry: () => { throw new Error("db locked"); } } },
    calls: [{ event: { prompt: "y1" }, context: ctx(onDefault) }, { event: { prompt: "y2" }, context: ctx(onDefault) }] },
  { name: "no session key", config: { mode: "cheap", cheapHeuristic: { default: SONNET } }, calls: [{ event: { prompt: "z" }, context: { agentId: "main", ...onDefault } }] },
  { name: "early failover via lineage resolver", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    options: { availability: down("anthropic"), lineageResolver: async (agentId) => ({ child: FLASH, lineage: "gemini-flash", reason: `resolved:${agentId}`, skipped: [HAIKU] }) },
    calls: [{ event: { prompt: "aa" }, context: ctx(onDefault) }] },
  { name: "early failover via host fallbacks (resolver throws)", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    options: { availability: down("anthropic"), lineageResolver: async () => { throw new Error("catalog down"); } },
    calls: [{ event: { prompt: "ab" }, context: ctx(onDefault) }] },
  { name: "early failover unresolved", config: { mode: "cheap", cheapHeuristic: { default: SONNET } },
    options: { availability: down("anthropic", "google"), lineageResolver: async () => ({ child: null, skipped: [FLASH] }) },
    calls: [{ event: { prompt: "ac" }, context: ctx(onDefault) }] },
  { name: "late failover of the selected model", config: { mode: "cheap", cheapHeuristic: { default: FLASH } },
    options: { availability: down("google"), lineageResolver: async () => null }, calls: [{ event: { prompt: "ad" }, context: ctx(onDefault) }] },
  { name: "late failover unresolved keeps the selection", config: { mode: "cheap", cheapHeuristic: { default: LOCAL } },
    options: { availability: down("ollama"), hostConfig: { agents: { defaults: { model: { primary: HAIKU } } } } }, calls: [{ event: { prompt: "ae" }, context: ctx(onDefault) }] },
  { name: "duplicate prompt in the window", config: { mode: "cheap", cheapHeuristic: { default: FLASH } },
    calls: [{ event: { prompt: "same" }, context: ctx(onDefault) }, { event: { prompt: "same" }, context: ctx(onDefault) }] },
  { name: "preflight then resolve uses the cached decision", config: { mode: "cheap", cheapHeuristic: { default: FLASH } },
    calls: [{ kind: "preflight", event: { prompt: "pf" }, context: ctx(onDefault) }, { event: { prompt: "pf" }, context: ctx(onDefault) }] },
  { name: "governed short-circuit before routing", config: { mode: "cheap", cheapHeuristic: { default: FLASH } }, governed: "short",
    calls: [{ event: { prompt: "gov1" }, context: ctx(onDefault) }] },
  { name: "governed override after routing", config: { mode: "cheap", cheapHeuristic: { default: FLASH } }, governed: "after",
    calls: [{ event: { prompt: "gov2" }, context: ctx(onDefault) }] },
  { name: "governed invitation on preflight", config: { mode: "cheap", cheapHeuristic: { default: FLASH } }, governed: "invite",
    calls: [{ kind: "preflight", event: { prompt: "gov3" }, context: ctx(onDefault) }] },
];

function governedStub(kind, trace) {
  return {
    beforeRouting(prompt, context) { trace.push(["governed.before", prompt, context?.sessionKey ?? null]); return kind === "short" ? { shortCircuit: true, override: { providerOverride: "ollama", modelOverride: "glm4:9b" } } : null; },
    async afterRouting(prompt, context, result) { trace.push(["governed.after", prompt, result?.selectionReason ?? null]); return kind === "after" ? { override: { providerOverride: "anthropic", modelOverride: "claude-opus-4-8" } } : null; },
    pendingInvitation(context) { trace.push(["governed.invite", context?.sessionKey ?? null]); return kind === "invite" ? "Owner approval required" : null; },
  };
}

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
// The hook's return value is compared with sorted keys: OpenClaw reads
// providerOverride and modelOverride by name, so key order is not part of the
// contract. Everything in the trace is compared exactly, in order.
const sortKeys = (value) => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])])) : value;

export async function runScenario(scenario, { createInterceptor, normalizeConfig }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tl-replay-"));
  try {
    const trace = [];
    const raw = { ...scenario.config };
    if (scenario.owner) {
      const statePath = path.join(tmp, "owner.json");
      fs.writeFileSync(statePath, JSON.stringify(scenario.owner));
      raw.ownerOverride = { enabled: true, statePath };
    }
    const baseHost = scenario.options?.hostConfig ?? hostConfig();
    const sessionsPath = path.join(tmp, "sessions.json");
    if (scenario.legacySession) fs.writeFileSync(sessionsPath, JSON.stringify(scenario.legacySession));
    if (scenario.brokenLegacy) fs.writeFileSync(sessionsPath, "{not json");
    const host = { ...baseHost, session: { store: sessionsPath } };
    const seam = scenario.options?.seam ?? seamOf("unavailable", async () => null);
    const options = {
      config: normalizeConfig(raw), hostConfig: host, version: "replay",
      logger: { write: async (d) => { trace.push(["routing_log", d]); } },
      audit: { emit: (e) => trace.push(["audit", e]) },
      seam: { status: () => seam.status(), classify: async (input) => { trace.push(["seam.classify", input?.prompt ?? null, input?.attachments ?? null, input?.hookContext?.sessionKey ?? null]); return seam.classify(input); } },
      requestCorrelation: { remember: (decision, event) => trace.push(["correlation", decision?.selectionReason ?? null, event?.prompt ?? null]) },
      usageEvents: { emit: async (name, payload) => { trace.push(["usage_event", name, payload]); } },
      fallbackLogger: { warn: (message) => trace.push(["warn", message]) },
      availability: scenario.options?.availability ?? null,
      lineageResolver: scenario.options?.lineageResolver ? async (agentId) => { trace.push(["lineage", agentId]); return scenario.options.lineageResolver(agentId); } : null,
      hostSession: scenario.options?.hostSession ?? null,
      governedEscalation: scenario.governed ? governedStub(scenario.governed, trace) : null,
    };
    const route = createInterceptor(options);
    const results = [];
    for (const call of scenario.calls) {
      let out;
      try {
        out = call.kind === "preflight" ? await route.preflight(call.event, call.context) : await route(call.event, call.context);
        results.push({ kind: call.kind ?? "resolve", ok: true, frozenEmpty: Object.isFrozen(out) && Object.keys(out).length === 0, value: sortKeys(plain(out)) });
      } catch (error) {
        results.push({ kind: call.kind ?? "resolve", ok: false, error: String(error?.message ?? error) });
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    return normalize({ name: scenario.name, results, trace: plain(trace) }, tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Request ids, timestamps and durations vary per run; correlation ids must
// equal the routing record's request id, which is checked before stripping.
function normalize(record, tmp) {
  const ids = new Map();
  const idOf = (value) => { if (!ids.has(value)) ids.set(value, `id${ids.size + 1}`); return ids.get(value); };
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out = {};
      for (const [key, v] of Object.entries(value)) {
        if (key === "timestamp" || key === "durationMs") out[key] = typeof v;
        else if (key === "requestId" || key === "correlationId") out[key] = typeof v === "string" ? idOf(v) : v;
        else out[key] = walk(v);
      }
      return out;
    }
    if (typeof value === "string") return value.split(tmp).join("<TMP>");
    return value;
  };
  return walk(record);
}

export async function runAll(deps) {
  const out = [];
  for (const scenario of SCENARIOS) out.push(await runScenario(scenario, deps));
  return out;
}

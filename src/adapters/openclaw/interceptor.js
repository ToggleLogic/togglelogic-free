/*
 * ToggleLogic (Free Tier) — before_model_resolve routing interceptor.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { hostFallbacks } from "../../usage/provider-refusal.js";
import { configuredModels, resolveLineage } from "../../routing/lineage-resolver.js";
import crypto from "node:crypto";
import { newDecision, finalizeDecision } from "../../routing/decision.js";
import { createDecisionCore } from "../../core/decide.js";
import { hasSessionAutoModelFallbackProvenance, isProtectedUserSessionSelection, readSessionSelection } from "./session-store.js";
import { EVENTS, OUTCOMES } from "../../audit/audit-events.js";

const PASSTHROUGH = Object.freeze({});
const clean = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const emit = (audit, event, value) => { try { audit?.emit?.({ event, ...value }); } catch {} };

function selection(provider, model) {
  const p = clean(provider); const m = clean(model);
  if (!m) return p ? { provider: p, model: null, ref: p } : null;
  if (!p && m.includes("/")) return { provider: m.slice(0, m.indexOf("/")), model: m.slice(m.indexOf("/") + 1), ref: m };
  return { provider: p, model: m, ref: p ? `${p}/${m}` : m };
}

// Free 2.4.0 (D59): a generic externally-supplied route hint carried as
// SPAWN-TIME session metadata the host surfaces on every turn's event
// (event.metadata.routeHint). Read by generic field name only — no
// integration-specific identifiers. A present-but-empty hint is kept (not
// nulled) so the decision core can LOUD-FAIL on a present-but-unusable hint
// rather than silently drop to box default; absent metadata yields null.
function readRouteHint(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { providerOverride: clean(raw.providerOverride), modelOverride: clean(raw.modelOverride) };
}


// 2.0.3: the model the host resolved for this request, compared against the
// host's configured default for the agent. A difference means the model was
// chosen for this request or session (a one-off --model, a /model selection now
// held in the host's SQLite session state, or a host fallback attempt). That
// choice is honored rather than silently replaced by a routing default.
function modelRef(value) {
  if (typeof value === "string") return clean(value);
  if (value && typeof value === "object") return clean(value.primary);
  return null;
}
export function hostDefaultModelRef(hostConfig, agentId) {
  const agents = hostConfig?.agents;
  const id = clean(agentId) || "main";
  const entry = Array.isArray(agents?.list) ? agents.list.find((a) => clean(a?.id) === id) : null;
  return modelRef(entry?.model) || modelRef(agents?.defaults?.model);
}
export function isRequestSelection(current, defaultRef) {
  if (!current?.model || !defaultRef) return false;
  const def = selection(null, defaultRef);
  if (!def?.model) return false;
  if (current.model.toLowerCase() !== def.model.toLowerCase()) return true;
  return Boolean(current.provider && def.provider && current.provider.toLowerCase() !== def.provider.toLowerCase());
}

// 2.1.4: the session's stored override was set by the host (auto model
// selection or a fallback), not by the user, and it is what the host resolved for
// this request. Such a model is not a user choice, so routing may still apply.
// A one-off explicit --model differs from the stored override and is unaffected.
function isHostAutoSelection(sessionLookup, current) {
  if (sessionLookup?.status !== "found" || !current?.model) return false;
  const entry = sessionLookup.entry;
  if (isProtectedUserSessionSelection(entry)) return false;
  const auto = clean(entry?.modelOverrideSource) === "auto" || hasSessionAutoModelFallbackProvenance(entry);
  if (!auto) return false;
  const stored = selection(entry?.providerOverride, entry?.modelOverride);
  if (!stored?.model || stored.model.toLowerCase() !== current.model.toLowerCase()) return false;
  return !stored.provider || !current.provider || stored.provider.toLowerCase() === current.provider.toLowerCase();
}

// 2.2.0 (M1 step 3): the decision order lives in src/core/decide.js. This
// adapter turns the OpenClaw hook event and context into a DecisionRequest,
// runs decide(), and turns the response back into the hook's return value.
// It keeps the OpenClaw-only concerns: preflight caching, duplicate-prompt
// suppression, session-store provenance and the routing record.

// Session-store provenance (C5) and hook context (C4) → `requested`.
function requestedSelection(current, sessionLookup, hostDefault) {
  if (current && sessionLookup?.status === "found" && isProtectedUserSessionSelection(sessionLookup.entry)) {
    return { ref: current.ref, provider: current.provider, model: current.model, source: "user", pinSource: sessionLookup.source };
  }
  if (isRequestSelection(current, hostDefault) && !isHostAutoSelection(sessionLookup, current)) {
    return { ref: current.ref, provider: current.provider, model: current.model, source: "request" };
  }
  if (!current) return { ref: null, provider: null, model: null, source: "none" };
  return { ref: current.ref, provider: current.provider, model: current.model, source: isHostAutoSelection(sessionLookup, current) ? "auto" : "default" };
}

export function applyDecision(response) {
  const d = response?.decision;
  if (!d || d.action !== "route") return PASSTHROUGH;
  return { ...(d.model ? { modelOverride: d.model } : {}), ...(d.provider ? { providerOverride: d.provider } : {}) };
}

export function createInterceptor({ config, hostConfig, logger, seam, version, audit, governedEscalation = null, requestCorrelation = null, availability = null, lineageResolver = null, usageEvents = null, fallbackLogger = null, hostSession = null, paths = null, onLabelSeen = null }) {
  const recent = new Map();
  const preflight = new Map();
  const windowMs = 60_000;
  // 2.1.3: emit SESSION_PIN_STORE_ABSENT at most once per gateway run so the
  // inert legacy sessions.json pin path is observable instead of silent.
  let sessionPinStoreSignaled = false;
  const fingerprint = (event, context) => clean(event?.prompt) && clean(context?.sessionKey)
    ? crypto.createHash("sha256").update(`${context.sessionKey}\0${event.prompt}`).digest("hex") : null;
  // M6 §5.1/§5.2: resolve a family pin or a `family:` configured route to the
  // newest configured+allowed member, SYNCHRONOUSLY, via the existing lineage
  // resolver over the host allowlist. No live pricing catalog is fetched on the
  // hot path (preserving §3.1's one-stat-per-decision cost model), so ordering
  // is configured-order; release-date ordering still applies on the async
  // failover path. An unresolvable family fails loudly (never a silent model).
  const familyResolver = (family, agentId) => resolveLineage({
    lineage: family,
    allowedModels: configuredModels(hostConfig, agentId),
    catalog: [],
    unavailable: (provider) => availability?.unavailable(provider) ?? false,
  });
  const core = createDecisionCore({ policy: config, version,
    services: { audit, seam, availability, lineageResolver, familyResolver, usageEvents, fallbackLogger, governedEscalation, paths } });

  function readSession(context) {
    const sessionLookup = readSessionSelection(hostConfig, context, { hostSession: typeof hostSession === "function" ? hostSession() : hostSession });
    // 2.1.3/2.1.4: if neither the host session accessor nor the legacy
    // sessions.json can be read, user pins cannot be recognised by provenance.
    // Surface that once per gateway run instead of silently.
    if (!sessionPinStoreSignaled && sessionLookup?.status === "read_error") {
      sessionPinStoreSignaled = true;
      emit(audit, EVENTS.SESSION_PIN_STORE_ABSENT, { outcome: OUTCOMES.NOOP, principal: { source: "plugin" },
        details: { storePath: sessionLookup.storePath, reason: sessionLookup.error, ...(sessionLookup.hostError ? { hostError: sessionLookup.hostError } : {}),
          note: "session pin store unreadable (no host session accessor and no legacy sessions.json); only model selections that differ from the agent default are honored, via request_selection" } });
      try { fallbackLogger?.warn?.(`togglelogic: session pin store not readable (${sessionLookup.storePath}); a user pin equal to the agent default cannot be recognised. Selections that differ from the default are still honored.`); } catch {}
    }
    return sessionLookup;
  }

  // Host reads stay lazy: the core reads `requested`, `candidates` and
  // `fallbacks` at the point in the decision order where 2.1.x read them.
  function toDecisionRequest(event, context, decision) {
    const memo = {};
    const once = (key, fn) => (key in memo ? memo[key] : (memo[key] = fn()));
    const defaultRef = () => hostDefaultModelRef(hostConfig, context?.agentId);
    return {
      apiVersion: "togglelogic.decision/v1",
      requestId: decision.requestId,
      agent: context?.agentId,
      get defaultRef() { return defaultRef(); },
      get requested() { return once("requested", () => requestedSelection(selection(context?.modelProviderId, context?.modelId), readSession(context), defaultRef())); },
      get candidates() { return once("candidates", () => configuredModels(hostConfig, context?.agentId)); },
      get fallbacks() { return once("fallbacks", () => hostFallbacks(hostConfig, context?.agentId)); },
      get routeHint() { return once("routeHint", () => readRouteHint(event?.metadata?.routeHint)); },
      host: { event, context },
    };
  }

  const beforeModelResolve = async function beforeModelResolve(event = {}, context = {}, preflightResult = null) {
    const preflightKey = fingerprint(event, context);
    const cached = preflightKey ? preflight.get(preflightKey) : null;
    if (cached && Date.now() - cached.at <= windowMs && !availability?.unavailable(cached.decision?.selectedProvider) && !availability?.unavailable(context?.modelProviderId || hostDefaultModelRef(hostConfig, context?.agentId)?.split("/")[0])) {
      preflight.delete(preflightKey);
      requestCorrelation?.remember(cached.decision, event, context);
      if (preflightResult) preflightResult.decision = cached.decision;
      return cached.override;
    }
    if (preflightKey) preflight.delete(preflightKey);
    const decision = newDecision({ event, hookContext: context, mode: config.mode, version });
    const record = () => {
      finalizeDecision(decision);
      requestCorrelation?.remember(decision, event, context);
      if (preflightResult) preflightResult.decision = decision;
      logger.write(decision).catch(() => {});
    };
    emit(audit, EVENTS.ROUTING_HOOK_FIRE, { outcome: OUTCOMES.SUCCESS, principal: { source: "agent" }, subject: { hook: "before_model_resolve" }, details: { mode: config.mode }, correlationId: decision.requestId });

    // Duplicate-prompt suppression (C7): a repeat of the same prompt in the
    // same session within the window passes through without a second record.
    const beforeDispatch = () => {
      const key = fingerprint(event, context);
      const now = Date.now();
      for (const [item, at] of recent) if (now - at > windowMs) recent.delete(item);
      if (key && recent.has(key)) return false;
      if (key) recent.set(key, now);
      return true;
    };

    const response = await core.decide(toDecisionRequest(event, context, decision), { decision, record, beforeDispatch });
    // M6 §7: report to the taskPins capability gate that a labelled turn actually
    // reached the engine (flips its reason no-task-labels-seen -> active).
    if (response?.pins?.labelSeen) { try { onLabelSeen?.(); } catch {} }
    return applyDecision(response);
  };

  async function safeResolve(event = {}, context = {}, preflightResult = null) {
    try { return await beforeModelResolve(event, context, preflightResult); }
    catch {
      // The host routing hook is fail-soft even when a seam or dependency fails.
      const decision = newDecision({ event, hookContext: context, mode: config.mode, version });
      decision.selectedModel = selection(context?.modelProviderId, context?.modelId)?.ref || hostDefaultModelRef(hostConfig, context?.agentId);
      decision.selectedProvider = decision.selectedModel?.split("/")[0] ?? null;
      decision.selectionReason = "fallback_unresolved";
      core.unresolved(decision, "routing_hook_error");
      try { finalizeDecision(decision); void Promise.resolve(logger.write(decision)).catch(() => {}); } catch {}
      return PASSTHROUGH;
    }
  }
  safeResolve.preflight = async (event = {}, context = {}) => {
    const key = fingerprint(event, context);
    const result = {};
    const override = await safeResolve(event, context, result);
    const invitation = governedEscalation?.pendingInvitation(context);
    if (invitation) {
      if (key) recent.delete(key);
      return { handled: true, reply: { text: invitation }, reason: "togglelogic_owner_approval_required" };
    }
    if (key) preflight.set(key, { override, decision: result.decision, at: Date.now() });
    return { handled: false };
  };

  return safeResolve;
}

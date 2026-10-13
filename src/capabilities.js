/*
 * ToggleLogic (Free Tier) — capability registration and host hook wiring.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { hostname } from "node:os";
import { createLineageResolver, auditFallbackPlan } from "./routing/lineage-resolver.js";
import { createProviderAvailability } from "./usage/provider-refusal.js";
import { createUsageEvents } from "./usage/events.js";
import { createRequestCorrelation } from "./routing/request-correlation.js";
import { createInterceptor } from "./routing/interceptor.js";
import { createIntelligenceSeam } from "./intelligence/seam.js";
import { createLogger as createRoutingLogger } from "./observability/logger.js";
import { createOwnerOverrideAskHandler } from "./capture/owner-override-ask.js";
import { createCostObserver } from "./usage/cost-observer.js";
import { createApprovalGate } from "./governance/approval-gate.js";
import { createPricing } from "./usage/pricing.js";
import { createNewSessionTracker } from "./routing/new-session-tracker.js";
import { EVENTS, OUTCOMES } from "./audit/audit-events.js";
import { isConversationAccessGranted, conversationAccessDeniedMessage, conversationAccessDeniedAuditDetails } from "./hooks/conversation-access.js";

export function buildRuntimeConfigFromApiConfig(cfg) {
  const out = { byProvider: {}, byModel: {}, acceptedModelRefs: [] };
  for (const [provider, value] of Object.entries(cfg?.models?.providers || {})) {
    if (value?.agentRuntime?.id) out.byProvider[provider] = value.agentRuntime.id;
  }
  for (const [ref, value] of Object.entries(cfg?.agents?.defaults?.models || {})) {
    out.acceptedModelRefs.push(ref);
    if (value?.agentRuntime?.id) out.byModel[ref] = value.agentRuntime.id;
  }
  return out;
}

export function registerCapabilities({ api, audit, fallbackLogger, version, config }) {
  const requestCorrelation = createRequestCorrelation();
  const usageEvents = createUsageEvents({ config: config.costVisibility.events, audit, fallbackLogger,
    deploymentId: config.costVisibility.attribution.deploymentId || hostname().toLowerCase(), costCenter: config.costVisibility.attribution.costCenter });
  const availability = config.features.costVisibility.enabled ? createProviderAvailability({ cooldownMinutes: config.costVisibility.providerCooldownMinutes,
    emit: (event, data) => { void usageEvents.emit(event, data); } }) : null;
  const sharedPricing = createPricing(config.costVisibility.pricing, fallbackLogger);
  const lineageResolver = createLineageResolver({ lineages: config.routing?.fallbackLineages, hostConfig: api?.config, pricing: sharedPricing, availability });
  const registered = [];
  const gates = [];
  const mark = (id, enabled, reason) => gates.push({ id, enabled, reason });

  // 2.1.5: audit-write failures are loud. Forward each rate-limited failure
  // report to the usage-events stream (an independent sink), record the audit
  // capability gate, and repeat an error-level log at every session start while
  // the audit sink is still failing (session_start is a non-gated lifecycle hook).
  if (typeof audit?.health === "function") {
    audit.onFailureReport?.((info) => usageEvents.emit("audit_write_failed", info));
    const health = audit.health();
    gates.push({ id: "audit", enabled: health.enabled, reason: health.reason, ready: health.ready });
    if (health.enabled) {
      api.on("session_start", () => {
        const now = audit.health();
        if (now.ready) return;
        try {
          fallbackLogger?.error?.(`togglelogic-audit: audit capability NOT READY (${now.failures.lastErrorCode}); ` +
            `${now.failures.current} record(s) not written since ${now.failures.firstFailureAt}.`);
        } catch {}
      });
    }
  }

  let costObserver = null;
  if (config.features.routing.enabled || config.routing?.invalidFallbackLineages?.length) {
    auditFallbackPlan({ hostConfig: api?.config, lineages: config.routing?.fallbackLineages,
      invalidLineages: config.routing?.invalidFallbackLineages, audit, logger: fallbackLogger });
  }
  if (config.features.routing.enabled && !isConversationAccessGranted(api)) {
    // Routing is enabled, but the host did not grant this non-bundled plugin
    // permission to register conversation hooks. Those hooks (before_model_resolve
    // and the governed-escalation hooks) would be blocked by the host, so turns
    // silently fall through to the host default model. Rather than register hooks
    // that never fire, make the condition observable three ways: an error-level
    // startup message, a routing.skipped audit event (now and on each
    // session_start — a non-gated lifecycle hook that still fires), and a
    // not-ready routing capability gate (ready:false) recorded in the
    // plugin.register audit below.
    //
    // NOTE: OpenClaw 2026.9.9 does not run an external plugin's registered health
    // checks in `openclaw doctor` (doctor loads external plugins with
    // activate:false and never calls their register()). So the readiness signal
    // here is the capability gate + the error log + the routing.skipped audit —
    // NOT a doctor finding. The reusable check in ./health/conversation-access-check.js
    // ships as a tested primitive for hosts/bundlings that DO run plugin health.
    try { fallbackLogger?.error?.(conversationAccessDeniedMessage()); } catch {}
    audit.emit({ event: EVENTS.ROUTING_SKIPPED, outcome: OUTCOMES.SKIP, principal: { source: "plugin-host" }, details: conversationAccessDeniedAuditDetails(config.mode) });
    api.on("session_start", () => {
      audit.emit({ event: EVENTS.ROUTING_SKIPPED, outcome: OUTCOMES.SKIP, principal: { source: "plugin-host" }, details: conversationAccessDeniedAuditDetails(config.mode) });
    });
    gates.push({ id: "routing", enabled: false, reason: "conversation-access-denied", ready: false });
    gates.push({ id: "governedEscalation", enabled: false, reason: "conversation-access-denied", ready: false });
  } else if (config.features.routing.enabled) {
    const routingLogger = createRoutingLogger(config.logging, fallbackLogger);
    const newSessions = createNewSessionTracker();
    const seam = createIntelligenceSeam(config.intelligence, fallbackLogger, buildRuntimeConfigFromApiConfig(api?.config), version, newSessions.consume);
    const governed = config.features.governedEscalation.enabled
      ? createApprovalGate({ config: config.governedEscalation, pricing: createPricing(config.costVisibility.pricing, fallbackLogger) }) : null;
    const interceptor = createInterceptor({ config, hostConfig: api?.config, hostSession: () => { try { return api?.runtime?.agent?.session ?? null; } catch { return null; } }, logger: routingLogger, seam, version, audit, governedEscalation: governed, requestCorrelation, availability, lineageResolver, usageEvents, fallbackLogger });
    api.on("session_start", (event, context) => newSessions.mark({ sessionId: event?.sessionId || context?.sessionId, sessionKey: event?.sessionKey || context?.sessionKey }));
    api.on("before_model_resolve", interceptor, { priority: 100 });
    if (governed) {
      api.on("before_agent_reply", (event, context) => interceptor.preflight({ ...event, prompt: event?.cleanedBody || event?.prompt || "" }, context), { priority: 100, eligibleTriggers: ["user"] });
      api.on("before_agent_run", governed.beforeAgentRun, { priority: 100 });
      api.on("agent_turn_prepare", governed.prepareTurn, { priority: 100 });
      api.on("llm_output", governed.observeOutput, { priority: 100 });
      api.on("message_sending", governed.appendReceipt, { priority: 100 });
      api.on("reply_payload_sending", governed.prepareReplyPayload, { priority: 100 });
    }
    seam.detect().catch((error) => { try { fallbackLogger?.warn?.(`togglelogic: Intelligence detection failed: ${error?.message || error}`); } catch {} });
    registered.push("routing"); mark("routing", true, "configured");
    if (governed) { registered.push("governedEscalation"); mark("governedEscalation", true, "configured"); }
    else mark("governedEscalation", false, "disabled");
  } else {
    mark("routing", false, "disabled"); mark("governedEscalation", false, "routing disabled");
  }

  if (config.features.ownerOverrideAsk.enabled) {
    api.on("message_sending", createOwnerOverrideAskHandler({ config, fallbackLogger }), { priority: 50 });
    registered.push("ownerOverrideAsk"); mark("ownerOverrideAsk", true, "configured");
  } else mark("ownerOverrideAsk", false, "disabled");

  if (config.features.costVisibility.enabled) {
    api.on("llm_output", (event, context) => availability.observe(event, requestCorrelation.lookup(event, context)), { priority: 60 });
    costObserver = createCostObserver({ config, hostConfig: api?.config, audit, fallbackLogger, requestCorrelation, usageEvents, deps: { pricing: sharedPricing } });
    api.on("llm_output", costObserver.handler, { priority: 50 });
    registered.push("costVisibility"); mark("costVisibility", true, "configured");
  } else mark("costVisibility", false, "disabled");

  return { registered, gates, usageEvents, costObserver };
}

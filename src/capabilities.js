import { createInterceptor } from "./routing/interceptor.js";
import { createIntelligenceSeam } from "./intelligence/seam.js";
import { createLogger as createRoutingLogger } from "./observability/logger.js";
import { createOwnerOverrideAskHandler } from "./capture/owner-override-ask.js";
import { createCostObserver } from "./usage/cost-observer.js";
import { createApprovalGate } from "./governance/approval-gate.js";
import { createPricing } from "./usage/pricing.js";
import { createNewSessionTracker } from "./routing/new-session-tracker.js";

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
  const registered = [];
  const gates = [];
  const mark = (id, enabled, reason) => gates.push({ id, enabled, reason });

  if (config.features.routing.enabled) {
    const routingLogger = createRoutingLogger(config.logging, fallbackLogger);
    const newSessions = createNewSessionTracker();
    const seam = createIntelligenceSeam(config.intelligence, fallbackLogger, buildRuntimeConfigFromApiConfig(api?.config), version, newSessions.consume);
    const governed = config.features.governedEscalation.enabled
      ? createApprovalGate({ config: config.governedEscalation, pricing: createPricing(config.costVisibility.pricing, fallbackLogger) }) : null;
    const interceptor = createInterceptor({ config, hostConfig: api?.config, logger: routingLogger, seam, version, audit, governedEscalation: governed });
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
    api.on("llm_output", createCostObserver({ config, fallbackLogger }).handler, { priority: 50 });
    registered.push("costVisibility"); mark("costVisibility", true, "configured");
  } else mark("costVisibility", false, "disabled");

  return { registered, gates };
}

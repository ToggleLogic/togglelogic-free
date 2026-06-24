/*
 * ToggleLogic (Free Tier) — Capability Registry.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 *
 * Free-tier capabilities only: routing (static/intent + simple cheap default +
 * lazy-detection seam) and ownerOverrideAsk (the user-override notifier). The
 * paid and deployment-internal capabilities (per-message dispatch, usage metering,
 * turn-end memory capture, credential/db-write gates) are not part of this
 * package.
 */

import { createInterceptor } from "./routing/interceptor.js";
import { createIntelligenceSeam } from "./intelligence/seam.js";
import { createLogger as createRoutingLogger } from "./observability/logger.js";
import { createOwnerOverrideAskHandler } from "./capture/owner-override-ask.js";

import { EVENTS, OUTCOMES } from "./audit/audit-events.js";

/**
 * Build the execution-surface runtime view from OpenClaw's runtime config
 * (api.config) — provider/model -> agentRuntime.id. Passed to the seam so an
 * (optional, separately-licensed) Intelligence layer can resolve each lane's
 * execution surface from the gateway's OWN config. Defensive: any shape issue
 * yields an empty map.
 */
function buildRuntimeConfigFromApiConfig(cfg) {
  const out = { byProvider: {}, byModel: {} };
  try {
    const providers = (cfg && cfg.models && cfg.models.providers) || {};
    for (const [prov, v] of Object.entries(providers)) {
      const rt = v && v.agentRuntime && v.agentRuntime.id;
      if (typeof rt === "string" && rt) out.byProvider[prov] = rt;
    }
    const models = cfg && cfg.agents && cfg.agents.defaults && cfg.agents.defaults.models;
    if (models) {
      for (const [ref, v] of Object.entries(models)) {
        const rt = v && v.agentRuntime && v.agentRuntime.id;
        if (typeof rt === "string" && rt) out.byModel[ref] = rt;
      }
    }
  } catch (_) { /* fall back to engine defaults */ }
  return out;
}

/**
 * Capability registry — one entry per feature group. Customer/community
 * deployments use the config.features flags as a delivery-time toggle.
 * register() is defensive: a failure in one capability must not block others.
 */
export const CAPABILITIES = [
  {
    id: "routing",
    // Opt-in. Operators set features.routing.enabled = true AND the gateway's
    // plugins.entries.togglelogic.hooks.allowConversationAccess to arm it.
    defaultEnabled: false,
    description:
      "Model routing: before_model_resolve hook. Resolves owner-override > " +
      "static configuredRoutes > simple cheap default > passthrough. Optionally " +
      "defers to a separately-licensed Intelligence layer via the detection seam " +
      "(no benchmark engine or registry ships in this package).",
    register({ api, audit, fallbackLogger, version, config }) {
      const routingLogger = createRoutingLogger(config.logging, fallbackLogger);
      const hostRuntimeConfig = buildRuntimeConfigFromApiConfig(api && api.config);
      const seam = createIntelligenceSeam(config.intelligence, fallbackLogger, hostRuntimeConfig);
      const interceptor = createInterceptor({
        config,
        hostConfig: api && api.config,
        logger: routingLogger,
        seam,
        version,
        audit,
      });
      api.on("before_model_resolve", interceptor);

      // Lazy intelligence detection (no-op without a licensed layer present).
      seam.detect().catch((err) => {
        try {
          audit.emit({
            event: EVENTS.ROUTING_HOOK_FIRE,
            outcome: OUTCOMES.FAILURE,
            principal: { source: "plugin-host" },
            subject: { phase: "intelligence-detect" },
            details: { error: String(err?.message ?? err).slice(0, 512) },
          });
        } catch { /* ignore */ }
        try {
          fallbackLogger?.warn?.(
            `togglelogic: intelligence detection error: ${err?.message ?? err}`
          );
        } catch { /* ignore */ }
      });

      return {
        hooks: ["before_model_resolve"],
        intelligence: { enabled: config.intelligence.enabled },
      };
    },
  },
  {
    id: "ownerOverrideAsk",
    // Opt-in. The user-override "switch back?" notifier: when an owner override
    // is active and a substantive turn completes, structurally invokes the
    // deployment-supplied consumer so the owner can be prompted to resume the
    // default. Fire-and-forget; authors no prompt content (deployment-side).
    defaultEnabled: false,
    description:
      "Owner-override switch-back notifier. Registers message_sending. Invokes " +
      "the deployment-supplied consumer when an override is active so the owner " +
      "can be prompted to switch back. Never blocks delivery; no prompt content " +
      "authored here.",
    register({ api, audit, fallbackLogger, config }) {
      const handler = createOwnerOverrideAskHandler({ config, fallbackLogger });
      api.on("message_sending", handler);
      return { hooks: ["message_sending"] };
    },
  },
];

/**
 * Resolve which capabilities are enabled given operator config. "reason" is
 * recorded in the feature-gate audit line so the stream shows what's on + why.
 */
export function resolveFeatureGates(features) {
  const f = features && typeof features === "object" ? features : {};
  return CAPABILITIES.map((cap) => {
    const entry = f[cap.id];
    if (!entry || typeof entry !== "object") {
      return { id: cap.id, enabled: cap.defaultEnabled, reason: "default" };
    }
    if (entry.enabled === true) return { id: cap.id, enabled: true, reason: "explicit-on" };
    if (entry.enabled === false) return { id: cap.id, enabled: false, reason: "explicit-off" };
    return { id: cap.id, enabled: cap.defaultEnabled, reason: "default-malformed-entry" };
  });
}

/**
 * Drive capability registration. Emits one feature-gate audit line per
 * capability (including dormant ones) so the audit stream documents every
 * startup decision.
 */
export function registerCapabilities({ api, audit, fallbackLogger, version, config }) {
  const gates = resolveFeatureGates(config.features);
  const registered = [];

  for (const gate of gates) {
    const cap = CAPABILITIES.find((c) => c.id === gate.id);
    if (!cap) continue;

    if (!gate.enabled) {
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.SKIP,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: false, reason: gate.reason, description: cap.description },
      });
      continue;
    }

    try {
      const summary = cap.register({ api, audit, fallbackLogger, version, config });
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.SUCCESS,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: true, reason: gate.reason, description: cap.description, ...summary },
      });
      registered.push(cap.id);
    } catch (err) {
      audit.emit({
        event: EVENTS.FEATURE_GATE,
        outcome: OUTCOMES.FAILURE,
        principal: { source: "plugin-host" },
        subject: { capability: cap.id },
        details: { enabled: false, reason: "register-error", error: String(err?.message ?? err).slice(0, 512) },
      });
      try {
        fallbackLogger?.warn?.(
          `togglelogic: capability "${cap.id}" failed to register: ${err?.message ?? err}`
        );
      } catch { /* ignore */ }
    }
  }

  return { registered, gates };
}

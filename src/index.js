/*
 * ToggleLogic (Free Tier) — a model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING (U.S. provisional applications). The patented "ToggleLogic
 * Intelligence" benchmark model-selection engine and the Toggle Registry are
 * NOT included in this package; this plugin only DETECTS and defers to a
 * separately-licensed Intelligence layer if one is installed.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { normalizeConfig } from "./config/normalize.js";
import { createAuditLogger } from "./audit/audit-logger.js";
import { EVENTS, OUTCOMES } from "./audit/audit-events.js";
import { registerCapabilities } from "./capabilities.js";

const PLUGIN_VERSION = "0.7.0-beta";

/**
 * ToggleLogic (Free Tier) plugin entry.
 *
 * register(api) is synchronous (gateway requirement). Free-tier capabilities:
 *   - routing:         the before_model_resolve hook — owner-override (top
 *                      priority) > static configuredRoutes > simple cheap
 *                      default > passthrough. No benchmark engine, no registry.
 *   - ownerOverrideAsk: the user-override "switch back?" notifier (the learning
 *                      loop's deployment-side prompt trigger).
 * A structured audit stream (NIST 800-53 AU-2/AU-3/AU-12 ready) covers each
 * routing decision.
 *
 * Routing is opt-in: set features.routing.enabled = true (and the gateway's
 * plugins.entries.togglelogic.hooks.allowConversationAccess) to arm it.
 */
const plugin = definePluginEntry({
  id: "togglelogic",
  name: "ToggleLogic",
  description:
    "Free-tier model routing for OpenClaw: bring your own provider credentials, " +
    "declare intent, and let the plugin apply your sticky model overrides, static " +
    "routes, and a simple cheapest-default — with a structured audit stream. " +
    "An optional, separately-licensed Intelligence layer (patent pending) can add " +
    "benchmark-driven automatic selection; it is not included here.",

  register(api) {
    const config = normalizeConfig(api.pluginConfig);
    const audit = createAuditLogger(config.audit, api.logger, {
      pluginId: "togglelogic",
      pluginVersion: PLUGIN_VERSION,
    });

    audit.emit({
      event: EVENTS.CONFIG_LOAD,
      outcome: OUTCOMES.SUCCESS,
      principal: { source: "plugin-host" },
      subject: { configSource: "openclaw.json#plugins.entries.togglelogic.config" },
      details: {
        mode: config.mode,
        features: config.features,
        audit: { enabled: config.audit.enabled, path: audit.path },
        routingLogPath: config.logging.path,
        routingLogEnabled: config.logging.enabled,
        intelligenceEnabled: config.intelligence.enabled,
        intelligencePath: config.intelligence.path,
      },
    });

    const { registered, gates } = registerCapabilities({
      api,
      audit,
      fallbackLogger: api.logger,
      version: PLUGIN_VERSION,
      config,
    });

    audit.emit({
      event: EVENTS.PLUGIN_REGISTER,
      outcome: OUTCOMES.SUCCESS,
      principal: { source: "plugin-host" },
      subject: { pluginVersion: PLUGIN_VERSION },
      details: {
        registeredCapabilities: registered,
        capabilityGates: gates,
        auditSessionId: audit.sessionId,
      },
    });

    try {
      const gateSummary = gates
        .map((g) => `${g.id}=${g.enabled ? "on" : "off"}(${g.reason})`)
        .join(", ");
      api.logger?.info?.(
        `togglelogic ${PLUGIN_VERSION} (free) registered. Mode: ${config.mode}. ` +
          `Features: ${gateSummary}. Audit: ${audit.enabled ? "on" : "off"} (${audit.path}).`
      );
    } catch {
      /* ignore logger failures */
    }
  },
});

export default plugin;

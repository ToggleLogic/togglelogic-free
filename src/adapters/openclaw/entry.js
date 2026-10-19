/*
 * ToggleLogic (Free Tier) — OpenClaw adapter: plugin entry (definePluginEntry + register).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig } from "../../config/normalize.js";
import { createAuditLogger } from "../../audit/audit-logger.js";
import { EVENTS, OUTCOMES } from "../../audit/audit-events.js";
import { registerCapabilities } from "./register.js";
import { openClawPaths } from "./paths.js";
import { shouldSkipRuntimeRegistration } from "../../registration-mode.js";

/** The published OpenClaw plugin entry. Same id, config schema and hooks as Free 2.1.x. */
export function createOpenClawPluginEntry({ version }) {
  return definePluginEntry({
    id: "togglelogic",
    name: "ToggleLogic",
    description: "Generic OpenClaw model routing, approvals, audit, and cost visibility. It includes no assistant, memory, skills, or business workflow policy.",
    register(api) {
      if (shouldSkipRuntimeRegistration(api?.registrationMode)) return;
      const config = normalizeConfig(api.pluginConfig);
      // Host state locations are resolved once here and injected.
      const paths = openClawPaths(process.env);
      const audit = createAuditLogger(config.audit, api.logger, { pluginId: "togglelogic", pluginVersion: version }, { paths });
      audit.emit({ event: EVENTS.CONFIG_LOAD, outcome: OUTCOMES.SUCCESS, principal: { source: "plugin-host" }, subject: { configSource: "openclaw.json#plugins.entries.togglelogic.config" }, details: { mode: config.mode, features: config.features } });
      const { registered, gates } = registerCapabilities({ api, audit, fallbackLogger: api.logger, version, config, paths });
      audit.emit({ event: EVENTS.PLUGIN_REGISTER, outcome: OUTCOMES.SUCCESS, principal: { source: "plugin-host" }, subject: { pluginVersion: version }, details: { registeredCapabilities: registered, capabilityGates: gates } });
    },
  });
}

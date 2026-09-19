import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeConfig } from "./config/normalize.js";
import { createAuditLogger } from "./audit/audit-logger.js";
import { EVENTS, OUTCOMES } from "./audit/audit-events.js";
import { registerCapabilities } from "./capabilities.js";
import { shouldSkipRuntimeRegistration } from "./registration-mode.js";

const PLUGIN_VERSION = "2.0.1";

export default definePluginEntry({
  id: "togglelogic",
  name: "ToggleLogic",
  description: "Generic OpenClaw model routing, approvals, audit, and cost visibility. It includes no assistant, memory, skills, or business workflow policy.",
  register(api) {
    if (shouldSkipRuntimeRegistration(api?.registrationMode)) return;
    const config = normalizeConfig(api.pluginConfig);
    const audit = createAuditLogger(config.audit, api.logger, { pluginId: "togglelogic", pluginVersion: PLUGIN_VERSION });
    audit.emit({ event: EVENTS.CONFIG_LOAD, outcome: OUTCOMES.SUCCESS, principal: { source: "plugin-host" }, subject: { configSource: "openclaw.json#plugins.entries.togglelogic.config" }, details: { mode: config.mode, features: config.features } });
    const { registered, gates } = registerCapabilities({ api, audit, fallbackLogger: api.logger, version: PLUGIN_VERSION, config });
    audit.emit({ event: EVENTS.PLUGIN_REGISTER, outcome: OUTCOMES.SUCCESS, principal: { source: "plugin-host" }, subject: { pluginVersion: PLUGIN_VERSION }, details: { registeredCapabilities: registered, capabilityGates: gates } });
  },
});

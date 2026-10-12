/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

import { CONVERSATION_ACCESS_SETTING } from "../hooks/conversation-access.js";

const CHECK_ID = "togglelogic-conversation-access-required";

/**
 * Build an OpenClaw HealthCheck that reports not-ready when routing is enabled
 * but the host has not granted conversation-hook access. The check reads the
 * host config directly (ctx.cfg) because a health check has no plugin `api`
 * handle.
 *
 * NOTE: this is a tested, reusable primitive. OpenClaw 2026.9.9 does NOT run an
 * external plugin's health checks in `openclaw doctor` (doctor loads external
 * plugins with activate:false and never calls their register()), so this check
 * is not surfaced there today. The live readiness signal for the shipped plugin
 * is the not-ready routing capability gate + the error log + the routing.skipped
 * audit (see src/capabilities.js). This module exists so the readiness logic is
 * unit-tested and ready for a host/bundling that DOES run plugin health checks.
 */
export function createConversationAccessCheck() {
  return {
    id: CHECK_ID,
    kind: "plugin",
    description:
      "ToggleLogic routing requires host permission to register conversation " +
      "hooks; without it, routing is disabled and turns use the host default model.",
    async detect(ctx) {
      const entry = ctx?.cfg?.plugins?.entries?.togglelogic;
      const entryEnabled = entry != null && entry.enabled !== false;
      const routingEnabled = entry?.config?.features?.routing?.enabled === true;
      const granted = entry?.hooks?.allowConversationAccess === true;
      if (entryEnabled && routingEnabled && !granted) {
        return [
          {
            checkId: CHECK_ID,
            severity: "error",
            message:
              `Routing is disabled: ${CONVERSATION_ACCESS_SETTING} is not true, ` +
              "so ToggleLogic's conversation hooks are blocked and turns fall " +
              "through to the host default model.",
            ocPath: CONVERSATION_ACCESS_SETTING,
            fixHint:
              `Set ${CONVERSATION_ACCESS_SETTING}: true and restart the gateway.`,
          },
        ];
      }
      return [];
    },
  };
}

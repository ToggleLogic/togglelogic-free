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
 * Build the OpenClaw HealthCheck that `openclaw doctor` surfaces as not-ready
 * when routing is enabled but the host has not granted conversation-hook
 * access. The check reads the host config directly (ctx.cfg) because a health
 * check has no plugin `api` handle.
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

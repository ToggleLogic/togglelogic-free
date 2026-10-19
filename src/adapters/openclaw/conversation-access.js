/*
 * ToggleLogic (Free Tier) — model-routing plugin for OpenClaw.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 */

/**
 * Conversation-access detection.
 *
 * OpenClaw blocks a non-bundled plugin from registering conversation hooks
 * unless the host config explicitly opts in. The gated conversation hooks are:
 *
 *   before_model_resolve, agent_turn_prepare, before_prompt_build,
 *   before_agent_reply, llm_input, llm_output, before_agent_finalize,
 *   agent_end, before_agent_run
 *
 * Routing rides on before_model_resolve (and governed escalation on several of
 * the others), so without the opt-in the routing hook never fires and turns
 * fall through to the host default model — previously a silent failure whose
 * only signal was a host-side startup warning.
 *
 * The non-gated lifecycle hooks (session_start, session_end) still fire even
 * when conversation access is denied, which is why session_start is usable to
 * re-surface the skip on every new session.
 *
 * The host surfaces the opt-in flag to the plugin at register time via
 * api.config (the full OpenClaw config). A non-bundled plugin requires the flag
 * to be explicitly === true.
 */

export const CONVERSATION_ACCESS_SETTING =
  "plugins.entries.togglelogic.hooks.allowConversationAccess";

/**
 * Whether the host granted this (non-bundled) plugin permission to register
 * conversation hooks. Requires an explicit `true`; absent/false means denied.
 */
export function isConversationAccessGranted(api) {
  return (
    api?.config?.plugins?.entries?.togglelogic?.hooks?.allowConversationAccess ===
    true
  );
}

/**
 * Operator-facing startup message for the denied case. Names the exact setting
 * and states that routing is disabled until the flag is set and the gateway is
 * restarted. Carries no prompt/conversation content.
 */
export function conversationAccessDeniedMessage() {
  return (
    "togglelogic: routing is DISABLED because conversation hook access is not " +
    "granted. The host blocks ToggleLogic's conversation hooks " +
    "(before_model_resolve and the governed-escalation hooks) for this " +
    `non-bundled plugin unless ${CONVERSATION_ACCESS_SETTING} is true. Until it ` +
    "is set to true and the gateway is restarted, turns fall through to the " +
    "host default model and are NOT routed."
  );
}

/**
 * Audit `details` payload for ROUTING_SKIPPED. No prompt/conversation content —
 * only the reason, the required setting, and the configured routing mode.
 */
export function conversationAccessDeniedAuditDetails(mode) {
  return {
    reason: "conversation-access-denied",
    requiredSetting: CONVERSATION_ACCESS_SETTING,
    mode,
  };
}

/*
 * ToggleLogic (Free Tier) — skill-routing canary scope.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Bounds ACTIVE skill routing + education to an explicit, deployment-declared
 * set of trusted hook-context identities (channel / account / sender / chat /
 * session). This is the correction for the 2026-09-15 GLOBAL active canary:
 * a canary must be limited to the owner's own channel (Al's SAM Telegram DM),
 * and every out-of-scope turn must remain shadow / passthrough.
 *
 * Every input read here comes from the host's TRUSTED PluginHookAgentContext
 * (channel, accountId, senderId, chatId, sessionKey, trigger, inputProvenance)
 * — never from model output or message body. The before_agent_reply hook is
 * additionally registered with eligibleTriggers:["user"], so the host itself
 * refuses to fire it for cron/heartbeat turns; the trigger check below is
 * defense-in-depth for hosts/paths that do not enforce eligibleTriggers.
 */

const AGENT_TURN = "user";

function cleanId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanId(item)).filter(Boolean))];
}

/**
 * Resolve the trusted sender id from the hook context. Prefer the top-level
 * senderId; fall back to the channel-owned sender identity the host attaches
 * under channelContext.sender.id.
 */
export function contextSenderId(hookContext = {}) {
  return cleanId(hookContext?.senderId) || cleanId(hookContext?.channelContext?.sender?.id);
}

export function contextChatId(hookContext = {}) {
  return cleanId(hookContext?.chatId) || cleanId(hookContext?.channelId) ||
    cleanId(hookContext?.channelContext?.chat?.id);
}

/**
 * normalizeScope — coerce the raw config.scope into a trusted shape. Empty
 * dimensions are UNCONSTRAINED; a scope with zero constraints is only honored
 * for active routing when allowGlobal === true (fail-safe against another
 * accidental global canary).
 */
export function normalizeScope(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === true,
    allowGlobal: r.allowGlobal === true,
    requireOwner: r.requireOwner !== false, // default: owner-bound
    channels: [...new Set(normalizeList(r.channels).map((value) => value.toLowerCase()))],
    accountIds: normalizeList(r.accountIds),
    senderIds: normalizeList(r.senderIds),
    chatIds: normalizeList(r.chatIds),
    sessionKeys: normalizeList(r.sessionKeys),
    ownerSenderIds: normalizeList(r.ownerSenderIds),
  };
}

export function scopeHasConstraint(scope) {
  return (
    scope.channels.length > 0 ||
    scope.accountIds.length > 0 ||
    scope.senderIds.length > 0 ||
    scope.chatIds.length > 0 ||
    scope.sessionKeys.length > 0
  );
}

/**
 * createCanaryScope — an evaluator bound to a normalized scope. `evaluate`
 * returns a structured decision the coordinator uses to keep out-of-scope turns
 * shadow/passthrough. It never throws.
 */
export function createCanaryScope(rawScope) {
  const scope = normalizeScope(rawScope);
  const constrained = scopeHasConstraint(scope);

  function isOwner(hookContext) {
    // Prefer the host's trusted senderIsOwner bit when a hook supplies it; the
    // before_agent_reply agent context does not, so fall back to the configured
    // owner-sender allowlist matched against the trusted senderId.
    if (hookContext?.senderIsOwner === true) return true;
    const sender = contextSenderId(hookContext);
    if (!sender) return false;
    if (scope.ownerSenderIds.length > 0) return scope.ownerSenderIds.includes(sender);
    // No explicit owner allowlist: fall back to the senderIds scope dimension,
    // which for the SAM-HQ canary is the owner's own peer id.
    return scope.senderIds.length > 0 ? scope.senderIds.includes(sender) : false;
  }

  function evaluate(hookContext = {}) {
    const trigger = cleanId(hookContext?.trigger);
    const channel = cleanId(hookContext?.channel)?.toLowerCase() || null;
    const accountId = cleanId(hookContext?.accountId);
    const senderId = contextSenderId(hookContext);
    const chatId = contextChatId(hookContext);
    const sessionKey = cleanId(hookContext?.sessionKey) || cleanId(hookContext?.sessionId);
    const provenance = cleanId(hookContext?.inputProvenance?.kind);

    const facts = { channel, accountId, senderId, chatId, sessionKey, trigger, provenance };

    // Not scoped at all: only active if the operator explicitly opted into a
    // global canary. Otherwise stay shadow/passthrough (the failure mode we are
    // correcting).
    if (!scope.enabled) {
      return { inScope: false, reason: "scope_disabled", facts };
    }
    if (!constrained && !scope.allowGlobal) {
      return { inScope: false, reason: "scope_unconstrained_no_global", facts };
    }

    // Host-triggered (cron/heartbeat) or non-external-user turns are never in an
    // owner canary, regardless of channel match.
    if (trigger && trigger !== AGENT_TURN) {
      return { inScope: false, reason: `trigger_excluded:${trigger}`, facts };
    }
    if (provenance && provenance !== "external_user") {
      return { inScope: false, reason: `provenance_excluded:${provenance}`, facts };
    }

    if (scope.requireOwner && !isOwner(hookContext)) {
      return { inScope: false, reason: "not_owner", facts };
    }

    // Each CONFIGURED (non-empty) dimension must be present AND match.
    const dims = [
      ["channel", scope.channels, channel],
      ["accountId", scope.accountIds, accountId],
      ["senderId", scope.senderIds, senderId],
      ["chatId", scope.chatIds, chatId],
      ["sessionKey", scope.sessionKeys, sessionKey],
    ];
    const matched = [];
    for (const [name, allow, value] of dims) {
      if (allow.length === 0) continue;
      if (!value || !allow.includes(value)) {
        return { inScope: false, reason: `dimension_miss:${name}`, facts };
      }
      matched.push(name);
    }

    return { inScope: true, reason: "in_scope", matched, facts };
  }

  return { evaluate, scope, constrained, isOwner };
}

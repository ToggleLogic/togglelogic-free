/*
 * ToggleLogic (Free Tier) — bounded-child tool guard (before_tool_call).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * BLOCKER-2 CLOSURE (the plugin-enforceable half). OpenClaw 2026.9.4 exposes no
 * SubagentRunParams field to cap a child's model-token spend or number of model
 * passes, and no plugin API to abort a running child's model call (see
 * docs/BOUNDED-CHILD-LIMITS.md). What the host DOES expose is `before_tool_call`
 * with a real `{ block: true }` deny path and the child's `sessionKey` in context.
 *
 * This guard uses that to enforce, on the routed child ONLY (sessionKey containing
 * ":togglelogic-skill:"), three real limits the host cannot otherwise apply:
 *   1. re-entrancy deny — a routed child may never call the ToggleLogic routing
 *      tools (no nested routing), regardless of prompt;
 *   2. per-skill tool allowlist — when a deployment declares one, tools outside it
 *      are denied at the child;
 *   3. a hard tool-call COUNT ceiling per child run — after N allowed tool calls,
 *      further tool calls are denied (bounds a runaway tool loop; it does NOT cap
 *      model tokens, which the host does not expose — that limit is documented as
 *      the residual gap).
 * It also records the ACTUAL tool-call count for the post-run usage audit.
 *
 * It NEVER interferes with non-child sessions (returns undefined = abstain) and
 * NEVER throws into the host hook. Once the session has been positively
 * identified as a routed child, an internal guard error FAILS CLOSED: the call
 * is blocked, counted, logged, and surfaced in the post-run usage audit.
 */

import crypto from "node:crypto";

const SKILL_SESSION_MARKER = ":togglelogic-skill:";
// Re-entrant ToggleLogic tools are ALWAYS denied inside a routed child.
const REENTRANT_DENY = new Set(["togglelogic_skill_plan", "togglelogic_skill_run"]);
const DEFAULT_MAX_TOOL_CALLS = 32;
const MAX_TRACKED_SESSIONS = 256;

export function isChildSkillSession(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.includes(SKILL_SESSION_MARKER);
}

export function createChildToolGuard({ maxToolCalls = DEFAULT_MAX_TOOL_CALLS, logger, auditInternalError } = {}) {
  const defaultMax = Number.isFinite(maxToolCalls) && maxToolCalls >= 0 ? Math.floor(maxToolCalls) : DEFAULT_MAX_TOOL_CALLS;
  // childSessionKey -> { count, denied, max, allowedTools:Set|null, skills:[],
  // plannedModelRef, deniedTools:[] }. The model binding is registered before
  // subagent.run and is the authority used by before_model_resolve for this child.
  const sessions = new Map();

  function prune() {
    while (sessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
    }
  }

  function ensure(childSessionKey) {
    let entry = sessions.get(childSessionKey);
    if (!entry) {
      entry = { count: 0, denied: 0, internalErrors: 0, max: defaultMax, allowedTools: null, skills: [], plannedModelRef: null, deniedTools: [] };
      sessions.set(childSessionKey, entry);
      prune();
    }
    return entry;
  }

  /**
   * Register the precise policy for a child BEFORE it runs. Overwrites any lazily
   * created entry. `allowedTools` null = no allowlist (count-only); [] = no tools.
   */
  function register(childSessionKey, { skills = [], allowedTools = null, maxToolCalls: max, plannedModelRef = null } = {}) {
    if (!childSessionKey) return;
    sessions.set(childSessionKey, {
      count: 0,
      denied: 0,
      internalErrors: 0,
      max: Number.isFinite(max) && max >= 0 ? Math.floor(max) : defaultMax,
      allowedTools: Array.isArray(allowedTools) ? new Set(allowedTools) : null,
      skills: (skills || []).map((s) => (typeof s === "string" ? s : s?.id)).filter(Boolean),
      plannedModelRef: typeof plannedModelRef === "string" && /^[^/\s]+\/[^/\s]+$/.test(plannedModelRef)
        ? plannedModelRef : null,
      deniedTools: [],
    });
    prune();
  }

  /** Read the current counters without removing the entry. */
  function snapshot(childSessionKey) {
    const e = sessions.get(childSessionKey);
    if (!e) return null;
    return {
      toolCalls: e.count,
      deniedToolCalls: e.denied,
      internalGuardErrors: e.internalErrors || 0,
      ceiling: e.max,
      allowlisted: Boolean(e.allowedTools),
      deniedTools: [...e.deniedTools],
    };
  }

  /** Remove the entry after the run; returns its final counters for the audit. */
  function release(childSessionKey) {
    const snap = snapshot(childSessionKey);
    sessions.delete(childSessionKey);
    return snap;
  }

  /**
   * Return the execution-bound provider/model override for a registered routed
   * child. No owner/scope classification is consulted: authorization happened
   * on the parent turn before this binding was created.
   */
  function routeBindingFor(childSessionKey) {
    if (!isChildSkillSession(childSessionKey)) return null;
    const modelRef = sessions.get(childSessionKey)?.plannedModelRef;
    if (!modelRef) return null;
    const slash = modelRef.indexOf("/");
    return {
      modelRef,
      providerOverride: modelRef.slice(0, slash),
      modelOverride: modelRef.slice(slash + 1),
    };
  }

  function recordDenied(entry, toolName) {
    if (!entry) return;
    entry.denied += 1;
    if (toolName && entry.deniedTools.length < 32 && !entry.deniedTools.includes(toolName)) entry.deniedTools.push(toolName);
  }

  /**
   * before_tool_call handler. Returns { block, blockReason } to DENY, or undefined
   * to allow / abstain. Total: never throws into the host.
   */
  function beforeToolCall(event = {}, ctx = {}) {
    let sessionKey = null;
    let identifiedChild = false;
    try {
      sessionKey = ctx?.sessionKey;
      if (!isChildSkillSession(sessionKey)) return undefined; // not our child — abstain (allow)
      identifiedChild = true;
      const toolName = event?.toolName;
      const entry = ensure(sessionKey);

      // 1) Always deny re-entrant ToggleLogic routing tools inside a routed child.
      if (REENTRANT_DENY.has(toolName)) {
        recordDenied(entry, toolName);
        return { block: true, blockReason: "ToggleLogic does not allow a routed skill child to invoke ToggleLogic routing tools (no nested routing)." };
      }
      // 2) Per-skill allowlist (when configured): deny anything outside it.
      if (entry.allowedTools && !entry.allowedTools.has(toolName)) {
        recordDenied(entry, toolName);
        return { block: true, blockReason: `Tool "${String(toolName)}" is not in the allowed tool surface for this routed skill.` };
      }
      // 3) Hard tool-call COUNT ceiling per child run.
      if (entry.count >= entry.max) {
        recordDenied(entry, toolName);
        return { block: true, blockReason: `Routed skill child exceeded its tool-call ceiling (${entry.max}); further tool calls are denied.` };
      }
      entry.count += 1;
      return undefined; // allowed
    } catch (error) {
      // If the session could not be positively identified as one of ours, the
      // plugin has no authority to interfere. Once identified, however, allowing
      // on a guard fault would bypass the exact safety boundary this hook owns.
      if (!identifiedChild) return undefined;
      try {
        const entry = ensure(sessionKey);
        entry.internalErrors = (entry.internalErrors || 0) + 1;
        recordDenied(entry, "<guard-internal-error>");
      } catch { /* the block below is authoritative even if accounting also fails */ }
      try {
        const errorType = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name : "Error";
        auditInternalError?.({
          mode: "skill_child_guard_internal_error",
          child_session_key_hash: crypto.createHash("sha256").update(sessionKey).digest("hex"),
          error_type: errorType,
          blocked: true,
        });
      } catch { /* audit is best-effort; never weaken the block */ }
      try {
        const log = typeof logger?.error === "function" ? logger.error.bind(logger)
          : typeof logger?.warn === "function" ? logger.warn.bind(logger) : null;
        const errorType = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
          ? error.name : "Error";
        log?.(`togglelogic child tool guard: internal ${errorType}; BLOCKED governed child tool call`);
      } catch { /* logging is best-effort; never weaken the block */ }
      return {
        block: true,
        blockReason: "ToggleLogic blocked this routed child tool call because its safety guard encountered an internal error.",
      };
    }
  }

  return { register, release, snapshot, routeBindingFor, beforeToolCall, isChildSkillSession, defaultMax };
}

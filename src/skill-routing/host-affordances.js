/*
 * ToggleLogic (Free Tier) — skill-routing host-affordance self-check.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Postmortem §10.2: when skill routing is enabled the plugin MUST verify the
 * host actually provides what the guaranteed gate depends on, and fail LOUD
 * (gateway + audit) rather than registering a silently dead preflight. The
 * corrected gate depends on:
 *   - a hook API to register before_agent_reply on (api.on),
 *   - the bounded-child runtime (api.runtime.subagent.run/waitForRun/
 *     getSessionMessages) so resolved skills execute off the fat main session,
 *   - an explicit, constrained canary scope (or explicit allowGlobal) so active
 *     testing can never silently become the unscoped global canary that failed.
 *
 * Missing CRITICAL affordances force skill routing to shadow (no active gating),
 * loudly — the feature never pretends to gate when it cannot.
 */

export function verifyHostAffordances({ api, config }) {
  const missing = [];   // critical → force shadow
  const warnings = [];  // degraded but registerable

  if (typeof api?.on !== "function") {
    missing.push("host does not expose api.on (cannot register the before_agent_reply gate)");
  }
  const sub = api?.runtime?.subagent;
  if (!sub || typeof sub.run !== "function" || typeof sub.waitForRun !== "function" || typeof sub.getSessionMessages !== "function") {
    missing.push("host does not expose api.runtime.subagent.{run,waitForRun,getSessionMessages} (cannot execute resolved skills in a bounded child)");
  }

  const scope = config?.skillRouting?.scope || {};
  const constrained = [scope.channels, scope.accountIds, scope.senderIds, scope.chatIds, scope.sessionKeys]
    .some((list) => Array.isArray(list) && list.length > 0);
  if (!scope.enabled) {
    warnings.push("skillRouting.scope.enabled is false — active gating is INERT; every turn stays shadow/passthrough");
  } else if (!constrained && scope.allowGlobal !== true) {
    warnings.push("skillRouting.scope has no channel/account/sender/chat/session constraint and allowGlobal is not set — active gating stays INERT to avoid an unscoped global canary");
  }

  // Skill membership now comes from the DEPLOYMENT-OWNED inventory snapshot
  // (verified + drift-audited separately at registration). Only warn about an
  // empty config catalog when the deployment has explicitly OPTED OUT of the
  // snapshot (useSnapshotInventory:false), which reverts to the config catalog.
  const catalog = config?.skillRouting?.skillCatalog;
  const usesSnapshot = config?.skillRouting?.useSnapshotInventory !== false;
  if ((config?.skillRouting?.resolverMode ?? "deterministic") !== "off" && !usesSnapshot && (!Array.isArray(catalog) || catalog.length === 0)) {
    warnings.push("skillRouting.useSnapshotInventory is false and skillRouting.skillCatalog is empty — the resolver will recognize no installed skills; no turn can resolve to a skill");
  }

  const ok = missing.length === 0;
  return { ok, forceShadow: !ok, missing, warnings };
}

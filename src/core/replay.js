/*
 * ToggleLogic (Free Tier) — replay recorded routing decisions against a policy.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/**
 * Re-runs routing-log records (jsonl, one Decision per line) through the
 * decision core and reports where the result differs.
 *
 * A record is replayable only when its outcome depends on nothing but the
 * logged inputs and the policy. Records that depended on state the log does
 * not carry are counted, by reason, and never guessed at:
 *   owner_override                       owner (all-tasks) state at the time
 *   task_pin                             task-pin state is not reconstructed (§4.5)
 *   intelligence, intelligence_shadow, pin   the licensed seam
 *   provider_unavailable, fallback_unresolved  provider availability then
 *   fallback                             an error during dispatch
 * task_label_not_logged: the policy routes on a host task label and the record
 * does not carry one (a default-route or no-match record), so the result
 * under this policy cannot be known.
 * user_selection and request_selection replay with the precedence source taken
 * from the logged reason (the log has no separate source field); they prove the
 * policy still honors that precedence.
 *
 * The replay core runs with no seam, no availability, no owner override and no
 * audit sink, so it reads no live state and writes nothing.
 */
import { createDecisionCore, policyDigestOf } from "./decide.js";

export const NOT_REPLAYABLE = Object.freeze({
  owner_override: "owner override state is not in the log",
  task_pin: "task-pin state is not reconstructed by replay",
  intelligence: "depends on the licensed seam",
  intelligence_shadow: "depends on the licensed seam",
  pin: "depends on the licensed seam",
  provider_unavailable: "provider availability is not in the log",
  fallback_unresolved: "provider availability is not in the log",
  fallback: "dispatch error at the time",
});

// The host's requested selection, built exactly as the OpenClaw adapter builds
// it (provider "openrouter" + model "anthropic/x" is "openrouter/anthropic/x").
function selection(provider, model) {
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const p = clean(provider); const m = clean(model);
  if (!m) return p ? { provider: p, model: null, ref: p } : null;
  if (!p && m.includes("/")) return { provider: m.slice(0, m.indexOf("/")), model: m.slice(m.indexOf("/") + 1), ref: m };
  return { provider: p, model: m, ref: p ? `${p}/${m}` : m };
}

// The routing record's selection, compared as the logged pair so no ref is
// reconstructed (a model id may itself contain "/").
const selected = (provider, model) => ({ provider: provider ?? null, model: model ?? null });
const same = (a, b) => a.provider === b.provider && a.model === b.model;
const show = (s) => (s.model?.includes("/") || !s.provider ? s.model : s.model ? `${s.provider}/${s.model}` : s.provider);

// The host task label, when the log carries it: a configured route's matched key
// other than "default". A miss that fell to the default route, or matched
// nothing, does not log the label.
function loggedLabel(record) {
  const key = record.selectionDetails?.matchedKey;
  return record.selectionReason === "configured" && typeof key === "string" && key !== "default" ? key : null;
}

function labelMatters(policy) {
  return policy.mode === "configured" && Object.keys(policy.configuredRoutes ?? {}).some((key) => key !== "default");
}

function requestFromRecord(record) {
  const sel = selection(record.requestedProvider, record.requestedModel);
  const requestedRef = sel?.ref ?? null;
  const source = record.selectionReason === "user_selection" ? "user"
    : record.selectionReason === "request_selection" ? "request"
      : requestedRef ? (record.modelOverrideSource === "auto" ? "auto" : "default") : "none";
  const label = loggedLabel(record);
  return {
    requestId: record.requestId ?? null,
    agent: null,
    defaultRef: record.selectionDetails?.host_default ?? requestedRef,
    requested: { ref: requestedRef, provider: sel?.provider ?? null, model: sel?.model ?? null, source },
    candidates: [],
    fallbacks: [],
    host: { event: {}, context: label ? { taskType: label } : {} },
  };
}

export async function replayRecords(lines, policy, { version = null } = {}) {
  // Owner override reads live state files; replay never does.
  const replayPolicy = { ...policy, ownerOverride: { ...(policy.ownerOverride ?? {}), enabled: false } };
  const core = createDecisionCore({ policy: replayPolicy, services: { seam: { status: () => "absent", classify: async () => null } }, version });
  const report = { policyDigest: policyDigestOf(policy), total: 0, replayed: 0, matched: 0, unparseable: 0, notReplayable: {}, differences: [] };
  for (const line of lines) {
    if (!line.trim()) continue;
    report.total++;
    let record;
    try { record = JSON.parse(line); } catch { report.unparseable++; continue; }
    if (!record || typeof record.selectionReason !== "string") { report.unparseable++; continue; }
    const skip = NOT_REPLAYABLE[record.selectionReason] ? record.selectionReason
      : labelMatters(policy) && !loggedLabel(record) && record.selectionReason !== "user_selection" && record.selectionReason !== "request_selection" ? "task_label_not_logged" : null;
    if (skip) { report.notReplayable[skip] = (report.notReplayable[skip] ?? 0) + 1; continue; }
    const decision = { requestId: record.requestId ?? null, selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null };
    await core.decide(requestFromRecord(record), { decision });
    report.replayed++;
    const was = selected(record.selectedProvider, record.selectedModel);
    const now = selected(decision.selectedProvider, decision.selectedModel);
    if (record.selectionReason === decision.selectionReason && same(was, now)) report.matched++;
    else report.differences.push({ requestId: record.requestId ?? null, timestamp: record.timestamp ?? null,
      recorded: { reason: record.selectionReason, model: show(was) }, replayed: { reason: decision.selectionReason, model: show(now) } });
  }
  return report;
}

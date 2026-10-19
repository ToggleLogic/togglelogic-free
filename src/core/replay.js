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
 *   owner_override                       owner state at the time
 *   intelligence, intelligence_shadow, pin   the licensed seam
 *   provider_unavailable, fallback_unresolved  provider availability then
 *   fallback                             an error during dispatch
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
  intelligence: "depends on the licensed seam",
  intelligence_shadow: "depends on the licensed seam",
  pin: "depends on the licensed seam",
  provider_unavailable: "provider availability is not in the log",
  fallback_unresolved: "provider availability is not in the log",
  fallback: "dispatch error at the time",
});

const ref = (provider, model) => (model?.includes("/") ? model : provider && model ? `${provider}/${model}` : model || null);

function requestFromRecord(record) {
  const requestedRef = ref(record.requestedProvider, record.requestedModel);
  const source = record.selectionReason === "user_selection" ? "user"
    : record.selectionReason === "request_selection" ? "request"
      : requestedRef ? (record.modelOverrideSource === "auto" ? "auto" : "default") : "none";
  const i = requestedRef ? requestedRef.indexOf("/") : -1;
  const label = record.selectionDetails?.requestedKey ?? (record.selectionDetails?.matchedKey !== "default" ? record.selectionDetails?.matchedKey : null);
  return {
    requestId: record.requestId ?? null,
    agent: null,
    defaultRef: record.selectionDetails?.host_default ?? requestedRef,
    requested: { ref: requestedRef, provider: i > 0 ? requestedRef.slice(0, i) : null, model: i > 0 ? requestedRef.slice(i + 1) : null, source },
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
    if (NOT_REPLAYABLE[record.selectionReason]) {
      report.notReplayable[record.selectionReason] = (report.notReplayable[record.selectionReason] ?? 0) + 1;
      continue;
    }
    const decision = { requestId: record.requestId ?? null, selectedModel: null, selectedProvider: null, selectionReason: "passthrough", selectionDetails: {}, mode: null };
    await core.decide(requestFromRecord(record), { decision });
    report.replayed++;
    const was = { reason: record.selectionReason, model: ref(record.selectedProvider, record.selectedModel) };
    const now = { reason: decision.selectionReason, model: ref(decision.selectedProvider, decision.selectedModel) };
    if (was.reason === now.reason && was.model === now.model) report.matched++;
    else report.differences.push({ requestId: record.requestId ?? null, timestamp: record.timestamp ?? null, recorded: was, replayed: now });
  }
  return report;
}

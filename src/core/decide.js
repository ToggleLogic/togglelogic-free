/*
 * ToggleLogic (Free Tier) — host-neutral decision core: decide(request).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/**
 * M1 step 3 (Free 2.2.0): the routing decision order, extracted unchanged from
 * the OpenClaw interceptor. Order (design M1 §4.3):
 *
 *   1. governed escalation pre-check      5. early failover of the pending model
 *   2. owner override                     6. mode dispatch
 *   3. protected user selection           7. governed escalation post-check
 *   4. request selection                  8. failover of the selected model
 *
 * Input is a DecisionRequest built by a host adapter:
 *   requestId     correlation id (the routing record's id)
 *   agent         host agent or route id, passed to the lineage resolver
 *   defaultRef    the host's declared default for this agent or route
 *   requested     { ref, provider, model, source, pinSource? }, source one of
 *                 user | request | auto | default | none
 *   candidates    host allowlist (refs); fallbacks: host fallback refs, in order
 *   host          { event, context } — TRANSITIONAL: still needed by governed
 *                 escalation and mode dispatch until those take request fields
 *                 (M1 steps 4 and 7). The core reads nothing else from it.
 *
 * `requested`, `candidates` and `fallbacks` may be lazy getters: the core reads
 * them at exactly the point the interceptor did, so host reads (session store,
 * host config) happen in the same order and only when they did before.
 *
 * Output is a DecisionResponse:
 *   decision      { action: "route" | "passthrough", ref?, provider?, model? }
 *   reason        selectionReason vocabulary
 *   rationale     { details }
 *   recorded      false only when no routing record was written (governed
 *                 short-circuit, duplicate within the window)
 *
 * The adapter supplies hooks: `decision` (the routing record to fill),
 * `record()` (finalize and write it) and `beforeDispatch()` (host dedupe; false
 * stops before mode dispatch with a passthrough and no record).
 *
 * No environment reads, no default home paths, no host imports.
 */
import { deriveLineage } from "../routing/lineage.js";
import { resolveEffectiveMode, dispatchByMode } from "../routing/modes.js";
import { resolveOwnerOverride } from "../routing/owner-override.js";
import { EVENTS, OUTCOMES } from "../audit/audit-events.js";

export const DECISION_API_VERSION = "togglelogic.decision/v1";

// The interceptor's own "no change" marker. Mode dispatch returns its own
// empty override object, which the audit outcome deliberately does not treat
// as this marker (Free 2.1.x behavior, kept unchanged in this step).
const NO_CHANGE = Object.freeze({});
const emit = (audit, event, value) => { try { audit?.emit?.({ event, ...value }); } catch {} };

export function overrideToDecision(override) {
  const provider = override?.providerOverride ?? null;
  const model = override?.modelOverride ?? null;
  if (!provider && !model) return { action: "passthrough" };
  return { action: "route", ref: provider && model ? `${provider}/${model}` : (model || provider), provider, model };
}

export function createDecisionCore({ policy, services = {}, product = "togglelogic-free", version = null } = {}) {
  const { audit = null, seam, availability = null, lineageResolver = null, usageEvents = null,
    fallbackLogger = null, governedEscalation = null, paths = null } = services;
  const config = policy;

  function unresolved(decision, reason) {
    const details = { reason, selectionReason: "fallback_unresolved", selectedModel: decision.selectedModel };
    emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.FAILURE, principal: { source: "plugin" }, details, correlationId: decision.requestId });
    try { void Promise.resolve(usageEvents?.emit("fallback_unresolved", { provider: decision.selectedProvider, reason, requestId: decision.requestId })).catch(() => {}); } catch {}
    try { fallbackLogger?.warn?.("ToggleLogic fallback_unresolved: no fallback resolved; preserving the selection"); } catch {}
  }

  function respond(decision, override, recorded) {
    return {
      apiVersion: DECISION_API_VERSION,
      correlationId: decision?.requestId ?? null,
      decision: overrideToDecision(override),
      reason: decision?.selectionReason ?? "passthrough",
      rationale: { details: decision?.selectionDetails ?? {} },
      engine: { product, version },
      recorded,
    };
  }

  async function decide(request, { decision, record = () => {}, beforeDispatch = () => true } = {}) {
    const event = request?.host?.event;
    const context = request?.host?.context;

    // 1. Governed escalation pre-check.
    const governedPrior = governedEscalation?.beforeRouting(event?.prompt, context);
    if (governedPrior?.shortCircuit) return respond(decision, governedPrior.override || NO_CHANGE, false);

    // 2. Owner override.
    const owner = resolveOwnerOverride(config.ownerOverride, { paths });
    if (owner.applied) {
      const override = { modelOverride: owner.modelOverride, ...(owner.providerOverride ? { providerOverride: owner.providerOverride } : {}) };
      decision.selectedModel = owner.modelRef; decision.selectedProvider = owner.providerOverride || null; decision.selectionReason = "owner_override"; decision.selectionDetails = { matched_rule: "owner_override" };
      if (availability?.unavailable(owner.providerOverride || owner.modelRef.split("/")[0])) decision.selectionDetails.providerUnavailableConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.SUCCESS, principal: { source: "owner" }, subject: { hook: "before_model_resolve" }, details: { mode: "owner_override", selectedModel: owner.modelRef, ...decision.selectionDetails }, correlationId: decision.requestId });
      return respond(decision, override, true);
    }

    async function failover(ref, unchanged = NO_CHANGE) {
      if (!ref || !availability?.unavailable(ref.split("/")[0])) return null;
      let resolution;
      try { resolution = await lineageResolver?.(request.agent); } catch { /* try configured host fallbacks */ }
      if (!resolution?.child) {
        const allowed = new Set(request.candidates);
        const child = request.fallbacks.find((candidate) => allowed.has(candidate) && !availability.unavailable(candidate.split("/")[0]));
        if (child) resolution = { child, lineage: deriveLineage(child).lineage, reason: "host-configured-fallback" };
      }
      if (!resolution?.child) {
        decision.selectedModel = ref; decision.selectedProvider = ref.split("/")[0];
        decision.selectionReason = "fallback_unresolved";
        decision.selectionDetails = { failure: "no_available_fallback", skipped: resolution?.skipped ?? [] };
        unresolved(decision, "no_available_fallback");
        return unchanged;
      }
      const next = resolution.child, split = next.indexOf("/");
      decision.selectedModel = next; decision.selectedProvider = next.slice(0, split);
      decision.selectionReason = "provider_unavailable";
      decision.selectionDetails = { unavailableProvider: ref.split("/")[0], lineage: resolution.lineage,
        resolvedChild: next, resolutionReason: resolution.reason, skipped: resolution.skipped ?? [] };
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.SUCCESS, principal: { source: "plugin" },
        details: { selectionReason: decision.selectionReason, ...decision.selectionDetails }, correlationId: decision.requestId });
      return { providerOverride: next.slice(0, split), modelOverride: next.slice(split + 1) };
    }

    // 3. Protected user selection.
    const requested = request.requested;
    if (requested?.source === "user") {
      decision.selectedModel = requested.ref; decision.selectedProvider = requested.provider; decision.selectionReason = "user_selection"; decision.selectionDetails = { matched_rule: "user_selection_precedence", pin_source: requested.pinSource };
      if (availability?.unavailable(requested.provider)) decision.selectionDetails.userSelectionConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.NOOP, principal: { source: "user" }, details: { selectedModel: requested.ref, ...decision.selectionDetails }, correlationId: decision.requestId });
      return respond(decision, NO_CHANGE, true);
    }

    // 4. Request selection.
    if (requested?.source === "request") {
      decision.selectedModel = requested.ref; decision.selectedProvider = requested.provider; decision.selectionReason = "request_selection";
      decision.selectionDetails = { matched_rule: "request_selection_precedence", host_default: request.defaultRef };
      if (availability?.unavailable(requested.provider)) decision.selectionDetails.userSelectionConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.NOOP, principal: { source: "user" }, subject: { hook: "before_model_resolve" }, details: { mode: "request_selection", selectedModel: requested.ref, ...decision.selectionDetails }, correlationId: decision.requestId });
      return respond(decision, NO_CHANGE, true);
    }

    // 5. Early failover if the pending model's provider is unavailable.
    const pending = requested?.ref || request.defaultRef;
    const earlyFallback = await failover(pending);
    if (earlyFallback) { record(); return respond(decision, earlyFallback, true); }

    if (!beforeDispatch()) return respond(decision, NO_CHANGE, false);

    // 6. Mode dispatch, then 7. governed escalation post-check.
    let override = NO_CHANGE;
    try {
      const mode = resolveEffectiveMode(config.mode, seam.status(), config);
      decision.mode = mode;
      const result = await dispatchByMode({ mode, event, hookContext: context, config, seam });
      override = result.override; decision.selectedModel = result.selectedModel; decision.selectedProvider = result.selectedProvider; decision.selectionReason = result.selectionReason; decision.selectionDetails = result.selectionDetails;
      const governed = governedEscalation ? await governedEscalation.afterRouting(event?.prompt, context, result) : null;
      if (governed?.override) override = governed.override;
    } catch (error) {
      decision.selectionReason = "fallback"; decision.selectionDetails = { error: String(error?.message || error), fallbackOnError: config.intelligence.fallbackOnError };
      if (!config.intelligence.fallbackOnError) throw error;
    }

    // 8. Failover of the selected model.
    const selectedRef = decision.selectedModel?.includes("/") ? decision.selectedModel
      : refOf(decision.selectedProvider, decision.selectedModel);
    override = await failover(selectedRef, override) || override;
    record();
    if (decision.selectionReason !== "fallback_unresolved") emit(audit, EVENTS.ROUTING_DECISION, { outcome: override === NO_CHANGE ? OUTCOMES.NOOP : OUTCOMES.SUCCESS, principal: { source: "agent" }, subject: { hook: "before_model_resolve" }, details: { mode: decision.mode, selectedModel: decision.selectedModel, selectionReason: decision.selectionReason }, correlationId: decision.requestId });
    return respond(decision, override, true);
  }

  return Object.freeze({ decide, unresolved });
}

// provider + model → "provider/model"; model alone or provider alone as given.
function refOf(provider, model) {
  const clean = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  const p = clean(provider); const m = clean(model);
  if (!m) return p;
  if (!p) return m;
  return `${p}/${m}`;
}

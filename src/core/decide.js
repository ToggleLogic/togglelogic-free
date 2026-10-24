/*
 * ToggleLogic (Free Tier) — host-neutral decision core: decide(request).
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

/**
 * The routing decision order. Extracted from the OpenClaw interceptor in M1
 * step 3 (Free 2.2.0); reordered in M6 (Free 2.3.0) so owner pins sit BELOW the
 * owner's own protected pick and ABOVE a skill's request. Order (M6 §4.1):
 *
 *   1. governed escalation pre-check      5. early failover of the pending model
 *   2. protected user selection           6. mode dispatch (configured route)
 *   3. owner pins (task, else all-tasks)  7. governed escalation post-check
 *   4. request selection                  8. failover of the selected model
 *
 * BEHAVIOR CHANGE vs 2.2.x (stated loudly in CHANGELOG/README at release): an
 * explicit `/model` pick (source "user") now beats an active all-tasks owner
 * override; in 2.2.x the override won. The override still beats a skill's
 * request selection and the configured route. Owner pins resolve through
 * routing/owner-pins.js; the most specific applicable pin wins (a task pin beats
 * the all-tasks pin, §4.4). The `pins` block (§4.2) rides on every response from
 * step 2 onward — applied, outranked, blocked, or absent.
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
 *   policyDigest  "sha256:<hex>" of the canonical JSON of the policy in force
 *   costEstimate  { priced, usd, basis, unpricedReason? } — dollars only; only
 *                 computed when the request carries usageEstimate and a pricing
 *                 service is injected; never a $0 stand-in for unknown
 *   engine        { product, version }
 * The response conforms to docs/design/schemas/decision-response.v1.schema.json.
 *
 * The adapter supplies hooks: `decision` (the routing record to fill),
 * `record()` (finalize and write it) and `beforeDispatch()` (host dedupe; false
 * stops before mode dispatch with a passthrough and no record).
 *
 * No environment reads, no default home paths, no host imports.
 */
import { deriveLineage } from "../routing/lineage.js";
import { resolveEffectiveMode, dispatchByMode, configuredTaskLabel } from "../routing/modes.js";
import { resolveOwnerPins } from "../routing/owner-pins.js";
import { EVENTS, OUTCOMES } from "../audit/audit-events.js";
import crypto from "node:crypto";

export const DECISION_API_VERSION = "togglelogic.decision/v1";

// The interceptor's own "no change" marker. The audit outcome is "noop" for any
// decision that leaves the model unchanged — this marker or an empty override
// from mode dispatch (D28; Free 2.1.x reported the latter as "success").
const NO_CHANGE = Object.freeze({});
const emit = (audit, event, value) => { try { audit?.emit?.({ event, ...value }); } catch {} };

export function overrideToDecision(override) {
  const provider = override?.providerOverride || null;
  const model = override?.modelOverride || null;
  if (!provider && !model) return { action: "passthrough" };
  return { action: "route", ref: provider && model ? `${provider}/${model}` : (model || provider),
    ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
}

// Canonical JSON (sorted keys, no whitespace) so the digest names the policy, not
// its key order. Functions/undefined are dropped as JSON.stringify would.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonicalJson(v))).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined && typeof value[k] !== "function")
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function policyDigestOf(policy) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(policy ?? {})).digest("hex")}`;
}

function unpriced(reason) { return { priced: false, usd: null, basis: "none", unpricedReason: reason }; }


export function createDecisionCore({ policy, services = {}, product = "togglelogic-free", version = null } = {}) {
  const { audit = null, seam, availability = null, lineageResolver = null, usageEvents = null,
    fallbackLogger = null, governedEscalation = null, paths = null, familyResolver = null } = services;
  const config = policy;
  const policyDigest = policyDigestOf(policy);
  const pricing = services.pricing ?? null;

  function unresolved(decision, reason) {
    const details = { reason, selectionReason: "fallback_unresolved", selectedModel: decision.selectedModel };
    emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.FAILURE, principal: { source: "plugin" }, details, correlationId: decision.requestId });
    try { void Promise.resolve(usageEvents?.emit("fallback_unresolved", { provider: decision.selectedProvider, reason, requestId: decision.requestId })).catch(() => {}); } catch {}
    try { fallbackLogger?.warn?.("ToggleLogic fallback_unresolved: no fallback resolved; preserving the selection"); } catch {}
  }

  // Dollar estimate for the model that will actually run (the routed ref, else the
  // host's requested/default model). Only with a caller usageEstimate.
  async function estimate(request, decisionOut) {
    const usage = request?.usageEstimate;
    if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return unpriced("no_usage_estimate");
    const tokens = (n) => n === undefined || (Number.isInteger(n) && n >= 0);
    if (!tokens(usage.inputTokens) || !tokens(usage.outputTokens)) return unpriced("invalid_usage_estimate");
    if (!pricing?.resolve || !pricing?.costUsd) return unpriced("no_pricing_service");
    const ref = decisionOut.action === "route" ? decisionOut.ref : (request.requested?.ref || request.defaultRef);
    if (!ref || !ref.includes("/")) return unpriced("no_model_ref");
    let info;
    try { info = await pricing.resolve(ref); } catch { return unpriced("pricing_error"); }
    if (!info?.curated) return unpriced("outside_price_catalog");
    if (!info.priced) return unpriced("no_published_price");
    let usd;
    try { usd = pricing.costUsd(info, { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }); } catch { return unpriced("pricing_error"); }
    return Number.isFinite(usd) && usd >= 0 ? { priced: true, usd, basis: "usage_estimate" } : unpriced("no_published_price");
  }

  async function respond(request, decision, override, pins = null) {
    const decisionOut = overrideToDecision(override);
    return {
      apiVersion: DECISION_API_VERSION,
      correlationId: String(decision?.requestId ?? request?.requestId ?? ""),
      decision: decisionOut,
      reason: decision?.selectionReason ?? "passthrough",
      rationale: { details: decision?.selectionDetails ?? {} },
      policyDigest,
      costEstimate: await estimate(request, decisionOut),
      engine: { product, version: String(version ?? "unknown") },
      ...(pins ? { pins } : {}),
    };
  }

  async function decide(request, { decision, record = () => {}, beforeDispatch = () => true } = {}) {
    const event = request?.host?.event;
    const context = request?.host?.context;

    // 1. Governed escalation pre-check.
    const governedPrior = governedEscalation?.beforeRouting(event?.prompt, context);
    if (governedPrior?.shortCircuit) return respond(request, decision, governedPrior.override || NO_CHANGE);

    // Owner pins (M6 §4.1). Resolved here — after the governed pre-check, before
    // the pin tier (step 3) — so the `pins` block (§4.2) can ride on every
    // response from step 2 onward, including the user-selection return where a
    // pin is reported `outranked_by_user`. Reads the host task label only (not
    // any lazy request field), so it does not perturb the host read order.
    const pinLabel = configuredTaskLabel(event, context);
    // M6 §5.1: a family pin resolves to its newest configured+allowed member via
    // the injected resolver (T4). Synchronous — no catalog fetch on the hot path.
    const resolveFamily = familyResolver
      ? (family) => { const r = familyResolver(family, request.agent); return { resolved_ref: r?.child ?? null, resolution_reason: r?.reason }; }
      : null;
    const pins = resolveOwnerPins(config.ownerOverride, { label: pinLabel, paths, resolveFamily });
    // Malformed scope → fail-closed; surface it loudly exactly once per file
    // version. (The pins block below still reports the scope as `malformed`.)
    if (pins.rejections.length) { try { fallbackLogger?.warn?.(`ToggleLogic owner-pin rejected (fail-closed): ${pins.rejections.map((r) => `${r.scope} ${r.reason}`).join("; ")}`); } catch {} }
    const taskEligible = pins.task?.eligible === true;
    const allEligible = pins.all?.eligible === true;

    // The `pins` block for the response (§4.2). `applied` is "task" | "all" | null
    // (the scope that won the pin tier); `outrankedBy` is "user" when the owner's
    // own pick beat the pin tier. Intrinsic block reasons (expired / inactive /
    // unavailable / malformed) take precedence over an outranking reason.
    const pinScopeBlock = (scope, { applied, outrankedBy }) => {
      if (!scope) return null;
      const base = {
        scope: scope.scope,
        pin_target: scope.pinTarget,
        ...(scope.modelRef !== undefined ? { model_ref: scope.modelRef } : {}),
        ...(scope.family !== undefined ? { family: scope.family } : {}),
        resolved_ref: scope.resolvedRef,
        ...(scope.resolutionReason !== undefined ? { resolution_reason: scope.resolutionReason } : {}),
        ...(scope.setBy !== undefined ? { set_by: scope.setBy } : {}),
        ...(scope.setAtMs !== undefined ? { set_at_ms: scope.setAtMs } : {}),
        expires_at_ms: scope.expiresAtMs,
        ...(scope.noExpiry ? { no_expiry: true } : {}),
      };
      if (applied) return { ...base, status: "applied", reason: "applied" };
      return { ...base, status: "not_applied", reason: scope.blockReason ?? outrankedBy };
    };
    const pinsBlock = (applied, outrankedBy) => ({
      labelSeen: pins.labelSeen,
      task: pinScopeBlock(pins.task, { applied: applied === "task", outrankedBy: outrankedBy === "user" ? "outranked_by_user" : null }),
      all: pinScopeBlock(pins.all, {
        applied: applied === "all",
        outrankedBy: outrankedBy === "user" ? "outranked_by_user" : applied === "task" ? "outranked_by_task_pin" : null,
      }),
    });

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

    // 2. Protected user selection — the owner's own `/model` pick. Wins over
    //    every pin (M6 §4.1, R1); active pins are reported `outranked_by_user`.
    const requested = request.requested;
    if (requested?.source === "user") {
      decision.selectedModel = requested.ref; decision.selectedProvider = requested.provider; decision.selectionReason = "user_selection"; decision.selectionDetails = { matched_rule: "user_selection_precedence", pin_source: requested.pinSource };
      if (availability?.unavailable(requested.provider)) decision.selectionDetails.userSelectionConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.NOOP, principal: { source: "user" }, details: { selectedModel: requested.ref, ...decision.selectionDetails }, correlationId: decision.requestId });
      return respond(request, decision, NO_CHANGE, pinsBlock(null, "user"));
    }

    // 3. Owner pins — the most specific applicable pin wins (task beats all,
    //    §4.4). A task pin keeps 2.2.x's richer details; the all-tasks pin keeps
    //    emitting `owner_override` unchanged (§3.4, Q3) so no existing decision
    //    consumer breaks — scope/target ride in the `pins` block, not the reason.
    const applyPin = (scope, reason, details, mode) => {
      const ref = scope.resolvedRef, slash = ref.indexOf("/");
      const providerOverride = ref.slice(0, slash), modelOverride = ref.slice(slash + 1);
      decision.selectedModel = ref; decision.selectedProvider = providerOverride;
      decision.selectionReason = reason; decision.selectionDetails = { ...details };
      if (availability?.unavailable(providerOverride)) decision.selectionDetails.providerUnavailableConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.SUCCESS, principal: { source: "owner" }, subject: { hook: "before_model_resolve" }, details: { mode, selectedModel: ref, ...decision.selectionDetails }, correlationId: decision.requestId });
      return { modelOverride, providerOverride };
    };
    if (taskEligible) {
      const s = pins.task;
      const details = s.pinTarget === "family"
        ? { matched_rule: "task_pin", scope: s.scope, pin_target: "family", family: s.family, resolved_ref: s.resolvedRef, resolution_reason: s.resolutionReason }
        : { matched_rule: "task_pin", scope: s.scope, pin_target: "model", resolved_ref: s.resolvedRef };
      return respond(request, decision, applyPin(s, "task_pin", details, "task_pin"), pinsBlock("task", null));
    }
    if (allEligible) {
      // The all-tasks pin keeps 2.2.x's `owner_override` reason + minimal details
      // in the record/audit (scope/target are in the `pins` block).
      return respond(request, decision, applyPin(pins.all, "owner_override", { matched_rule: "owner_override" }, "owner_override"), pinsBlock("all", null));
    }

    // 4. Request selection — a skill's requested model. Below the pin tier, so an
    //    applicable pin already won above; a blocked pin shows its block reason.
    if (requested?.source === "request") {
      decision.selectedModel = requested.ref; decision.selectedProvider = requested.provider; decision.selectionReason = "request_selection";
      decision.selectionDetails = { matched_rule: "request_selection_precedence", host_default: request.defaultRef };
      if (availability?.unavailable(requested.provider)) decision.selectionDetails.userSelectionConflict = true;
      record();
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.NOOP, principal: { source: "user" }, subject: { hook: "before_model_resolve" }, details: { mode: "request_selection", selectedModel: requested.ref, ...decision.selectionDetails }, correlationId: decision.requestId });
      return respond(request, decision, NO_CHANGE, pinsBlock(null, null));
    }

    // 5. Early failover if the pending model's provider is unavailable.
    const pending = requested?.ref || request.defaultRef;
    const earlyFallback = await failover(pending);
    if (earlyFallback) { record(); return respond(request, decision, earlyFallback, pinsBlock(null, null)); }

    if (!beforeDispatch()) return respond(request, decision, NO_CHANGE, pinsBlock(null, null));

    // 6. Mode dispatch, then 7. governed escalation post-check.
    let override = NO_CHANGE;
    try {
      const mode = resolveEffectiveMode(config.mode, seam.status(), config);
      decision.mode = mode;
      const result = await dispatchByMode({ mode, event, hookContext: context, config, seam, familyResolver, agent: request.agent });
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
    if (decision.selectionReason !== "fallback_unresolved") emit(audit, EVENTS.ROUTING_DECISION, { outcome: overrideToDecision(override).action === "passthrough" ? OUTCOMES.NOOP : OUTCOMES.SUCCESS, principal: { source: "agent" }, subject: { hook: "before_model_resolve" }, details: { mode: decision.mode, selectedModel: decision.selectedModel, selectionReason: decision.selectionReason }, correlationId: decision.requestId });
    return respond(request, decision, override, pinsBlock(null, null));
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

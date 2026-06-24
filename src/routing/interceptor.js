/*
 * ToggleLogic (Free Tier) — before_model_resolve interceptor.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * Priority: owner-override (top) > effective mode (configured / cheap default /
 * intelligence-if-licensed) > passthrough. Returning {} = passthrough.
 */

import { newDecision, finalizeDecision } from "./decision.js";
import { resolveEffectiveMode, dispatchByMode } from "./modes.js";
import { resolveOwnerOverride } from "./owner-override.js";
import {
  isProtectedUserSessionSelection,
  readSessionSelection,
} from "./session-store.js";
import { EVENTS, OUTCOMES } from "../audit/audit-events.js";

/** Safe audit emit — never raise into the hook caller. */
function _emit(audit, event, partial) {
  if (!audit || typeof audit.emit !== "function") return;
  try {
    audit.emit({ event, ...partial });
  } catch {
    /* never raise */
  }
}

const PASSTHROUGH = Object.freeze({});

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseModelRef(provider, model) {
  const cleanProvider = normalizeOptionalString(provider);
  const cleanModel = normalizeOptionalString(model);
  if (!cleanModel) {
    return { provider: cleanProvider, model: null, ref: cleanProvider };
  }
  const slash = cleanModel.indexOf("/");
  if (!cleanProvider && slash > 0 && slash < cleanModel.length - 1) {
    return {
      provider: cleanModel.slice(0, slash),
      model: cleanModel.slice(slash + 1),
      ref: cleanModel,
    };
  }
  return {
    provider: cleanProvider,
    model: cleanModel,
    ref: cleanProvider ? `${cleanProvider}/${cleanModel}` : cleanModel,
  };
}

function selectedModelFromContext(hookContext, sessionLookup) {
  const source = normalizeOptionalString(sessionLookup?.entry?.modelOverrideSource);
  const selection = parseModelRef(hookContext?.modelProviderId, hookContext?.modelId);
  if (!selection.model && !selection.provider) return null;
  return {
    ...selection,
    source,
    isUserSelected:
      sessionLookup?.status === "found" &&
      isProtectedUserSessionSelection(sessionLookup.entry),
    sessionLookup,
  };
}

function selectedModelFromDispatchResult(result) {
  if (!result || result.override === PASSTHROUGH) return null;
  const provider = result.override?.providerOverride ?? result.selectedProvider;
  const model = result.override?.modelOverride ?? result.selectedModel;
  const selection = parseModelRef(provider, model);
  return selection.model || selection.provider ? selection : null;
}

function normalizeComparableRef(selection) {
  return selection?.ref ? selection.ref.toLowerCase() : null;
}

function sameSelection(left, right) {
  const leftRef = normalizeComparableRef(left);
  const rightRef = normalizeComparableRef(right);
  if (!leftRef || !rightRef) return false;
  return leftRef === rightRef;
}

export function createInterceptor({ config, hostConfig, logger, seam, version, audit }) {
  return async function beforeModelResolve(event, hookContext) {
    const decision = newDecision({ event, hookContext, mode: config.mode, version });

    _emit(audit, EVENTS.ROUTING_HOOK_FIRE, {
      outcome: OUTCOMES.SUCCESS,
      principal: { source: "agent" },
      subject: { hook: "before_model_resolve" },
      details: {
        hasAttachments: Boolean(event?.attachments),
        capabilityNeeds: decision.capabilityNeeds,
        mode: config.mode,
      },
      correlationId: decision.requestId,
    });

    let override = PASSTHROUGH;

    // Owner override sits ABOVE everything else. The owner's explicit model
    // choice — written by deployment-side tooling to the configured state file —
    // flows THROUGH this hook as the top-priority input. GENERIC mechanism: we
    // read a configured file and apply its value (deployment-supplied DATA; see
    // owner-override.js). resolveOwnerOverride is fail-open and never throws.
    const owner = resolveOwnerOverride(config.ownerOverride);
    if (owner.applied) {
      override = {
        modelOverride: owner.modelOverride,
        ...(owner.providerOverride ? { providerOverride: owner.providerOverride } : {}),
      };
      decision.selectedModel = owner.modelRef;
      decision.selectedProvider = owner.providerOverride ?? null;
      decision.selectionReason = "owner_override";
      decision.selectionDetails = {
        matched_rule: "owner_override",
        set_by: owner.state?.set_by ?? null,
        set_at_ms: owner.state?.set_at_ms ?? null,
      };
      finalizeDecision(decision);
      logger.write(decision).catch(() => {});
      _emit(audit, EVENTS.ROUTING_DECISION, {
        outcome: OUTCOMES.SUCCESS,
        principal: { source: "owner" },
        subject: { hook: "before_model_resolve" },
        details: {
          mode: "owner_override",
          matched_rule: "owner_override",
          selectedModel: owner.modelRef,
          selectedProvider: owner.providerOverride ?? null,
          selectionReason: "owner_override",
          durationMs: decision.durationMs,
        },
        correlationId: decision.requestId,
      });
      return override;
    }

    // Protected user/session pin sits ABOVE the classifier. When the owner has
    // pinned a model for this session (modelOverrideSource = "user", not an auto
    // fallback), that selection WINS: we still optionally run the classifier to
    // RECORD when it would have chosen differently (classifier_blocked), but the
    // user's pin is preserved (return passthrough so the gateway keeps it).
    const sessionLookup = readSessionSelection(hostConfig, hookContext);
    const requestedSelection = selectedModelFromContext(hookContext, sessionLookup);
    if (requestedSelection?.isUserSelected) {
      const effectiveMode = resolveEffectiveMode(config.mode, seam.status(), config);
      let classifierResult = null;
      let classifierSelection = null;
      let classifierError = null;

      decision.mode = effectiveMode;
      decision.selectedModel = requestedSelection.ref;
      decision.selectedProvider = requestedSelection.provider ?? null;
      decision.modelOverrideSource = requestedSelection.source ?? null;
      decision.selectionReason = "user_selection";

      if (effectiveMode !== "passthrough") {
        try {
          classifierResult = await dispatchByMode({
            mode: effectiveMode,
            event,
            hookContext,
            config,
            seam,
          });
          classifierSelection = selectedModelFromDispatchResult(classifierResult);
        } catch (err) {
          classifierError = String(err?.message ?? err);
        }
      }

      const classifierBlocked =
        Boolean(classifierSelection) &&
        !sameSelection(requestedSelection, classifierSelection);
      decision.selectionDetails = {
        matched_rule: "user_selection_precedence",
        modelOverrideSource: requestedSelection.source ?? null,
        precedence: "user/session-selected model wins above classifier",
        sessionLookupStatus: sessionLookup.status,
        sessionKey: sessionLookup.sessionKey ?? null,
        sessionModelOverride:
          sessionLookup.entry?.providerOverride && sessionLookup.entry?.modelOverride
            ? `${sessionLookup.entry.providerOverride}/${sessionLookup.entry.modelOverride}`
            : sessionLookup.entry?.modelOverride ?? null,
        classifier_checked: effectiveMode !== "passthrough",
        classifier_blocked: classifierBlocked,
        ...(classifierSelection
          ? {
              classifier_selected_model: classifierSelection.ref,
              classifier_selection_reason: classifierResult?.selectionReason ?? null,
              classifier_matched_rule:
                classifierResult?.selectionDetails?.matched_rule ?? null,
            }
          : {}),
        ...(classifierError ? { classifier_error: classifierError } : {}),
      };

      finalizeDecision(decision);
      logger.write(decision).catch(() => {});
      _emit(audit, EVENTS.ROUTING_DECISION, {
        outcome: classifierBlocked ? OUTCOMES.FAILURE : OUTCOMES.NOOP,
        principal: { source: "user" },
        subject: { hook: "before_model_resolve" },
        details: {
          mode: decision.mode,
          matched_rule: decision.selectionDetails?.matched_rule ?? null,
          selectedModel: decision.selectedModel,
          selectedProvider: decision.selectedProvider,
          selectionReason: decision.selectionReason,
          classifier_blocked: classifierBlocked,
          classifier_selected_model:
            decision.selectionDetails?.classifier_selected_model ?? null,
          classifier_matched_rule:
            decision.selectionDetails?.classifier_matched_rule ?? null,
          durationMs: decision.durationMs,
        },
        correlationId: decision.requestId,
      });
      return PASSTHROUGH;
    }

    try {
      const effectiveMode = resolveEffectiveMode(config.mode, seam.status(), config);
      decision.mode = effectiveMode;

      const result = await dispatchByMode({
        mode: effectiveMode,
        event,
        hookContext,
        config,
        seam,
      });

      override = result.override;
      decision.selectedModel = result.selectedModel;
      decision.selectedProvider = result.selectedProvider;
      decision.selectionReason = result.selectionReason;
      decision.selectionDetails = result.selectionDetails;
    } catch (err) {
      decision.selectionReason = "fallback";
      decision.selectionDetails = {
        error: String(err?.message ?? err),
        fallbackOnError: config.intelligence.fallbackOnError,
      };
      override = PASSTHROUGH;

      if (!config.intelligence.fallbackOnError) {
        finalizeDecision(decision);
        logger.write(decision).catch(() => {});
        _emit(audit, EVENTS.ROUTING_DECISION, {
          outcome: OUTCOMES.FAILURE,
          principal: { source: "agent" },
          subject: { hook: "before_model_resolve" },
          details: {
            mode: decision.mode,
            matched_rule: null,
            selectedModel: null,
            selectedProvider: null,
            selectionReason: decision.selectionReason,
            error: decision.selectionDetails?.error,
            durationMs: decision.durationMs,
          },
          correlationId: decision.requestId,
        });
        throw err;
      }
    }

    finalizeDecision(decision);
    logger.write(decision).catch(() => {});

    _emit(audit, EVENTS.ROUTING_DECISION, {
      outcome: override === PASSTHROUGH ? OUTCOMES.NOOP : OUTCOMES.SUCCESS,
      principal: { source: "agent" },
      subject: { hook: "before_model_resolve" },
      details: {
        mode: decision.mode,
        matched_rule: decision.selectionDetails?.matched_rule ?? null,
        selectedModel: decision.selectedModel,
        selectedProvider: decision.selectedProvider,
        selectionReason: decision.selectionReason,
        durationMs: decision.durationMs,
      },
      correlationId: decision.requestId,
    });

    return override;
  };
}

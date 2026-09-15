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
import crypto from "node:crypto";

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

export function createInterceptor({ config, hostConfig, logger, seam, version, audit, familyResolver, configuredProviders = [], governedEscalation = null, skillRouting = null }) {
  // OpenClaw re-enters before_model_resolve for each candidate in its fallback
  // chain. Classify the logical turn once; subsequent passes must preserve the
  // host's candidate instead of routing every fallback back to the failed model.
  const recentTurns = new Map();
  const preflightResults = new Map();
  const FALLBACK_WINDOW_MS = 60_000;

  function turnFingerprint(event, hookContext) {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const sessionKey = normalizeOptionalString(hookContext?.sessionKey);
    return prompt && sessionKey
      ? crypto.createHash("sha256").update(`${sessionKey}\0${prompt}`).digest("hex")
      : null;
  }

  async function resolveBeforeModel(event, hookContext) {
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

    const governedPrior = governedEscalation?.beforeRouting(event?.prompt, hookContext);
    if (governedPrior?.shortCircuit) {
      return governedPrior.override || PASSTHROUGH;
    }

    // Owner override sits ABOVE everything else. The owner's explicit model
    // choice — written by deployment-side tooling to the configured state file —
    // flows THROUGH this hook as the top-priority input. GENERIC mechanism: we
    // read a configured file and apply its value (deployment-supplied DATA; see
    // owner-override.js). resolveOwnerOverride is fail-open and never throws.
    const owner = resolveOwnerOverride(config.ownerOverride);
    if (owner.rejected) {
      // 1.0.5: malformed owner-override TTL → FAIL-CLOSED rejection. Emit a LOUD,
      // structured audit event (the plugin's reliable sink; plugin console output
      // is not captured by the host). owner-override.js returns this once per
      // malformed file version, so this fires once — not per request.
      _emit(audit, EVENTS.ROUTING_DECISION, {
        outcome: OUTCOMES.FAILURE,
        principal: { source: "owner" },
        subject: { hook: "before_model_resolve" },
        details: {
          mode: "owner_override_rejected",
          rejected: owner.rejected,
          expires_at_ms_raw: owner.expiresRaw,
          note: "owner override REJECTED (fail-closed): expires_at_ms is present but not a finite number; routing via classifier.",
        },
      });
    }
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

    // A numbered reply to an educational skill preflight is a fresh, explicit
    // owner choice. Persist the learned profile and route this continuation to
    // the concrete child resolved for the selected lineage/strategy. The global
    // owner override remains above it; host fallback protection remains below.
    if (skillRouting) {
      let taught = null;
      try {
        taught = await skillRouting.consumeChoice(event?.prompt, hookContext);
      } catch (error) {
        _emit(audit, EVENTS.ROUTING_DECISION, {
          outcome: OUTCOMES.FAILURE,
          principal: { source: "owner" },
          subject: { hook: "before_model_resolve" },
          details: {
            mode: "skill_profile_write_failed",
            error: String(error?.message ?? error).slice(0, 512),
            fallbackOnError: config.intelligence.fallbackOnError,
          },
          correlationId: decision.requestId,
        });
        if (!config.intelligence.fallbackOnError) throw error;
      }
      if (taught) {
        decision.mode = "skill_routing";
        decision.selectedModel = taught.modelRef;
        decision.selectedProvider = taught.override.providerOverride ?? null;
        decision.selectionReason = "owner_taught_skill_profile";
        decision.selectionDetails = taught.details;
        finalizeDecision(decision);
        logger.write(decision).catch(() => {});
        _emit(audit, EVENTS.ROUTING_DECISION, {
          outcome: OUTCOMES.SUCCESS,
          principal: { source: "owner" },
          subject: { hook: "before_model_resolve" },
          details: {
            mode: decision.mode,
            matched_rule: taught.details?.matched_rule ?? null,
            planned_skills: taught.details?.planned_skills ?? [],
            model_lineage: taught.details?.model_lineage ?? null,
            resolved_child: taught.details?.resolved_child ?? taught.modelRef,
            selectedModel: taught.modelRef,
            selectionReason: decision.selectionReason,
          },
          correlationId: decision.requestId,
        });
        return taught.override;
      }
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
            familyResolver,
            configuredProviders,
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

    const fingerprint = turnFingerprint(event, hookContext);
    if (fingerprint) {
      const now = Date.now();
      for (const [key, at] of recentTurns) {
        if (now - at > FALLBACK_WINDOW_MS) recentTurns.delete(key);
      }
      if (recentTurns.has(fingerprint)) {
        decision.mode = "host_fallback";
        decision.selectionReason = "host_fallback_passthrough";
        decision.selectionDetails = {
          matched_rule: "repeated_turn_fallback_guard",
          reason: "same logical turn re-entered model resolution; preserving the host fallback candidate",
        };
        finalizeDecision(decision);
        logger.write(decision).catch(() => {});
        _emit(audit, EVENTS.ROUTING_DECISION, {
          outcome: OUTCOMES.NOOP,
          principal: { source: "agent" },
          subject: { hook: "before_model_resolve" },
          details: {
            mode: decision.mode,
            matched_rule: decision.selectionDetails.matched_rule,
            selectionReason: decision.selectionReason,
            durationMs: decision.durationMs,
          },
          correlationId: decision.requestId,
        });
        return PASSTHROUGH;
      }
      recentTurns.set(fingerprint, now);
    }

    try {
      const effectiveMode = resolveEffectiveMode(config.mode, seam.status(), config);
      decision.mode = effectiveMode;

      const plannedSkills = skillRouting?.structuredPlannedSkills(event, hookContext) || [];
      const routedEvent = plannedSkills.length > 0 ? {
        ...event,
        plannedSkills,
        estimatedTokens: Number.isFinite(event?.estimatedTokens)
          ? event.estimatedTokens : config.skillRouting.defaultEstimatedTokens,
        monthlyCloudSpendUsd: Number.isFinite(event?.monthlyCloudSpendUsd)
          ? event.monthlyCloudSpendUsd : config.skillRouting.monthlyCloudSpendUsd,
      } : event;
      const result = await dispatchByMode({
        mode: effectiveMode,
        event: routedEvent,
        hookContext,
        config,
        seam,
        familyResolver,
        configuredProviders,
      });

      override = result.override;
      decision.selectedModel = result.selectedModel;
      decision.selectedProvider = result.selectedProvider;
      decision.selectionReason = result.selectionReason;
      decision.selectionDetails = result.selectionDetails;
      const governed = governedEscalation
        ? await governedEscalation.afterRouting(event?.prompt, hookContext, result)
        : null;
      if (governed) {
        if (governed.override) {
          override = governed.override;
          if (governed.action === "approval_required") {
            // No model executes on this turn. Keep the proposed cloud model in
            // selectionDetails, not in the executed-selection fields.
            decision.selectedModel = null;
            decision.selectedProvider = null;
          } else {
            decision.selectedModel = governed.modelRef ||
              (override.providerOverride && override.modelOverride
                ? `${override.providerOverride}/${override.modelOverride}`
                : override.modelOverride) || decision.selectedModel;
            decision.selectedProvider = override.providerOverride || null;
          }
        }
        decision.selectionReason = governed.action;
        decision.selectionDetails = {
          ...(decision.selectionDetails || {}),
          governed_action: governed.action,
          proposed_model: governed.item?.modelRef || null,
          estimated_cost_usd: governed.item?.estimatedCostUsd ?? null,
          pricing_source: governed.item?.priceSource || null,
        };
      }
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
      outcome:
        decision.mode === "intelligence_unavailable"
          ? OUTCOMES.FAILURE
          : override === PASSTHROUGH
            ? OUTCOMES.NOOP
            : OUTCOMES.SUCCESS,
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
  }

  async function beforeModelResolve(event, hookContext) {
    const fingerprint = turnFingerprint(event, hookContext);
    const cached = fingerprint ? preflightResults.get(fingerprint) : null;
    if (cached && Date.now() - cached.createdAt <= FALLBACK_WINDOW_MS) {
      preflightResults.delete(fingerprint);
      return cached.override;
    }
    if (fingerprint) preflightResults.delete(fingerprint);
    return resolveBeforeModel(event, hookContext);
  }

  beforeModelResolve.preflight = async (event, hookContext) => {
    const fingerprint = turnFingerprint(event, hookContext);
    if (skillRouting) {
      const plannedSkills = skillRouting.structuredPlannedSkills(event, hookContext);
      if (plannedSkills.length > 0) {
        try {
          const skillPlan = await skillRouting.plan({
            prompt: event?.prompt,
            plannedSkills,
            estimatedTokens: event?.estimatedTokens,
            monthlyCloudSpendUsd: event?.monthlyCloudSpendUsd,
          }, hookContext);
          if (skillPlan?.status === "education_required" && skillPlan.teaching_authorized === true && !skillRouting.isShadow) {
            if (fingerprint) recentTurns.delete(fingerprint);
            return {
              handled: true,
              reply: { text: skillRouting.formatSkillPlan(skillPlan) },
              reason: "togglelogic_skill_education_required",
            };
          }
          if (!skillRouting.isShadow && ["profile_conflict", "requirements_conflict"].includes(skillPlan?.status)) {
            if (fingerprint) recentTurns.delete(fingerprint);
            return {
              handled: true,
              reply: { text: skillRouting.formatSkillPlan(skillPlan) },
              reason: "togglelogic_skill_requirements_conflict",
            };
          }
        } catch (error) {
          _emit(audit, EVENTS.ROUTING_DECISION, {
            outcome: OUTCOMES.FAILURE,
            principal: { source: "agent" },
            subject: { hook: "before_agent_reply" },
            details: {
              mode: "skill_routing_preflight_unavailable",
              error: String(error?.message ?? error).slice(0, 512),
            },
          });
        }
      }
    }
    const override = await resolveBeforeModel(event, hookContext);
    const invitation = governedEscalation?.pendingInvitation(hookContext);
    if (invitation) {
      if (fingerprint) recentTurns.delete(fingerprint);
      return { handled: true, reply: { text: invitation }, reason: "togglelogic_owner_approval_required" };
    }
    if (fingerprint) {
      const now = Date.now();
      for (const [key, value] of preflightResults) {
        if (now - value.createdAt > FALLBACK_WINDOW_MS) preflightResults.delete(key);
      }
      preflightResults.set(fingerprint, { override, createdAt: now });
    }
    return { handled: false };
  };

  return beforeModelResolve;
}

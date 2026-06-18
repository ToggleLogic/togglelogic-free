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

export function createInterceptor({ config, logger, seam, version, audit }) {
  return async function beforeModelResolve(event, hookContext) {
    const decision = newDecision({ event, mode: config.mode, version });

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

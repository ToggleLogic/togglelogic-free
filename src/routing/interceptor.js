import crypto from "node:crypto";
import { newDecision, finalizeDecision } from "./decision.js";
import { resolveEffectiveMode, dispatchByMode } from "./modes.js";
import { resolveOwnerOverride } from "./owner-override.js";
import { isProtectedUserSessionSelection, readSessionSelection } from "./session-store.js";
import { EVENTS, OUTCOMES } from "../audit/audit-events.js";

const PASSTHROUGH = Object.freeze({});
const clean = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const emit = (audit, event, value) => { try { audit?.emit?.({ event, ...value }); } catch {} };

function selection(provider, model) {
  const p = clean(provider); const m = clean(model);
  if (!m) return p ? { provider: p, model: null, ref: p } : null;
  if (!p && m.includes("/")) return { provider: m.slice(0, m.indexOf("/")), model: m.slice(m.indexOf("/") + 1), ref: m };
  return { provider: p, model: m, ref: p ? `${p}/${m}` : m };
}

export function createInterceptor({ config, hostConfig, logger, seam, version, audit, governedEscalation = null }) {
  const recent = new Map();
  const preflight = new Map();
  const windowMs = 60_000;
  const fingerprint = (event, context) => clean(event?.prompt) && clean(context?.sessionKey)
    ? crypto.createHash("sha256").update(`${context.sessionKey}\0${event.prompt}`).digest("hex") : null;

  const beforeModelResolve = async function beforeModelResolve(event = {}, context = {}) {
    const preflightKey = fingerprint(event, context);
    const cached = preflightKey ? preflight.get(preflightKey) : null;
    if (cached && Date.now() - cached.at <= windowMs) {
      preflight.delete(preflightKey);
      return cached.override;
    }
    if (preflightKey) preflight.delete(preflightKey);
    const decision = newDecision({ event, hookContext: context, mode: config.mode, version });
    emit(audit, EVENTS.ROUTING_HOOK_FIRE, { outcome: OUTCOMES.SUCCESS, principal: { source: "agent" }, subject: { hook: "before_model_resolve" }, details: { mode: config.mode }, correlationId: decision.requestId });

    const governedPrior = governedEscalation?.beforeRouting(event?.prompt, context);
    if (governedPrior?.shortCircuit) return governedPrior.override || PASSTHROUGH;

    const owner = resolveOwnerOverride(config.ownerOverride);
    if (owner.applied) {
      const override = { modelOverride: owner.modelOverride, ...(owner.providerOverride ? { providerOverride: owner.providerOverride } : {}) };
      decision.selectedModel = owner.modelRef; decision.selectedProvider = owner.providerOverride || null; decision.selectionReason = "owner_override"; decision.selectionDetails = { matched_rule: "owner_override" };
      finalizeDecision(decision); logger.write(decision).catch(() => {});
      emit(audit, EVENTS.ROUTING_DECISION, { outcome: OUTCOMES.SUCCESS, principal: { source: "owner" }, subject: { hook: "before_model_resolve" }, details: { mode: "owner_override", selectedModel: owner.modelRef }, correlationId: decision.requestId });
      return override;
    }

    const sessionLookup = readSessionSelection(hostConfig, context);
    const current = selection(context?.modelProviderId, context?.modelId);
    if (current && sessionLookup?.status === "found" && isProtectedUserSessionSelection(sessionLookup.entry)) {
      decision.selectedModel = current.ref; decision.selectedProvider = current.provider; decision.selectionReason = "user_selection"; decision.selectionDetails = { matched_rule: "user_selection_precedence" };
      finalizeDecision(decision); logger.write(decision).catch(() => {}); return PASSTHROUGH;
    }

    const key = fingerprint(event, context);
    const now = Date.now();
    for (const [item, at] of recent) if (now - at > windowMs) recent.delete(item);
    if (key && recent.has(key)) return PASSTHROUGH;
    if (key) recent.set(key, now);

    let override = PASSTHROUGH;
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
    finalizeDecision(decision); logger.write(decision).catch(() => {});
    emit(audit, EVENTS.ROUTING_DECISION, { outcome: override === PASSTHROUGH ? OUTCOMES.NOOP : OUTCOMES.SUCCESS, principal: { source: "agent" }, subject: { hook: "before_model_resolve" }, details: { mode: decision.mode, selectedModel: decision.selectedModel, selectionReason: decision.selectionReason }, correlationId: decision.requestId });
    return override;
  };

  beforeModelResolve.preflight = async (event = {}, context = {}) => {
    const key = fingerprint(event, context);
    const override = await beforeModelResolve(event, context);
    const invitation = governedEscalation?.pendingInvitation(context);
    if (invitation) {
      if (key) recent.delete(key);
      return { handled: true, reply: { text: invitation }, reason: "togglelogic_owner_approval_required" };
    }
    if (key) preflight.set(key, { override, at: Date.now() });
    return { handled: false };
  };

  return beforeModelResolve;
}

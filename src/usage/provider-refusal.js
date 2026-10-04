/*
 * ToggleLogic (Free Tier) — provider billing refusal detection and cooldowns.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */

// Bound both work and accepted evidence; never stringify arbitrary error objects.
export function classifyProviderRefusal(error) {
  const text = typeof error === "string" ? error.slice(0, 16384).toLowerCase() : "";
  if (!/\b402\b|\bpayment[ _-]required\b/.test(text)) return null;
  if (/\bbilling[ _-]disabled\b|\baccount suspended for billing\b/.test(text)) return "billing_disabled";
  if (/\bcredits? depleted\b|\binsufficient_quota\b|\bcredit balance (?:is )?too low\b|\binsufficient credits?\b/.test(text)) return "credits_depleted";
  if (/\bprepay(?:ment|paid)?\b|\bprepayment\b/.test(text)) return "payment_required";
  return null;
}

export function createProviderAvailability({ cooldownMinutes = 30, emit = () => {}, now = () => Date.now() } = {}) {
  const states = new Map();
  const unavailable = (provider) => (states.get(provider)?.cooldownUntil ?? 0) > now();
  function observe(event) {
    const provider = event?.provider;
    if (typeof provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) return;
    const assistant = event.lastAssistant;
    // Validate attribution: snapshots may contain a prior assistant on preflight failure.
    if (!assistant || assistant.role !== "assistant" || assistant.provider !== provider || assistant.model !== event.model) return;
    const reason = assistant.stopReason === "error" ? classifyProviderRefusal(assistant.errorMessage) : null;
    if (reason) {
      if (unavailable(provider)) return;
      const since = now(), cooldownUntil = since + cooldownMinutes * 60000;
      states.set(provider, { since, cooldownUntil, reason });
      emit("provider_unavailable", { provider, reason, since, cooldownUntil });
    } else if (["stop", "toolUse"].includes(assistant.stopReason) && states.has(provider) && !unavailable(provider)) {
      states.delete(provider);
      emit("provider_available", { provider });
    }
  }
  return { observe, unavailable, state: (provider) => states.get(provider) ?? null };
}

export function hostFallbacks(hostConfig, agentId) {
  const entry = hostConfig?.agents?.list?.find((a) => a.id === agentId);
  const models = entry?.model?.fallbacks ?? hostConfig?.agents?.defaults?.model?.fallbacks ?? [];
  return Array.isArray(models) ? models.filter((ref) => typeof ref === "string" && /^[^/\s]+\/[^\s]+$/.test(ref)) : [];
}

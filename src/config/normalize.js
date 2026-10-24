/*
 * ToggleLogic (Free Tier) — plugin configuration normalization.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE); all rights reserved.
 * PATENT PENDING.
 */
import { validLineage } from "../routing/lineage-resolver.js";
import { normalizeLabel } from "../routing/modes.js";
import { EVENTS } from "../audit/audit-events.js";
const MODES = new Set(["auto", "passthrough", "configured", "cheap", "intelligence"]);

/**
 * Normalize configuredRoutes keys with the canonical label rule (M6 §3.5:
 * lowercase + trim) so stored keys match the normalized incoming task label.
 * Keeps entries whose value is a non-empty string. On a key collision (two raw
 * keys normalizing to the same scope) the LAST wins and the collision is
 * recorded so the engine can warn loudly (not silently) at registration.
 * @returns {{ routes: Record<string,string>, collisions: Array<{normalized:string, keys:string[]}> }}
 */
export function normalizeConfiguredRoutes(raw) {
  const seen = new Map(); // normalizedKey -> { rawKeys: string[], value: string }
  for (const [rawKey, value] of Object.entries(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    const key = normalizeLabel(rawKey);
    if (!key) continue;
    const prior = seen.get(key);
    if (prior) { prior.rawKeys.push(rawKey); prior.value = value; } // keep last
    else seen.set(key, { rawKeys: [rawKey], value });
  }
  const routes = {};
  const collisions = [];
  for (const [key, entry] of seen) {
    routes[key] = entry.value;
    if (entry.rawKeys.length > 1) collisions.push({ normalized: key, keys: entry.rawKeys });
  }
  return { routes, collisions };
}

/**
 * Emit the loud configuredRoutes key-collision warning (M6 §3.5): a
 * FALLBACK_PLAN_CHECK-style config.load audit event plus an operator-facing
 * logger warning. No-op when there are no collisions. Returns whether it warned.
 */
export function warnConfiguredRouteCollisions(collisions, { audit = null, logger = null } = {}) {
  if (!collisions || collisions.length === 0) return false;
  try { audit?.emit?.({ event: EVENTS.CONFIG_LOAD, outcome: "failure", principal: { source: "plugin" },
    details: { check: "configured_routes_collision", status: "warning", collisions } }); } catch {}
  try { logger?.warn?.(`ToggleLogic CONFIG_LOAD: configuredRoutes keys collide after normalization (lowercase+trim); keeping the last of each: ${collisions.map((c) => `${c.normalized} <- [${c.keys.join(", ")}]`).join("; ")}`); } catch {}
  return true;
}

export const DEFAULTS = Object.freeze({
  mode: "auto",
  logging: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-routing.log", rotateSizeMb: 50 }),
  routing: Object.freeze({ fallbackLineages: Object.freeze([]) }),
  configuredRoutes: Object.freeze({}),
  cheapHeuristic: Object.freeze({ default: "", order: Object.freeze([]) }),
  intelligence: Object.freeze({ enabled: true, path: "~/togglelogic-intelligence", registryPath: "", shadow: false, fallbackOnError: true, allowReleaseCandidate: false }),
  ownerOverride: Object.freeze({ enabled: false, statePath: "~/.openclaw/togglelogic/owner_model_override.json", askConsumer: "~/.openclaw/togglelogic/owner_override_ask.py", askInterpreter: "python3" }),
  audit: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-audit.jsonl", rotateSizeMb: 50 }),
  costVisibility: Object.freeze({
    attribution: Object.freeze({ deploymentId: "", costCenter: "", billable: true, invoiceEstimates: false }),
    log: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-cost.jsonl", rotateSizeMb: 50 }),
    pricing: Object.freeze({ sourceUrl: "https://models.dev/api.json", cachePath: "~/.openclaw/togglelogic/pricing-cache.json", refreshHours: 24, timeoutMs: 15000, userPriceOverridePath: "", cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1 }),
    events: Object.freeze({ path: "~/.openclaw/logs/togglelogic-events.jsonl", rotateSizeMb: 50 }),
    localProviders: Object.freeze(["ollama", "lmstudio", "llamacpp", "vllm-local"]),
    budgets: Object.freeze({ monthlyUsd: null, thresholdsPct: Object.freeze([50, 80, 100]) }),
    balances: Object.freeze({ path: "~/.openclaw/togglelogic/balances.jsonl", lowBalanceUsd: 10, lowBalancePct: 20 }),
    providerCooldownMinutes: 30,
    summaryEveryCalls: 20,
  }),
  governedEscalation: Object.freeze({
    localModel: "", localTiers: Object.freeze(["general_purpose"]), approvalTiers: Object.freeze(["flagship_reasoning"]), ttlMinutes: 30, receiptMode: "escalations-only",
    statePath: "~/.openclaw/togglelogic/governed-escalation.json", externalDataNotice: "this request and active conversation context will be sent to the selected external provider",
    approvalLanguage: Object.freeze({ affirmative: Object.freeze(["yes"]), negative: Object.freeze(["no"]) }),
    displayNames: Object.freeze({ providers: Object.freeze({}), models: Object.freeze({}) }),
  }),
  features: Object.freeze({
    routing: Object.freeze({ enabled: false }),
    ownerOverrideAsk: Object.freeze({ enabled: false }),
    costVisibility: Object.freeze({ enabled: false }),
    governedEscalation: Object.freeze({ enabled: false }),
  }),
});

const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const str = (value, fallback = "") => typeof value === "string" ? value : fallback;
const num = (value, fallback, min = 0) => Number.isFinite(value) && value >= min ? value : fallback;
const feature = (value) => ({ enabled: obj(value).enabled === true });

export function normalizeConfig(raw) {
  const r = obj(raw);
  const suppliedLineages = obj(r.routing).fallbackLineages;
  const fallbackLineages = Array.isArray(suppliedLineages) ? suppliedLineages.filter(validLineage) : [];
  const invalidFallbackLineages = suppliedLineages === undefined ? [] : Array.isArray(suppliedLineages)
    ? suppliedLineages.filter((value) => !validLineage(value)) : [suppliedLineages];
  const features = obj(r.features);
  const intelligence = obj(r.intelligence);
  const ownerOverride = obj(r.ownerOverride);
  const audit = obj(r.audit);
  const logging = obj(r.logging);
  const cost = obj(r.costVisibility);
  const costLog = obj(cost.log);
  const events = obj(cost.events);
  const pricing = obj(cost.pricing);
  const attribution = obj(cost.attribution);
  const budgets = obj(cost.budgets);
  const balances = obj(cost.balances);
  const escalation = obj(r.governedEscalation);
  const language = obj(escalation.approvalLanguage);
  const names = obj(escalation.displayNames);
  const slug = (value) => { const lowered = String(value || "").trim().toLowerCase(); return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(lowered) ? lowered : ""; };
  const phrases = (value, fallback) => [...new Set((Array.isArray(value) ? value : fallback).map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  const labels = (value) => Object.fromEntries(Object.entries(obj(value)).map(([key, item]) => [key, typeof item === "string" ? item.trim() : ""]).filter(([, item]) => item));
  const { routes: configuredRoutes, collisions: configuredRoutesCollisions } = normalizeConfiguredRoutes(r.configuredRoutes);
  return {
    mode: MODES.has(r.mode) ? r.mode : DEFAULTS.mode,
    logging: { enabled: logging.enabled !== false, path: str(logging.path, DEFAULTS.logging.path), rotateSizeMb: num(logging.rotateSizeMb, 50, 1) },
    routing: { fallbackLineages, invalidFallbackLineages },
    configuredRoutes,
    configuredRoutesCollisions,
    cheapHeuristic: { default: str(obj(r.cheapHeuristic).default), order: Array.isArray(obj(r.cheapHeuristic).order) ? obj(r.cheapHeuristic).order.filter((value) => typeof value === "string" && value) : [] },
    intelligence: { enabled: intelligence.enabled !== false, path: str(intelligence.path, DEFAULTS.intelligence.path), registryPath: str(intelligence.registryPath), shadow: intelligence.shadow === true, fallbackOnError: intelligence.fallbackOnError !== false, allowReleaseCandidate: intelligence.allowReleaseCandidate === true },
    ownerOverride: { enabled: ownerOverride.enabled === true, statePath: str(ownerOverride.statePath, DEFAULTS.ownerOverride.statePath), askConsumer: str(ownerOverride.askConsumer, DEFAULTS.ownerOverride.askConsumer), askInterpreter: str(ownerOverride.askInterpreter, "").trim() || DEFAULTS.ownerOverride.askInterpreter },
    audit: { enabled: audit.enabled !== false, path: str(audit.path, DEFAULTS.audit.path), rotateSizeMb: num(audit.rotateSizeMb, 50, 1) },
    costVisibility: {
      attribution: { deploymentId: slug(attribution.deploymentId), costCenter: slug(attribution.costCenter), billable: attribution.billable !== false,
        invoiceEstimates: attribution.invoiceEstimates === true },
      log: { enabled: costLog.enabled !== false, path: str(costLog.path, DEFAULTS.costVisibility.log.path), rotateSizeMb: num(costLog.rotateSizeMb, 50, 1) },
      pricing: { sourceUrl: str(pricing.sourceUrl, DEFAULTS.costVisibility.pricing.sourceUrl), cachePath: str(pricing.cachePath, DEFAULTS.costVisibility.pricing.cachePath), refreshHours: num(pricing.refreshHours, 24, 1), timeoutMs: num(pricing.timeoutMs, 15000, 1), userPriceOverridePath: str(pricing.userPriceOverridePath), cacheReadMultiplier: num(pricing.cacheReadMultiplier, 0.25, 0), cacheWriteMultiplier: num(pricing.cacheWriteMultiplier, 1, 0) },
      events: { path: str(events.path, DEFAULTS.costVisibility.events.path), rotateSizeMb: num(events.rotateSizeMb, 50, 1) },
      localProviders: phrases(cost.localProviders, DEFAULTS.costVisibility.localProviders).map((value) => value.toLowerCase()),
      budgets: { monthlyUsd: Number.isFinite(budgets.monthlyUsd) && budgets.monthlyUsd > 0 ? budgets.monthlyUsd : null,
        thresholdsPct: [...new Set((Array.isArray(budgets.thresholdsPct) ? budgets.thresholdsPct : [50, 80, 100])
          .filter((value) => Number.isFinite(value) && value > 0))].sort((a, b) => a - b) },
      balances: { path: str(balances.path, DEFAULTS.costVisibility.balances.path), lowBalanceUsd: num(balances.lowBalanceUsd, 10), lowBalancePct: Math.min(100, num(balances.lowBalancePct, 20)) },
      providerCooldownMinutes: num(cost.providerCooldownMinutes, 30, 1),
      summaryEveryCalls: num(cost.summaryEveryCalls, 20, 1),
    },
    governedEscalation: {
      localModel: str(escalation.localModel), localTiers: Array.isArray(escalation.localTiers) ? escalation.localTiers : [...DEFAULTS.governedEscalation.localTiers],
      approvalTiers: Array.isArray(escalation.approvalTiers) ? escalation.approvalTiers : [...DEFAULTS.governedEscalation.approvalTiers], ttlMinutes: num(escalation.ttlMinutes, 30, 1),
      statePath: str(escalation.statePath, DEFAULTS.governedEscalation.statePath), externalDataNotice: str(escalation.externalDataNotice, DEFAULTS.governedEscalation.externalDataNotice),
      receiptMode: escalation.receiptMode === "always" ? "always" : "escalations-only",
      approvalLanguage: { affirmative: phrases(language.affirmative, ["yes"]), negative: phrases(language.negative, ["no"]) },
      displayNames: { providers: labels(names.providers), models: labels(names.models) },
    },
    features: { routing: feature(features.routing), ownerOverrideAsk: feature(features.ownerOverrideAsk), costVisibility: feature(features.costVisibility), governedEscalation: feature(features.governedEscalation) },
  };
}

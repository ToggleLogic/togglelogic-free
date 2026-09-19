const MODES = new Set(["auto", "passthrough", "configured", "cheap", "intelligence"]);

export const DEFAULTS = Object.freeze({
  mode: "auto",
  logging: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-routing.log", rotateSizeMb: 50 }),
  configuredRoutes: Object.freeze({}),
  cheapHeuristic: Object.freeze({ default: "", order: Object.freeze([]) }),
  intelligence: Object.freeze({ enabled: true, path: "~/togglelogic-intelligence", registryPath: "", shadow: false, fallbackOnError: true, allowReleaseCandidate: false }),
  ownerOverride: Object.freeze({ enabled: false, statePath: "~/.openclaw/togglelogic/owner_model_override.json", askConsumer: "~/.openclaw/togglelogic/owner_override_ask.py" }),
  audit: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-audit.jsonl", rotateSizeMb: 50 }),
  costVisibility: Object.freeze({
    attribution: Object.freeze({ deploymentId: "", costCenter: "" }),
    log: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-cost.jsonl", rotateSizeMb: 50 }),
    pricing: Object.freeze({ sourceUrl: "https://models.dev/api.json", cachePath: "~/.openclaw/togglelogic/pricing-cache.json", refreshHours: 24, timeoutMs: 15000, userPriceOverridePath: "", cacheReadMultiplier: 0.25, cacheWriteMultiplier: 1 }),
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
  const features = obj(r.features);
  const intelligence = obj(r.intelligence);
  const ownerOverride = obj(r.ownerOverride);
  const audit = obj(r.audit);
  const logging = obj(r.logging);
  const cost = obj(r.costVisibility);
  const costLog = obj(cost.log);
  const pricing = obj(cost.pricing);
  const attribution = obj(cost.attribution);
  const escalation = obj(r.governedEscalation);
  const language = obj(escalation.approvalLanguage);
  const names = obj(escalation.displayNames);
  const slug = (value) => { const lowered = String(value || "").trim().toLowerCase(); return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(lowered) ? lowered : ""; };
  const phrases = (value, fallback) => [...new Set((Array.isArray(value) ? value : fallback).map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  const labels = (value) => Object.fromEntries(Object.entries(obj(value)).map(([key, item]) => [key, typeof item === "string" ? item.trim() : ""]).filter(([, item]) => item));
  return {
    mode: MODES.has(r.mode) ? r.mode : DEFAULTS.mode,
    logging: { enabled: logging.enabled !== false, path: str(logging.path, DEFAULTS.logging.path), rotateSizeMb: num(logging.rotateSizeMb, 50, 1) },
    configuredRoutes: Object.fromEntries(Object.entries(obj(r.configuredRoutes)).filter(([, value]) => typeof value === "string" && value.trim())),
    cheapHeuristic: { default: str(obj(r.cheapHeuristic).default), order: Array.isArray(obj(r.cheapHeuristic).order) ? obj(r.cheapHeuristic).order.filter((value) => typeof value === "string" && value) : [] },
    intelligence: { enabled: intelligence.enabled !== false, path: str(intelligence.path, DEFAULTS.intelligence.path), registryPath: str(intelligence.registryPath), shadow: intelligence.shadow === true, fallbackOnError: intelligence.fallbackOnError !== false, allowReleaseCandidate: intelligence.allowReleaseCandidate === true },
    ownerOverride: { enabled: ownerOverride.enabled === true, statePath: str(ownerOverride.statePath, DEFAULTS.ownerOverride.statePath), askConsumer: str(ownerOverride.askConsumer, DEFAULTS.ownerOverride.askConsumer) },
    audit: { enabled: audit.enabled !== false, path: str(audit.path, DEFAULTS.audit.path), rotateSizeMb: num(audit.rotateSizeMb, 50, 1) },
    costVisibility: {
      attribution: { deploymentId: slug(attribution.deploymentId), costCenter: slug(attribution.costCenter) },
      log: { enabled: costLog.enabled !== false, path: str(costLog.path, DEFAULTS.costVisibility.log.path), rotateSizeMb: num(costLog.rotateSizeMb, 50, 1) },
      pricing: { sourceUrl: str(pricing.sourceUrl, DEFAULTS.costVisibility.pricing.sourceUrl), cachePath: str(pricing.cachePath, DEFAULTS.costVisibility.pricing.cachePath), refreshHours: num(pricing.refreshHours, 24, 1), timeoutMs: num(pricing.timeoutMs, 15000, 1), userPriceOverridePath: str(pricing.userPriceOverridePath), cacheReadMultiplier: num(pricing.cacheReadMultiplier, 0.25, 0), cacheWriteMultiplier: num(pricing.cacheWriteMultiplier, 1, 0) },
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

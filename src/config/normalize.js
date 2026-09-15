/*
 * ToggleLogic (Free Tier) — config normalization.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License 2.0 (see LICENSE). PATENT PENDING.
 *
 * Runtime config resolver: fills defaults, coerces defensively, returns a
 * trusted shape. On anything malformed it falls back to a safe default rather
 * than throw — a misconfigured plugin should still load in passthrough mode,
 * not crash the gateway. The manifest configSchema is the primary validator.
 *
 * Free-tier config surface: mode, logging, configuredRoutes, cheapHeuristic,
 * intelligence (detection of an optional licensed layer), ownerOverride
 * (user-override mechanism), audit, features (routing + ownerOverrideAsk).
 */

const VALID_MODES = ["auto", "passthrough", "configured", "cheap", "intelligence"];

export const DEFAULTS = Object.freeze({
  mode: "auto",
  logging: Object.freeze({
    enabled: true,
    path: "~/.openclaw/logs/togglelogic-routing.log",
    rotateSizeMb: 50,
  }),
  configuredRoutes: Object.freeze({}),
  // Simple cheapest-default heuristic (free tier): a deployment-declared static
  // default. No registry, no benchmark, no request classification.
  cheapHeuristic: Object.freeze({ default: "", order: [] }),
  familyResolution: Object.freeze({
    enabled: false,
    catalogPath: "~/.openclaw/togglelogic/pricing-cache.json",
    maxAgeHours: 48,
    aliases: Object.freeze({}),
    hostPlan: Object.freeze({ primary: "", fallbacks: Object.freeze([]) }),
  }),
  intelligence: Object.freeze({
    enabled: true,
    path: "~/togglelogic-intelligence",
    registryPath: "",
    skillProfilesPath: "",
    shadow: false,
    fallbackOnError: true,
    allowReleaseCandidate: false,
  }),
  features: Object.freeze({
    routing: Object.freeze({ enabled: false }),
    ownerOverrideAsk: Object.freeze({ enabled: false }),
    costVisibility: Object.freeze({ enabled: false }),
    governedEscalation: Object.freeze({ enabled: false }),
    skillRouting: Object.freeze({ enabled: false }),
  }),
  audit: Object.freeze({
    enabled: true,
    path: "~/.openclaw/logs/togglelogic-audit.jsonl",
    rotateSizeMb: 50,
  }),
  // Owner override (user-override mechanism): a top-priority operator model
  // choice applied ABOVE everything else. GENERIC only — the plugin reads the
  // configured state file; deployment-side tooling writes its contents. Opt-in.
  ownerOverride: Object.freeze({
    enabled: false,
    statePath: "~/.openclaw/togglelogic/owner_model_override.json",
    askConsumer: "~/.openclaw/togglelogic/owner_override_ask.py",
  }),
  // Cost visibility (observe-only): per-model / per-day DOLLAR cost from dynamic
  // public pricing (Models.dev primary, bundled LiteLLM fallback). Curated to the
  // free-tier providers; unpriced-loud, never $0.00. Reports only — never enforces.
  costVisibility: Object.freeze({
    attribution: Object.freeze({
      deploymentId: "",
      costCenter: "",
    }),
    log: Object.freeze({ enabled: true, path: "~/.openclaw/logs/togglelogic-cost.jsonl", rotateSizeMb: 50 }),
    pricing: Object.freeze({
      sourceUrl: "https://models.dev/api.json",
      cachePath: "~/.openclaw/togglelogic/pricing-cache.json",
      refreshHours: 24,
      timeoutMs: 15000,
      userPriceOverridePath: "",
    }),
    summaryEveryCalls: 20,
  }),
  governedEscalation: Object.freeze({
    localModel: "",
    localTiers: Object.freeze(["general_purpose"]),
    approvalTiers: Object.freeze(["flagship_reasoning"]),
    ttlMinutes: 10,
    statePath: "~/.openclaw/togglelogic/governed-escalation.json",
    externalDataNotice: "this request and active conversation context will be sent to the selected external provider",
    approvalLanguage: Object.freeze({
      affirmative: Object.freeze(["yes"]),
      negative: Object.freeze(["no"]),
    }),
    displayNames: Object.freeze({ providers: Object.freeze({}), models: Object.freeze({}) }),
  }),
  skillRouting: Object.freeze({
    pendingStatePath: "~/.openclaw/togglelogic/skill-routing-pending.json",
    pendingTtlMinutes: 15,
    defaultEstimatedTokens: 4000,
    executionTimeoutSeconds: 600,
    monthlyCloudSpendUsd: 0,
  }),
});

export function normalizeConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const logging = r.logging && typeof r.logging === "object" ? r.logging : {};
  const intelligence = r.intelligence && typeof r.intelligence === "object" ? r.intelligence : {};
  const features = r.features && typeof r.features === "object" ? r.features : {};
  const audit = r.audit && typeof r.audit === "object" ? r.audit : {};

  return {
    mode: VALID_MODES.includes(r.mode) ? r.mode : DEFAULTS.mode,
    logging: {
      enabled: logging.enabled !== false,
      path:
        typeof logging.path === "string" && logging.path.length > 0
          ? logging.path
          : DEFAULTS.logging.path,
      rotateSizeMb:
        Number.isFinite(logging.rotateSizeMb) && logging.rotateSizeMb >= 1
          ? Math.floor(logging.rotateSizeMb)
          : DEFAULTS.logging.rotateSizeMb,
    },
    configuredRoutes:
      r.configuredRoutes && typeof r.configuredRoutes === "object"
        ? { ...r.configuredRoutes }
        : {},
    cheapHeuristic: normalizeCheapHeuristic(r.cheapHeuristic),
    familyResolution: normalizeFamilyResolution(r.familyResolution),
    intelligence: {
      enabled: intelligence.enabled !== false,
      path:
        typeof intelligence.path === "string" && intelligence.path.length > 0
          ? intelligence.path
          : DEFAULTS.intelligence.path,
      registryPath:
        typeof intelligence.registryPath === "string" && intelligence.registryPath.length > 0
          ? intelligence.registryPath
          : "",
      skillProfilesPath:
        typeof intelligence.skillProfilesPath === "string" && intelligence.skillProfilesPath.length > 0
          ? intelligence.skillProfilesPath
          : "",
      shadow: intelligence.shadow === true,
      fallbackOnError: intelligence.fallbackOnError !== false,
      allowReleaseCandidate: intelligence.allowReleaseCandidate === true,
    },
    features: {
      routing: normalizeFeatureEntry(features.routing, DEFAULTS.features.routing),
      ownerOverrideAsk: normalizeFeatureEntry(features.ownerOverrideAsk, DEFAULTS.features.ownerOverrideAsk),
      costVisibility: normalizeFeatureEntry(features.costVisibility, DEFAULTS.features.costVisibility),
      governedEscalation: normalizeFeatureEntry(features.governedEscalation, DEFAULTS.features.governedEscalation),
      skillRouting: normalizeFeatureEntry(features.skillRouting, DEFAULTS.features.skillRouting),
    },
    audit: {
      enabled: audit.enabled !== false,
      path:
        typeof audit.path === "string" && audit.path.length > 0
          ? audit.path
          : DEFAULTS.audit.path,
      rotateSizeMb:
        Number.isFinite(audit.rotateSizeMb) && audit.rotateSizeMb >= 1
          ? Math.floor(audit.rotateSizeMb)
          : DEFAULTS.audit.rotateSizeMb,
    },
    ownerOverride: normalizeOwnerOverrideEntry(r.ownerOverride),
    costVisibility: normalizeCostVisibility(r.costVisibility),
    governedEscalation: normalizeGovernedEscalation(r.governedEscalation),
    skillRouting: normalizeSkillRouting(r.skillRouting),
  };
}

function normalizeSkillRouting(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const defaults = DEFAULTS.skillRouting;
  return {
    pendingStatePath: typeof r.pendingStatePath === "string" && r.pendingStatePath.length > 0
      ? r.pendingStatePath : defaults.pendingStatePath,
    pendingTtlMinutes: Number.isFinite(r.pendingTtlMinutes) && r.pendingTtlMinutes >= 1
      ? Math.floor(r.pendingTtlMinutes) : defaults.pendingTtlMinutes,
    defaultEstimatedTokens: Number.isFinite(r.defaultEstimatedTokens) && r.defaultEstimatedTokens >= 1
      ? Math.floor(r.defaultEstimatedTokens) : defaults.defaultEstimatedTokens,
    executionTimeoutSeconds: Number.isFinite(r.executionTimeoutSeconds) && r.executionTimeoutSeconds >= 30 && r.executionTimeoutSeconds <= 3600
      ? Math.floor(r.executionTimeoutSeconds) : defaults.executionTimeoutSeconds,
    monthlyCloudSpendUsd: Number.isFinite(r.monthlyCloudSpendUsd) && r.monthlyCloudSpendUsd >= 0
      ? r.monthlyCloudSpendUsd : defaults.monthlyCloudSpendUsd,
  };
}

function normalizeGovernedEscalation(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const validTier = (value) => ["general_purpose", "tool_calling_strong", "terminal_capable", "flagship_reasoning"].includes(value);
  return {
    localModel: typeof r.localModel === "string" ? r.localModel.trim() : "",
    localTiers: Array.isArray(r.localTiers) ? [...new Set(r.localTiers.filter(validTier))] : [...DEFAULTS.governedEscalation.localTiers],
    approvalTiers: Array.isArray(r.approvalTiers) ? [...new Set(r.approvalTiers.filter(validTier))] : [...DEFAULTS.governedEscalation.approvalTiers],
    ttlMinutes: Number.isFinite(r.ttlMinutes) && r.ttlMinutes >= 1 ? Math.floor(r.ttlMinutes) : DEFAULTS.governedEscalation.ttlMinutes,
    statePath: typeof r.statePath === "string" && r.statePath.length > 0 ? r.statePath : DEFAULTS.governedEscalation.statePath,
    externalDataNotice: typeof r.externalDataNotice === "string" && r.externalDataNotice.length > 0
      ? r.externalDataNotice
      : DEFAULTS.governedEscalation.externalDataNotice,
    approvalLanguage: {
      affirmative: normalizePhraseList(r.approvalLanguage?.affirmative, DEFAULTS.governedEscalation.approvalLanguage.affirmative),
      negative: normalizePhraseList(r.approvalLanguage?.negative, DEFAULTS.governedEscalation.approvalLanguage.negative),
    },
    displayNames: {
      providers: normalizeDisplayNames(r.displayNames?.providers),
      models: normalizeDisplayNames(r.displayNames?.models),
    },
  };
}

function normalizePhraseList(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) return [...fallback];
  const phrases = [...new Set(value.map((item) => String(item).trim()).filter((item) => (
    item && item
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[.,!?;:]+/g, " ")
      .trim()
  )))];
  return phrases.length > 0 ? phrases : [...fallback];
}

function normalizeDisplayNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const names = {};
  for (const [key, label] of Object.entries(value)) {
    if (typeof label === "string" && label.trim()) names[key] = label.trim();
  }
  return names;
}

function normalizeFamilyResolution(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const aliases = {};
  if (r.aliases && typeof r.aliases === "object" && !Array.isArray(r.aliases)) {
    for (const [name, value] of Object.entries(r.aliases)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name) || !value || typeof value !== "object") continue;
      const providers = Array.isArray(value.providers)
        ? [...new Set(value.providers.map((item) => String(item).trim().toLowerCase()).filter((item) => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(item)))]
        : [];
      const family = typeof value.family === "string" ? value.family.trim().toLowerCase() : "";
      if (!family || providers.length === 0) continue;
      aliases[name] = {
        family,
        providers,
        strategy: value.strategy === "newest" ? "newest" : "lowest_cost",
        ...(Array.isArray(value.acceptedModels) ? {
          acceptedModels: [...new Set(value.acceptedModels
            .map((item) => String(item).trim().toLowerCase())
            .filter((item) => /^[^/\s]+\/[^/\s]+$/.test(item)))],
        } : {}),
        ...(Number.isFinite(value.maxInputPerM) && value.maxInputPerM > 0 ? { maxInputPerM: value.maxInputPerM } : {}),
        ...(Number.isFinite(value.maxOutputPerM) && value.maxOutputPerM > 0 ? { maxOutputPerM: value.maxOutputPerM } : {}),
      };
    }
  }
  return {
    enabled: r.enabled === true,
    catalogPath: typeof r.catalogPath === "string" && r.catalogPath.length > 0 ? r.catalogPath : DEFAULTS.familyResolution.catalogPath,
    maxAgeHours: Number.isFinite(r.maxAgeHours) && r.maxAgeHours >= 1 ? r.maxAgeHours : DEFAULTS.familyResolution.maxAgeHours,
    aliases,
    hostPlan: normalizeFamilyHostPlan(r.hostPlan, aliases),
  };
}

function normalizeFamilyHostPlan(raw, aliases) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const validAlias = (value) => typeof value === "string" && Object.hasOwn(aliases, value);
  const primary = validAlias(r.primary) ? r.primary : "";
  const fallbacks = Array.isArray(r.fallbacks)
    ? [...new Set(r.fallbacks.filter(validAlias))].filter((alias) => alias !== primary)
    : [];
  return { primary, fallbacks };
}

function normalizeCostVisibility(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const attribution = r.attribution && typeof r.attribution === "object" ? r.attribution : {};
  const log = r.log && typeof r.log === "object" ? r.log : {};
  const pricing = r.pricing && typeof r.pricing === "object" ? r.pricing : {};
  const D = DEFAULTS.costVisibility;
  return {
    attribution: {
      deploymentId: normalizeAttributionId(attribution.deploymentId),
      costCenter: normalizeAttributionId(attribution.costCenter),
    },
    log: {
      enabled: log.enabled !== false,
      path: typeof log.path === "string" && log.path.length > 0 ? log.path : D.log.path,
      rotateSizeMb:
        Number.isFinite(log.rotateSizeMb) && log.rotateSizeMb >= 1
          ? Math.floor(log.rotateSizeMb)
          : D.log.rotateSizeMb,
    },
    pricing: {
      sourceUrl:
        typeof pricing.sourceUrl === "string" && pricing.sourceUrl.length > 0
          ? pricing.sourceUrl
          : D.pricing.sourceUrl,
      cachePath:
        typeof pricing.cachePath === "string" && pricing.cachePath.length > 0
          ? pricing.cachePath
          : D.pricing.cachePath,
      refreshHours:
        Number.isFinite(pricing.refreshHours) && pricing.refreshHours >= 1
          ? pricing.refreshHours
          : D.pricing.refreshHours,
      timeoutMs:
        Number.isFinite(pricing.timeoutMs) && pricing.timeoutMs >= 1000
          ? Math.floor(pricing.timeoutMs)
          : D.pricing.timeoutMs,
      userPriceOverridePath:
        typeof pricing.userPriceOverridePath === "string" ? pricing.userPriceOverridePath : "",
    },
    summaryEveryCalls:
      Number.isFinite(r.summaryEveryCalls) && r.summaryEveryCalls >= 1
        ? Math.floor(r.summaryEveryCalls)
        : D.summaryEveryCalls,
  };
}

// Billing attribution is deliberately a small, non-secret identifier surface.
// Restrict values to portable slugs so names, email addresses, paths, tokens,
// or other customer data cannot accidentally enter the local usage ledger.
function normalizeAttributionId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(trimmed) ? trimmed : "";
}

function normalizeCheapHeuristic(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { default: "", order: [] };
  if (typeof r.default === "string") out.default = r.default;
  if (Array.isArray(r.order)) out.order = r.order.filter((x) => typeof x === "string" && x.length > 0);
  return out;
}

function normalizeOwnerOverrideEntry(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === true,
    statePath:
      typeof r.statePath === "string" && r.statePath.length > 0
        ? r.statePath
        : DEFAULTS.ownerOverride.statePath,
    askConsumer:
      typeof r.askConsumer === "string" && r.askConsumer.length > 0
        ? r.askConsumer
        : DEFAULTS.ownerOverride.askConsumer,
  };
}

function normalizeFeatureEntry(entry, fallback) {
  if (!entry || typeof entry !== "object") return { enabled: fallback.enabled };
  if (entry.enabled === true || entry.enabled === false) return { enabled: entry.enabled };
  return { enabled: fallback.enabled };
}

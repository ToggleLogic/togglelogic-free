/*
 * ToggleLogic (Free Tier) — config normalization.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
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
  intelligence: Object.freeze({
    enabled: true,
    path: "~/togglelogic-intelligence",
    registryPath: "",
    fallbackOnError: true,
  }),
  features: Object.freeze({
    routing: Object.freeze({ enabled: false }),
    ownerOverrideAsk: Object.freeze({ enabled: false }),
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
      fallbackOnError: intelligence.fallbackOnError !== false,
    },
    features: {
      routing: normalizeFeatureEntry(features.routing, DEFAULTS.features.routing),
      ownerOverrideAsk: normalizeFeatureEntry(features.ownerOverrideAsk, DEFAULTS.features.ownerOverrideAsk),
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
  };
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

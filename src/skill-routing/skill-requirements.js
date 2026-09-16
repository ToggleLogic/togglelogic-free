/*
 * ToggleLogic (Free Tier) — deployment-owned per-skill CAPABILITY REQUIREMENTS.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * WHY THIS EXISTS (1.6.1-rc.2 capability-safety correction, gap A):
 *   Skill IDENTITY resolves deterministically (resolver/recipes/classifier), but
 *   identity alone does not say what a skill NEEDS to run. When a skill has no
 *   learned routing profile yet, the Intelligence planner's legacy task classifier
 *   returns required_tier:null for ordinary requests ("prepare my meeting", an
 *   Outlook email), so buildSkillPlan defaults to general_purpose. That first-use
 *   education would then happily offer an installed general_purpose-only local
 *   Ollama model to execute a skill that actually needs tool-calling (Microsoft
 *   Graph, Zoom) — a model that cannot make the call.
 *
 * THE CONTRACT (routing CONSTRAINTS, not learned model choices):
 *   The DEPLOYMENT declares, keyed by verified installed skill id, the capability
 *   floor each skill needs: requiredTier, requiredSurface, privacy, requiresTools,
 *   and optional estimatedTokens / minimumBenchmarkScore / cost caps. A skill with
 *   NO explicit entry inherits a CONSERVATIVE default (tool_calling_strong +
 *   requiresTools) so an unverified general_purpose-only local model is never
 *   offered for tool-using skill execution. A deployment opts a PROVEN tool-free
 *   skill DOWN to { requiredTier:"general_purpose", requiresTools:false } to let a
 *   local lowest-cost model win. Every field is validated INDEPENDENTLY and an
 *   invalid value FAILS CLOSED to the (conservative) fallback — it can never widen.
 *
 * These requirements are aggregated across the one-or-more skills a turn resolves
 * to (strictest tier/privacy/benchmark, min cost caps, union of surfaces) and
 * passed across the Free seam into Intelligence.planSkills, which combines them
 * with the legacy task classifier and any learned profile — again strictest.
 * Pure; never throws.
 */

// Ordered capability tiers (mirror the Intelligence engine's TIERS). A skill's
// requiredTier is a FLOOR: only models eligible at that tier may execute it.
// Index = strictness rank.
const TIERS = ["general_purpose", "tool_calling_strong", "terminal_capable", "flagship_reasoning"];
const TIER_SET = new Set(TIERS);
// Privacy postures, least → most restrictive. local_only forbids any cloud model.
const PRIVACY = ["cloud_allowed", "local_preferred", "local_only"];
const PRIVACY_SET = new Set(PRIVACY);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
// Execution surface is a portable slug (e.g. "local_exec") — never free text.
const SURFACE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SKILL_ENTRIES = 256;
const MAX_ESTIMATED_TOKENS = 10_000_000;

// The hard-coded conservative fallback. Used when the deployment declares no
// `default`, or its `default` is malformed. tool_calling_strong + requiresTools
// means an unverified general_purpose-only local model is NEVER offered to run a
// skill whose capability the deployment has not explicitly relaxed (gap-A rule).
export const CONSERVATIVE_DEFAULT = Object.freeze({
  requiredTier: "tool_calling_strong",
  requiredSurface: null,
  privacy: "cloud_allowed",
  requiresTools: true,
  estimatedTokens: null,
  minimumBenchmarkScore: null,
  maxCostUsdPerRun: null,
  maxCostUsdPerMonth: null,
});

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tierRank(tier) {
  const index = TIERS.indexOf(tier);
  return index < 0 ? 0 : index;
}

function privacyRank(privacy) {
  const index = PRIVACY.indexOf(privacy);
  return index < 0 ? 0 : index;
}

// Coerce one raw requirement object against a fallback. Each field is validated
// INDEPENDENTLY; an invalid or absent field takes the fallback's value (which is
// conservative), so a malformed entry can only ever fail closed, never widen.
function coerceRequirement(raw, fallback) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const tier = cleanString(r.requiredTier);
  const privacy = cleanString(r.privacy);
  const surface = cleanString(r.requiredSurface);
  return {
    requiredTier: tier && TIER_SET.has(tier) ? tier : fallback.requiredTier,
    requiredSurface: surface && SURFACE_RE.test(surface) ? surface : fallback.requiredSurface,
    privacy: privacy && PRIVACY_SET.has(privacy) ? privacy : fallback.privacy,
    requiresTools: typeof r.requiresTools === "boolean" ? r.requiresTools : fallback.requiresTools,
    estimatedTokens: Number.isFinite(r.estimatedTokens) && r.estimatedTokens >= 1 && r.estimatedTokens <= MAX_ESTIMATED_TOKENS
      ? Math.floor(r.estimatedTokens) : fallback.estimatedTokens,
    minimumBenchmarkScore: Number.isFinite(r.minimumBenchmarkScore) && r.minimumBenchmarkScore >= 0
      ? r.minimumBenchmarkScore : fallback.minimumBenchmarkScore,
    maxCostUsdPerRun: Number.isFinite(r.maxCostUsdPerRun) && r.maxCostUsdPerRun >= 0
      ? r.maxCostUsdPerRun : fallback.maxCostUsdPerRun,
    maxCostUsdPerMonth: Number.isFinite(r.maxCostUsdPerMonth) && r.maxCostUsdPerMonth >= 0
      ? r.maxCostUsdPerMonth : fallback.maxCostUsdPerMonth,
  };
}

/**
 * normalizeSkillRequirements — coerce raw config into a trusted { default, skills }
 * shape. The deployment `default` is coerced against the hard conservative
 * fallback (a broken default still fails closed); each per-skill entry is coerced
 * against the DEPLOYMENT default, so an omitted/invalid field inherits the
 * (conservative) default rather than a loose global. Invalid keys dropped. Pure.
 */
export function normalizeSkillRequirements(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const def = coerceRequirement(r.default, CONSERVATIVE_DEFAULT);
  const skills = {};
  const rawSkills = r.skills && typeof r.skills === "object" && !Array.isArray(r.skills) ? r.skills : {};
  for (const [id, value] of Object.entries(rawSkills).slice(0, MAX_SKILL_ENTRIES)) {
    if (!ID_RE.test(id)) continue; // an invalid/unknown key never widens
    skills[id] = coerceRequirement(value, def);
  }
  return { default: def, skills };
}

/**
 * createSkillRequirements(rawConfig) → { requirementFor(id), aggregate(skills), config }.
 * requirements are deployment routing CONSTRAINTS, never learned model choices.
 */
export function createSkillRequirements(rawConfig) {
  const config = normalizeSkillRequirements(rawConfig);

  // The requirement for one skill id: its explicit entry, else the deployment
  // default. A resolved skill is already verified-installed, so no inventory
  // cross-check is needed here; a config entry for a NON-resolved id is simply
  // never consulted, which is why an unavailable requirement id cannot widen.
  function requirementFor(id) {
    const key = cleanString(id);
    return key && config.skills[key] ? config.skills[key] : config.default;
  }

  /**
   * Aggregate the requirements of one-or-more RESOLVED (installed) skills into a
   * single, deterministic, STRICTEST-wins constraint set for the planner:
   *   - requiredTier          : highest (strictest) tier across the set
   *   - requiredSurfaces       : union of distinct non-null surfaces (conflict when >1)
   *   - privacy                : strictest posture (local_only > local_preferred > cloud_allowed)
   *   - requiresTools          : true if ANY skill needs tools
   *   - minimumBenchmarkScore  : max (strictest floor) or null
   *   - estimatedTokens        : max hint or null
   *   - maxCostUsd{PerRun,PerMonth} : min (strictest cap) or null
   * Order-independent; never throws.
   */
  function aggregate(skills) {
    const list = (Array.isArray(skills) ? skills : [])
      .map((skill) => cleanString(typeof skill === "string" ? skill : skill?.id))
      .filter(Boolean);
    const perSkill = {};
    let requiredTier = "general_purpose";
    const surfaces = new Set();
    let privacy = "cloud_allowed";
    let requiresTools = false;
    let minimumBenchmarkScore = null;
    let estimatedTokens = null;
    let maxCostUsdPerRun = null;
    let maxCostUsdPerMonth = null;
    for (const id of list) {
      const req = requirementFor(id);
      perSkill[id] = req;
      if (tierRank(req.requiredTier) > tierRank(requiredTier)) requiredTier = req.requiredTier;
      if (req.requiredSurface) surfaces.add(req.requiredSurface);
      if (privacyRank(req.privacy) > privacyRank(privacy)) privacy = req.privacy;
      if (req.requiresTools === true) requiresTools = true;
      if (Number.isFinite(req.minimumBenchmarkScore)) {
        minimumBenchmarkScore = Math.max(minimumBenchmarkScore ?? -Infinity, req.minimumBenchmarkScore);
      }
      if (Number.isFinite(req.estimatedTokens)) {
        estimatedTokens = Math.max(estimatedTokens ?? 0, req.estimatedTokens);
      }
      if (Number.isFinite(req.maxCostUsdPerRun)) {
        maxCostUsdPerRun = Math.min(maxCostUsdPerRun ?? Infinity, req.maxCostUsdPerRun);
      }
      if (Number.isFinite(req.maxCostUsdPerMonth)) {
        maxCostUsdPerMonth = Math.min(maxCostUsdPerMonth ?? Infinity, req.maxCostUsdPerMonth);
      }
    }
    const requiredSurfaces = [...surfaces].sort();
    return {
      requiredTier,
      requiredSurfaces,
      surfaceConflict: requiredSurfaces.length > 1,
      privacy,
      requiresTools,
      minimumBenchmarkScore: Number.isFinite(minimumBenchmarkScore) ? minimumBenchmarkScore : null,
      estimatedTokens: Number.isFinite(estimatedTokens) && estimatedTokens > 0 ? estimatedTokens : null,
      maxCostUsdPerRun: Number.isFinite(maxCostUsdPerRun) ? maxCostUsdPerRun : null,
      maxCostUsdPerMonth: Number.isFinite(maxCostUsdPerMonth) ? maxCostUsdPerMonth : null,
      skillCount: list.length,
      perSkill,
    };
  }

  return { requirementFor, aggregate, config };
}

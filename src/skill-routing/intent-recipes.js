/*
 * ToggleLogic (Free Tier) — deployment-owned deterministic intent recipes.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * WHY THIS EXISTS (1.6.1-rc.2 resolver hardening):
 *   Exact installed-skill/alias resolution is deterministic and safe, but it only
 *   fires when a skill id/alias appears verbatim. A natural-language composition
 *   like "prepare me for my 2 PM meeting" names no skill, yet on the reference host
 *   it should compose the installed microsoft-graph (authoritative Outlook calendar)
 *   + zoom-meetings (subordinate recordings) skills. The bounded local classifier
 *   was measured to misroute exactly this prompt. Rather than trust a probabilistic
 *   model for a known, owner-critical composition, the DEPLOYMENT declares the
 *   mapping explicitly as a deterministic recipe.
 *
 * THE CONTRACT (fail-safe, no arbitrary code, no raw regex):
 *   A recipe is a declarative NORMALIZED-TOKEN rule:
 *     { id, allTerms:[...], anyTerms:[...], skillIds:[one-or-more installed ids] }
 *   - allTerms : EVERY term must be present (word-boundary, normalized).
 *   - anyTerms : at least ONE must be present (when the list is non-empty).
 *   - skillIds : the installed skills this recipe composes to.
 *   A rule RESOLVES only if every target skill is present in the FRESH verified
 *   inventory; if any target skill is absent the rule is inert (fail safe). When
 *   several matching rules resolve to DIFFERENT skill sets the result is AMBIGUOUS
 *   (clarify / fail closed) — never a silent pick.
 *
 * Evaluated ONLY after exact installed-skill resolution returns "none" and BEFORE
 * the bounded classifier (see coordinator.handleGate). Default set is EMPTY so a
 * deployment opts in explicitly; nothing composes without a declared recipe.
 */

const MAX_RULES = 64;
const MAX_TERMS = 32;
const MAX_TERM_LEN = 120;
const MAX_SKILLS_PER_RULE = 16;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Mirror resolver.normalizeTerms so recipe terms match the same token stream the
// exact resolver uses: lowercase, non-alphanumerics collapse to single spaces.
function normalizeTerms(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Word-boundary presence of a normalized (possibly multi-word) term.
function containsTerm(normalizedText, term) {
  if (!term) return false;
  return ` ${normalizedText} `.includes(` ${term} `);
}

function normalizeTermList(value) {
  const list = (Array.isArray(value) ? value : [])
    .slice(0, MAX_TERMS)
    .map((t) => normalizeTerms(t))
    .filter((t) => t.length >= 1 && t.length <= MAX_TERM_LEN);
  return [...new Set(list)];
}

function normalizeSkillIds(value) {
  const list = (Array.isArray(value) ? value : [])
    .slice(0, MAX_SKILLS_PER_RULE)
    .map((s) => cleanString(s))
    .filter((s) => s && ID_RE.test(s));
  return [...new Set(list)];
}

/**
 * normalizeIntentRecipes — coerce raw config into a trusted, bounded rule list.
 * Drops rules that would match everything (no discriminating term) or resolve to
 * nothing (no valid skill id), and de-dupes by rule id. Pure; never throws.
 */
export function normalizeIntentRecipes(rawRules) {
  const out = [];
  const seenIds = new Set();
  for (const raw of (Array.isArray(rawRules) ? rawRules : []).slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== "object") continue;
    const id = cleanString(raw.id);
    if (!id || seenIds.has(id)) continue;
    const allTerms = normalizeTermList(raw.allTerms);
    const anyTerms = normalizeTermList(raw.anyTerms);
    const skillIds = normalizeSkillIds(raw.skillIds);
    // A rule with no discriminating term would match every message → drop (fail safe).
    if (allTerms.length + anyTerms.length === 0) continue;
    // A rule with no valid target skill can never resolve → drop.
    if (skillIds.length === 0) continue;
    seenIds.add(id);
    out.push({ id, allTerms, anyTerms, skillIds });
  }
  return out;
}

/**
 * createIntentRecipes(rawRules) → { resolve(text,{installedIds}), size, rules }.
 *
 * resolve() returns:
 *   { status:"resolved",  ruleId, skills:[ids], matchedRuleIds }
 *   { status:"ambiguous", candidates:[{ruleId, skills}] }   — conflicting rules
 *   { status:"none",      reason }                            — no resolvable match
 * Never throws.
 */
export function createIntentRecipes(rawRules) {
  const rules = normalizeIntentRecipes(rawRules);

  function ruleMatches(rule, normalizedText) {
    if (!rule.allTerms.every((t) => containsTerm(normalizedText, t))) return false;
    if (rule.anyTerms.length > 0 && !rule.anyTerms.some((t) => containsTerm(normalizedText, t))) return false;
    return true;
  }

  function resolve(text, { installedIds } = {}) {
    const normalized = normalizeTerms(text);
    if (rules.length === 0) return { status: "none", reason: "no_recipes", skills: [] };
    if (!normalized) return { status: "none", reason: "no_text", skills: [] };
    const installed = new Set((Array.isArray(installedIds) ? installedIds : []).filter(Boolean));

    const matchedResolvable = [];
    const matchedUnavailable = [];
    for (const rule of rules) {
      if (!ruleMatches(rule, normalized)) continue;
      const missing = rule.skillIds.filter((id) => !installed.has(id));
      if (missing.length === 0) matchedResolvable.push(rule);
      else matchedUnavailable.push({ ruleId: rule.id, missing });
    }

    if (matchedResolvable.length === 0) {
      return {
        status: "none",
        reason: matchedUnavailable.length ? "recipe_skills_absent" : "no_recipe_match",
        skills: [],
        unavailable: matchedUnavailable,
      };
    }

    // Group the resolvable matches by their (order-independent) skill SET. If more
    // than one distinct set matches, the recipes conflict → fail closed (clarify).
    const setKey = (rule) => [...new Set(rule.skillIds)].sort().join(",");
    const distinct = new Map();
    for (const rule of matchedResolvable) {
      const key = setKey(rule);
      if (!distinct.has(key)) distinct.set(key, rule);
    }
    if (distinct.size > 1) {
      return {
        status: "ambiguous",
        reason: "conflicting_recipes",
        candidates: matchedResolvable.map((rule) => ({ ruleId: rule.id, skills: [...new Set(rule.skillIds)] })),
        skills: [],
      };
    }

    const chosen = matchedResolvable[0];
    return {
      status: "resolved",
      ruleId: chosen.id,
      skills: [...new Set(chosen.skillIds)],
      matchedRuleIds: matchedResolvable.map((rule) => rule.id),
    };
  }

  return { resolve, size: rules.length, rules };
}

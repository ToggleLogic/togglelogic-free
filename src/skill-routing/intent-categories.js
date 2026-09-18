/*
 * ToggleLogic (Free Tier) — deployment-owned non-action categories.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * The owner-directed fail-closed rule: on governed SAM, EVERY actionable request
 * must resolve to an active installed skill or return the no-skill fail-safe.
 * Conversation and control messages (greetings, acknowledgements, "stop",
 * "status", "help") are NOT actionable skill work and must be distinguished —
 * but ONLY through EXPLICIT, deployment-owned categories, never by silent
 * inference. This module is that explicit, auditable matcher.
 *
 * A message that matches a declared non-action category bypasses the skill gate
 * (returns to normal host handling / a deployment control handler). Everything
 * else that does not resolve to a skill hits the fail-safe. The default category
 * set is EMPTY: a deployment must declare its own non-action language, so nothing
 * is quietly exempted from the fail-closed rule.
 */

const MAX_CATEGORIES = 32;
const MAX_PHRASES = 256;
const MAX_PATTERNS = 64;
const MAX_PATTERN_LEN = 256;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * createNonActionMatcher(rawCategories) → { match(text) }.
 * Each category: { id, phrases:[exact normalized message], patterns:[regex src] }.
 *   - phrases match the WHOLE normalized message (exact control/greeting tokens).
 *   - patterns are anchored, size-capped regexes tested against the RAW text.
 * match(text) returns { matched:true, category, kind } or { matched:false }.
 * Never throws; a malformed pattern is skipped (and reported once via onWarn).
 */
export function createNonActionMatcher(rawCategories, onWarn) {
  const categories = [];
  for (const raw of (Array.isArray(rawCategories) ? rawCategories : []).slice(0, MAX_CATEGORIES)) {
    const id = cleanString(raw?.id);
    if (!id) continue;
    const phrases = new Set(
      (Array.isArray(raw.phrases) ? raw.phrases : [])
        .slice(0, MAX_PHRASES)
        .map(normalize)
        .filter((p) => p.length >= 1),
    );
    const patterns = [];
    for (const src of (Array.isArray(raw.patterns) ? raw.patterns : []).slice(0, MAX_PATTERNS)) {
      const text = cleanString(src);
      if (!text || text.length > MAX_PATTERN_LEN) continue;
      try {
        patterns.push(new RegExp(text, "i"));
      } catch (error) {
        onWarn?.(`ignored invalid non-action pattern for category ${id}: ${error.message}`);
      }
    }
    if (phrases.size === 0 && patterns.length === 0) continue;
    categories.push({ id, phrases, patterns });
  }

  function match(text) {
    const raw = cleanString(text);
    if (!raw) return { matched: false };
    const normalized = normalize(raw);
    for (const category of categories) {
      if (category.phrases.has(normalized)) return { matched: true, category: category.id, kind: "phrase" };
      for (const pattern of category.patterns) {
        if (pattern.test(raw)) return { matched: true, category: category.id, kind: "pattern" };
      }
    }
    return { matched: false };
  }

  return { match, size: categories.length, categoryIds: categories.map((c) => c.id) };
}

// Chief-of-staff writing that needs no external system is ordinary model work,
// not a failed skill lookup. Keep this deliberately narrow: requests that also
// direct SAM to send, publish, upload, or otherwise execute the content remain
// governed and must resolve to a real skill.
const TOOL_FREE_WRITING = /\b(?:write|draft|rewrite|rework|polish|rephrase|tighten|word|edit)\b[\s\S]{0,120}\b(?:email|message|post|caption|statement|script|copy|note|response|reply|announcement|text|wording|something)\b/i;
const EXTERNAL_EXECUTION = /\b(?:send|publish|upload|schedule|deliver|submit|share|notify|fax|tweet)\b|\bpost\s+(?:it|this|that|the|a|an)\b|\b(?:email|dm|text|slack|message)\s+(?:it|this|that|them|him|her)\b|\b(?:email|dm|text|slack|message)\s+(?:the|a|an)\s+\w+/i;
const DATA_DEPENDENT_WRITING = /\b(?:quickbooks|qbo|profit\s*(?:and|&)\s*loss|p\s*&\s*l|balance\s+sheet|cash\s+flow|financial\s+(?:figures?|results?|statements?)|outlook\s+(?:calendar|inbox|mail)|latest\s+(?:calendar|inbox|crm|recording|transcript)|zoom\s+(?:recording|transcript|summary)|crm\s+(?:record|data|pipeline)|open\s+invoices?)\b/i;

export function classifyToolFreeWork(text) {
  const raw = cleanString(text);
  if (!raw || !TOOL_FREE_WRITING.test(raw) || EXTERNAL_EXECUTION.test(raw) || DATA_DEPENDENT_WRITING.test(raw)) {
    return { matched: false };
  }
  return { matched: true, category: "tool_free_writing" };
}

/*
 * ToggleLogic (Free Tier) — model-ref normalization for cost visibility.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE): free, limited, REVOCABLE use; all rights reserved.
 * PATENT PENDING. The benchmark Intelligence engine + Toggle Registry are NOT
 * in this package.
 *
 * The usage stream's model refs do NOT reliably match a public pricing feed's
 * keys (xai vs x-ai, openai vs openai-codex, dotted vs dashed versions, date/
 * -preview suffixes, provider-prefixed or not). This module canonicalizes both
 * sides to a small set of comparable keys so a price can actually resolve. A
 * ref that fails to resolve here surfaces as UNPRICED (loud) — never $0.00.
 */

// Curated FREE-tier providers (the "standard lineups" — paywall is COVERAGE, not
// accuracy). Anything outside this set stays unpriced-loud (paid tier = all).
export const CURATED_PROVIDERS = Object.freeze(["anthropic", "openai", "google", "xai", "meta"]);

// Map the many provider spellings/hosts seen in usage refs + feeds onto a single
// canonical provider token. Hosts that merely SERVE a curated model (azure, vertex,
// bedrock, together, fireworks, groq, openrouter…) are normalized to the model's
// true vendor where unambiguous; llama-family is handled separately (see below).
const PROVIDER_ALIASES = Object.freeze({
  "x-ai": "xai",
  "openai-codex": "openai",
  "codex": "openai",
  "azure": "openai",
  "azure_ai": "openai",
  "vertex_ai": "google",
  "gemini": "google",
  "googleai": "google",
  "google-vertex": "google",
  "togetherai": "together",
});

function aliasProvider(p) {
  const k = String(p || "").toLowerCase();
  return PROVIDER_ALIASES[k] || k;
}

// Llama / Meta family detection: hosted refs like `together/meta-llama/Llama-3.3-...`
// or `fireworks/llama-...` are the Meta lineup regardless of who serves them.
function isLlamaFamily(ref) {
  return /(^|[/_-])(meta-)?llama/i.test(String(ref || ""));
}

/**
 * The vendor a ref belongs to, for the curation gate. Returns a canonical token
 * (anthropic/openai/google/xai/meta) or the aliased first segment otherwise.
 */
export function providerOf(ref) {
  const s = String(ref || "");
  if (isLlamaFamily(s)) return "meta";
  const seg = s.includes("/") ? s.split("/")[0] : "";
  const aliased = aliasProvider(seg);
  // A bare ref (no provider prefix) — infer vendor from the model name.
  if (!seg) {
    if (/^claude/i.test(s)) return "anthropic";
    if (/^(gpt-|o\d|chatgpt)/i.test(s)) return "openai";
    if (/^gemini|^gemma/i.test(s)) return "google";
    if (/^grok/i.test(s)) return "xai";
  }
  return aliased;
}

export function isCurated(ref) {
  return CURATED_PROVIDERS.includes(providerOf(ref));
}

/**
 * Canonicalize a raw model id: lowercase, dotted versions -> dashed (gpt-5.4 ->
 * gpt-5-4, gemini-3.5 -> gemini-3-5, grok-4.3 -> grok-4-3). Deterministic and
 * symmetric — applied identically to feed keys and usage refs.
 */
export function canon(model) {
  return String(model || "").toLowerCase().trim().replace(/\./g, "-");
}

// The trailing date/version stamp feeds sometimes carry: -20251001, @20251001,
// -2026-03-17, -v1, -v1:0. Stripping yields the undated alias (claude-haiku-4-5).
function stripDateVersion(m) {
  return String(m)
    .replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/g, "")
    .replace(/-v\d+(:\d+)?$/g, "");
}

// Reduce a possibly-prefixed/hosted id to its core model segment.
//   anthropic/claude-opus-4-7        -> claude-opus-4-7
//   requesty/anthropic/claude-opus-4 -> claude-opus-4
//   us.anthropic.claude-sonnet-4-6   -> claude-sonnet-4-6
//   together/meta-llama/Llama-3.3..  -> meta-llama/llama-3.3..  (llama kept qualified)
export function coreModel(ref) {
  let s = String(ref || "").trim();
  if (isLlamaFamily(s)) {
    // keep the meta-llama/<model> tail so Together/Fireworks/etc. collapse together
    const m = s.match(/((?:meta-)?llama[^/]*\/)?([^/]+)$/i);
    if (m) return canon((m[1] || "meta-llama/") + m[2]);
  }
  // drop leading provider/host segments (split on / and dotted host prefixes)
  if (s.includes("/")) s = s.split("/").pop();
  // dotted host prefixes like us.anthropic.claude-... -> take the claude-... tail
  const dotParts = s.split(".");
  if (dotParts.length > 1 && /^(us|eu|apac|global|anthropic|openai|google|vertex_ai|azure|azure_ai|bedrock|gemini)$/i.test(dotParts[0])) {
    // walk off known host/vendor dotted prefixes
    while (dotParts.length > 1 && /^(us|eu|apac|global|anthropic|openai|google|vertex_ai|azure|azure_ai|bedrock|gemini)$/i.test(dotParts[0])) {
      dotParts.shift();
    }
    s = dotParts.join(".");
  }
  return canon(s);
}

// Expand a canonical core into the set of forms we index/look up under: the id
// itself, its date-stripped alias, and with/without a -preview suffix. Order is
// most-specific-first so an exact hit wins over a looser alias.
export function keyForms(coreCanon) {
  const forms = new Set();
  const add = (x) => { if (x) forms.add(x); };
  const bases = new Set([coreCanon, stripDateVersion(coreCanon)]);
  for (const b of bases) {
    add(b);
    if (b.endsWith("-preview")) add(b.replace(/-preview$/, ""));
    else add(b + "-preview");
  }
  return [...forms];
}

/**
 * Ordered candidate lookup keys for a usage ref (most specific first).
 */
export function candidateKeys(ref) {
  return keyForms(coreModel(ref));
}

/**
 * Keys to index a feed model under (provider block + raw model id from the feed).
 */
export function feedIndexKeys(feedProviderId, feedModelId) {
  // feedModelId may be bare (`claude-opus-4-5`) or itself prefixed
  // (`anthropic/claude-opus-4-5`, `meta-llama/Llama-...`). coreModel handles both.
  return keyForms(coreModel(feedModelId));
}

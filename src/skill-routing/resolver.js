/*
 * ToggleLogic (Free Tier) — deterministic skill-resolution boundary.
 * (c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
 * License (see LICENSE). PATENT PENDING.
 *
 * The 2026-09-15 canary failed because the only skill-identity source the plugin
 * consulted was structured host metadata (`plannedSkills`), which the OpenClaw
 * host never populates on the routing hooks. This module builds a REAL skill
 * boundary from a production-available input — the message text the host DOES
 * deliver (`cleanedBody`) — WITHOUT pretending unsupported inference is
 * deterministic:
 *
 *   1. EXACT installed skill-id references are recognized DETERMINISTICALLY:
 *      a turn is bound to a skill only when that skill's id (or a
 *      deployment-declared alias) appears verbatim, on word boundaries, in the
 *      text. The set of recognizable skills is the deployment's explicit,
 *      auditable installed-skill catalog — not a guess.
 *   2. A skill-INVOCATION cue that names a skill NOT in the catalog
 *      ("...using the <unknown> skill") is surfaced as AMBIGUOUS, never silently
 *      resolved. With skill routing enabled the gate then fails loud or asks a
 *      bounded clarification instead of executing.
 *
 * There is no natural-language task→skill guessing here. General task→skill
 * resolution is only permitted through an explicit, auditable resolver that
 * emits structured skill identities before model execution (config
 * `resolverMode: "structured-only"` keeps this module to the deterministic
 * paths); it is never faked as determinism.
 */

const MAX_SKILLS = 32;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
// Storage bound for a catalog description (mirrors skill-inventory's snapshot
// bound). The classifier re-bounds to a shorter prompt-facing length below.
const MAX_CATALOG_DESC_CHARS = 400;

// "…use/using/run/invoke/via/with/through [the] <name> skill…" — the standard
// way a message explicitly asks for a named skill. Captures <name> so an
// unknown (uninstalled) skill can be flagged rather than ignored.
const INTENT_CUE_RE =
  /\b(?:use|using|run|running|invoke|invoking|via|with|through|apply|applying)\s+(?:the\s+)?([a-z0-9][a-z0-9 ._/-]{1,60}?)\s+skill\b/gi;

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Bounded, single-line, control-free description for storage/classifier use.
// Idempotent; safe on an already-sanitized snapshot value.
function boundedDescription(value, max = MAX_CATALOG_DESC_CHARS) {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    out += (code < 0x20 || code === 0x7f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, Math.max(0, max));
}

// Normalize a term to a comparison token stream: lowercase, non-alphanumerics
// collapse to single spaces. "Meeting-Prep" and "meeting prep" both → "meeting prep".
function normalizeTerms(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCatalog(rawCatalog) {
  const input = Array.isArray(rawCatalog) ? rawCatalog : [];
  const catalog = [];
  for (const raw of input) {
    const entry = typeof raw === "string" ? { id: raw } : raw;
    const id = cleanString(entry?.id || entry?.skill_id || entry?.name);
    if (!id || !ID_RE.test(id)) continue;
    const aliases = Array.isArray(entry?.aliases)
      ? entry.aliases.map(cleanString).filter(Boolean)
      : [];
    // Match terms: the id itself, its space-normalized form, and any aliases.
    const terms = [...new Set(
      [id, ...aliases]
        .map(normalizeTerms)
        .filter((term) => term.length >= 2),
    )];
    catalog.push({
      id,
      terms,
      ...(cleanString(entry?.version) ? { version: cleanString(entry.version) } : {}),
      ...(cleanString(entry?.fingerprint) ? { fingerprint: cleanString(entry.fingerprint) } : {}),
      execution_class: cleanString(entry?.execution_class) || "default",
      // Verified, bounded description carried from the snapshot catalog so the
      // bounded classifier can be given id + description (not opaque ids).
      description: boundedDescription(entry?.description),
    });
  }
  return catalog;
}

// Word-boundary presence of a normalized multi-word term inside normalized text.
function containsTerm(normalizedText, term) {
  if (!term) return false;
  const padded = ` ${normalizedText} `;
  return padded.includes(` ${term} `);
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "with", "using", "use", "run", "via",
  "please", "can", "you", "me", "my", "to", "of", "on", "in", "at", "is", "it",
  "this", "that", "get", "set", "skill", "help", "want", "need", "do", "make",
]);

// Light singular stem: strip a trailing plural "s" so "meetings" ↔ "meeting".
function stem(token) {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function significantTokens(value) {
  return [...new Set(
    normalizeTerms(value)
      .split(" ")
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
      .map(stem),
  )];
}

export function createSkillResolver(rawConfig = {}) {
  const catalog = normalizeCatalog(rawConfig.catalog);
  const mode = rawConfig.mode === "off" ? "off" : "deterministic";
  const ambiguityPolicy = rawConfig.ambiguityPolicy === "fail" ? "fail" : "clarify";
  const catalogIds = new Set(catalog.map((entry) => entry.id));

  function structuredIdentity(entry) {
    return {
      id: entry.id,
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
      execution_class: entry.execution_class || "default",
    };
  }

  /**
   * Return the verified catalog identity for an exact installed skill id.
   * Intent recipes and the bounded classifier deliberately traffic in ids only;
   * callers MUST re-hydrate those ids here before planning or learning so a
   * profile can never silently degrade to version="*" / fingerprint=null.
   */
  function identityFor(id) {
    const wanted = cleanString(id);
    if (!wanted) return null;
    const entry = catalog.find((item) => item.id === wanted);
    return entry ? structuredIdentity(entry) : null;
  }

  /**
   * resolve(text) → structured resolution decision. Never throws.
   *   status: "resolved"  — one or more installed skills recognized deterministically
   *           "ambiguous" — a skill invocation was requested but names an
   *                         unknown/uninstalled skill (do NOT guess; clarify/fail)
   *           "none"      — no skill reference detected
   */
  function resolve(text) {
    const raw = cleanString(text);
    if (mode === "off" || !raw || catalog.length === 0) {
      return { status: "none", skills: [], matchedIds: [], unknownSkills: [], reason: mode === "off" ? "resolver_off" : "no_catalog_or_text" };
    }
    const normalized = normalizeTerms(raw);

    const matched = [];
    const matchedIds = new Set();
    for (const entry of catalog) {
      if (matchedIds.has(entry.id)) continue;
      if (entry.terms.some((term) => containsTerm(normalized, term))) {
        matched.push(structuredIdentity(entry));
        matchedIds.add(entry.id);
        if (matched.length >= MAX_SKILLS) break;
      }
    }

    // Detect explicit "…<name> skill" invocation cues to catch requests for
    // skills that are NOT installed/known — those must not be silently ignored.
    const unknownSkills = [];
    const explicitlyInvokedIds = [];

    // A direct action cue immediately followed by an installed id/alias is also
    // an explicit invocation even when the owner naturally omits the word
    // "skill" (for example, "Use Microsoft Graph ..."). Incidental mentions
    // elsewhere in the sentence remain ordinary exact matches only.
    for (const entry of catalog) {
      for (const term of entry.terms) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const cue = new RegExp(`(?:^| )(?:use|using|run|running|invoke|invoking|via|with|through|apply|applying)(?: the)? ${escaped}(?: |$)`);
        // A coordinated phrase may carry the action verb only once:
        // "run the code-review skill and the meeting-prep skill". Naming an
        // installed term immediately as a "skill" is therefore also explicit,
        // while a bare platform label in pasted data (for example "LinkedIn")
        // remains incidental.
        const skillNounCue = new RegExp(`(?:^| )${escaped} skill(?: |$)`);
        if ((cue.test(normalized) || skillNounCue.test(normalized)) && !explicitlyInvokedIds.includes(entry.id)) {
          explicitlyInvokedIds.push(entry.id);
        }
      }
    }
    let cueMatch;
    INTENT_CUE_RE.lastIndex = 0;
    while ((cueMatch = INTENT_CUE_RE.exec(raw)) !== null) {
      const named = normalizeTerms(cueMatch[1]);
      if (!named) continue;
      const known = catalog.find((entry) => entry.terms.includes(named) || entry.terms.some((term) => containsTerm(named, term)));
      if (known) {
        if (!explicitlyInvokedIds.includes(known.id)) explicitlyInvokedIds.push(known.id);
      } else if (!unknownSkills.includes(named)) unknownSkills.push(named);
    }

    if (matched.length > 0) {
      return { status: "resolved", skills: matched, matchedIds: [...matchedIds], explicitlyInvokedIds, unknownSkills, reason: "exact_installed_skill_reference" };
    }
    if (unknownSkills.length > 0) {
      return { status: "ambiguous", skills: [], matchedIds: [], unknownSkills, reason: "skill_invocation_names_unknown_skill", ambiguityPolicy };
    }
    return { status: "none", skills: [], matchedIds: [], unknownSkills: [], reason: "no_skill_reference" };
  }

  function clarificationText(resolution) {
    const names = (resolution?.unknownSkills || []).join(", ") || "an unrecognized skill";
    const known = [...catalogIds].slice(0, 12).join(", ") || "none configured";
    return (
      "ToggleLogic skill routing is enabled but could not deterministically resolve the skill you referenced " +
      `(${names}). It is not in this deployment's installed-skill catalog, so no route can be assigned safely. ` +
      `Installed skills I can route: ${known}. ` +
      "Please name an installed skill exactly, or rephrase without a skill directive."
    );
  }

  /**
   * suggest(text, {limit}) — DETERMINISTIC candidate installed skills whose match
   * terms share significant tokens with the request. Used to offer applicable
   * installed skills when a NAMED skill is unavailable (owner rule: do not falsely
   * claim "no related skill" when an installed skill can do the job). Never guesses
   * a route; it only proposes real, installed skills for the owner to pick.
   * Returns [{ id, execution_class, score }] highest-score first.
   */
  function suggest(text, { limit = 3 } = {}) {
    const tokens = new Set(significantTokens(text));
    if (tokens.size === 0) return [];
    const scored = [];
    for (const entry of catalog) {
      let score = 0;
      const termTokens = new Set(entry.terms.flatMap((term) => term.split(" ").map(stem)));
      for (const t of termTokens) if (tokens.has(t)) score += 1;
      if (score > 0) scored.push({ id: entry.id, execution_class: entry.execution_class || "default", score });
    }
    scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
    return scored.slice(0, Math.max(1, limit));
  }

  /**
   * classifierCatalog — the verified eligible entries handed to the bounded local
   * classifier: id + bounded description ONLY (never arbitrary prompt data). This
   * is the exact, auditable universe the classifier may choose from.
   */
  function classifierCatalog() {
    return catalog.map((entry) => ({ id: entry.id, description: entry.description || "" }));
  }

  return { resolve, clarificationText, suggest, classifierCatalog, identityFor, catalog, catalogIds, mode, ambiguityPolicy };
}

/**
 * createSkillClassifier — the BOUNDED skill-resolution system-skill path for
 * natural-language requests that name NO skill after deterministic exact/alias
 * resolution has returned "none". It is:
 *   - tool-free, minimal, light-context, and PINNED by the deployment (preferably
 *     a local Ollama model);
 *   - constrained to the FRESH eligible inventory (only ids from the snapshot may
 *     be returned);
 *   - schema-validated and confidence-thresholded;
 *   - audited on every decision;
 *   - PROHIBITED from performing the task — it only names a skill id + confidence
 *     and its output is NEVER executed as an answer.
 * OFF unless a model is pinned. None / low-confidence / malformed output yields
 * the no-skill fail-safe; multiple plausible skills yields one clarification.
 * Never throws.
 *
 *   config = { enabled, provider, model, endpoint, confidenceThreshold, timeoutMs }
 *   deps   = { invoke(request)->Promise<string>, audit(event), logger }
 */
// Hard bounds on what the classifier will accept/emit — enforced fail-closed so a
// bloated inventory or a hostile description can never turn into an unbounded
// prompt. Sized with headroom over the reference host's 57 eligible skills.
const MAX_CLASSIFIER_ENTRIES = 128;    // eligible catalog size handed to the model
const MAX_CLASSIFIER_DESC_CHARS = 160; // prompt-facing description length per entry
const MAX_SYSTEM_PROMPT_CHARS = 24000; // total system-prompt size ceiling
const CLASSIFIER_MIN_NUM_CTX = 2048;
const CLASSIFIER_MAX_NUM_CTX = 32768;
const CLASSIFIER_DEFAULT_NUM_CTX = 8192; // sufficient for the current 57-skill catalog

// Normalize the eligible input into a deduped [{id, boundedDescription}] list.
// Accepts either { eligible:[{id,description}|id] } (preferred: verified catalog
// entries) or the legacy { eligibleIds:[id] }. Descriptions are re-bounded here so
// the prompt size is capped regardless of upstream.
function normalizeEligible(eligible, eligibleIds) {
  const out = [];
  const seen = new Set();
  const push = (id, description) => {
    const cid = cleanString(id);
    if (!cid || seen.has(cid)) return;
    seen.add(cid);
    out.push({ id: cid, description: boundedDescription(description, MAX_CLASSIFIER_DESC_CHARS) });
  };
  if (Array.isArray(eligible)) {
    for (const e of eligible) {
      if (typeof e === "string") push(e, "");
      else if (e && typeof e === "object") push(e.id, e.description);
    }
  } else if (Array.isArray(eligibleIds)) {
    for (const id of eligibleIds) push(id, "");
  }
  return out;
}

export function createSkillClassifier(config = {}, deps = {}) {
  const enabled = config.enabled === true && Boolean(cleanString(config.model));
  const threshold = Number.isFinite(config.confidenceThreshold) ? config.confidenceThreshold : 0.6;
  // A scored alternative within this confidence gap of the primary is a genuine
  // near-tie → clarify. A larger gap (a clear winner + a long-shot alternative) is
  // NOT ambiguous. Bounded [0,1]; default 0.15.
  const ambiguityGap = Number.isFinite(config.ambiguityGap) && config.ambiguityGap >= 0 && config.ambiguityGap <= 1
    ? config.ambiguityGap : 0.15;
  const numCtx = Number.isFinite(config.numCtx) && config.numCtx >= CLASSIFIER_MIN_NUM_CTX && config.numCtx <= CLASSIFIER_MAX_NUM_CTX
    ? Math.floor(config.numCtx) : CLASSIFIER_DEFAULT_NUM_CTX;
  const invoke = typeof deps.invoke === "function" ? deps.invoke : defaultOllamaInvoke;
  const audit = typeof deps.audit === "function" ? deps.audit : () => {};

  // Verified catalog entries (id + bounded description) — never arbitrary prompt
  // data. The description helps a small local model disambiguate ids it cannot
  // interpret from the slug alone; it is still constrained to choose ONE listed id.
  function systemPrompt(entries) {
    return [
      "You are a SKILL ROUTER, not an assistant. You MUST NOT perform, answer, plan, or attempt the user's task in any way.",
      "Choose the SINGLE most applicable installed skill for the request, from ONLY this exact list of installed skills (id: description):",
      ...entries.map((e) => (e.description ? `- ${e.id}: ${e.description}` : `- ${e.id}`)),
      "Respond with STRICT JSON and nothing else:",
      '{"intent": <"task" or "conversation">, "skill_id": <one id from the list, or null>, "confidence": <number 0..1>, "ambiguous": <boolean>, "alternatives": [{"skill_id": <another listed id>, "confidence": <number 0..1>}]}',
      'Use intent="conversation" only for ordinary human conversation that does not ask SAM to perform work: social remarks, acknowledgements, personal reflection, brainstorming, opinions, or advice without external lookup/action. For conversation, skill_id MUST be null.',
      'Use intent="task" for any request to create, inspect, retrieve, search, summarize, modify, send, schedule, calculate, or otherwise perform work. A question that needs external or private data is a task.',
      "Pick the SINGLE best skill_id. A clear platform cue resolves it: e.g. Outlook/email/calendar -> the Microsoft Graph skill; a Zoom recording/transcript -> the Zoom skill.",
      'Set "ambiguous": true ONLY when two or more listed skills are GENUINELY, EQUALLY applicable and you truly cannot choose; a merely lower-confidence alternative is NOT ambiguous.',
      'List other plausible skills in "alternatives" with their own confidence (informational; a low-confidence alternative does not by itself mean ambiguous).',
      "Use skill_id=null when no listed skill applies. Never invent an id that is not in the list. Output only the JSON object.",
    ].join("\n");
  }

  function validate(rawText, eligibleSet) {
    let obj;
    try { obj = JSON.parse(String(rawText)); } catch { return null; }
    if (!obj || typeof obj !== "object") return null;
    const skillId = obj.skill_id === null ? null : (typeof obj.skill_id === "string" ? obj.skill_id.trim() : undefined);
    if (skillId === undefined) return null;
    if (skillId !== null && !eligibleSet.has(skillId)) return null; // hallucinated id → invalid
    if (typeof obj.confidence !== "number" || !(obj.confidence >= 0 && obj.confidence <= 1)) return null;
    const intent = obj.intent === "conversation" ? "conversation" : "task";
    if (intent === "conversation" && skillId !== null) return null;
    // Alternatives accepted as bare ids (legacy) OR scored {skill_id, confidence}
    // objects. Each is filtered to the eligible set and de-duped against the primary
    // — a hallucinated alternative id is dropped, never trusted. A scored confidence
    // is retained so the classifier can distinguish a near-tie from a long shot.
    const altMap = new Map();
    for (const raw of Array.isArray(obj.alternatives) ? obj.alternatives : []) {
      let id;
      let confidence = null;
      if (typeof raw === "string") id = raw.trim();
      else if (raw && typeof raw === "object") {
        id = typeof raw.skill_id === "string" ? raw.skill_id.trim() : "";
        if (typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1) confidence = raw.confidence;
      }
      if (!id || id === skillId || !eligibleSet.has(id) || altMap.has(id)) continue;
      altMap.set(id, confidence);
    }
    const alternatives = [...altMap].map(([id, confidence]) => ({ id, confidence }));
    return { intent, skillId, confidence: obj.confidence, ambiguous: obj.ambiguous === true, alternatives };
  }

  async function classify(text, opts = {}) {
    if (!enabled) return { status: "disabled" };
    const entries = normalizeEligible(opts.eligible, opts.eligibleIds);
    if (!cleanString(text) || entries.length === 0) return { status: "none", reason: "no_text_or_inventory" };
    // FAIL CLOSED if the eligible catalog exceeds the hard entry cap — an oversized
    // inventory must never silently produce an unbounded classifier prompt.
    if (entries.length > MAX_CLASSIFIER_ENTRIES) {
      audit({ decision: "error", error: `eligible catalog ${entries.length} exceeds max ${MAX_CLASSIFIER_ENTRIES}` });
      return { status: "error", reason: "catalog_bounds_exceeded" };
    }
    const eligibleSet = new Set(entries.map((e) => e.id));
    const system = systemPrompt(entries);
    if (system.length > MAX_SYSTEM_PROMPT_CHARS) {
      audit({ decision: "error", error: `system prompt ${system.length} exceeds max ${MAX_SYSTEM_PROMPT_CHARS}` });
      return { status: "error", reason: "system_prompt_bounds_exceeded" };
    }
    let raw;
    try {
      raw = await invoke({
        provider: config.provider || "ollama",
        model: config.model,
        endpoint: config.endpoint,
        timeoutMs: config.timeoutMs || 4000,
        numCtx,
        system,
        prompt: String(text).slice(0, 4000),
      });
    } catch (error) {
      audit({ decision: "error", error: String(error?.message ?? error).slice(0, 200) });
      return { status: "error", reason: "classifier_invoke_failed" };
    }
    const parsed = validate(raw, eligibleSet);
    if (!parsed) {
      audit({ decision: "malformed" });
      return { status: "malformed" };
    }
    if (parsed.intent === "conversation" && parsed.skillId === null && parsed.confidence >= threshold) {
      audit({ decision: "conversation", confidence: parsed.confidence });
      return { status: "conversation", confidence: parsed.confidence };
    }
    if (parsed.skillId === null || parsed.confidence < threshold) {
      audit({ decision: "none", confidence: parsed.confidence });
      return { status: "none", confidence: parsed.confidence };
    }
    // Ambiguity is NOT implied by the mere presence of an alternative — that
    // needlessly clarified explicit Outlook/Zoom requests in the field (the model
    // returned a clear winner plus a low-confidence long shot). Clarify ONLY when
    // the model EXPLICITLY flags equal applicability, OR a scored alternative sits
    // within ambiguityGap of the primary (a genuine near-tie). Otherwise resolve.
    const nearTie = parsed.alternatives.some((alt) =>
      Number.isFinite(alt.confidence) && alt.confidence >= parsed.confidence - ambiguityGap);
    const explicitAmbiguous = parsed.ambiguous === true && parsed.alternatives.length > 0;
    if (explicitAmbiguous || nearTie) {
      const altIds = parsed.alternatives.map((alt) => alt.id);
      audit({ decision: "ambiguous", skill_id: parsed.skillId, alternatives: altIds, confidence: parsed.confidence, reason: nearTie ? "scored_near_tie" : "model_flagged_ambiguous" });
      return { status: "ambiguous", candidates: [parsed.skillId, ...altIds], confidence: parsed.confidence };
    }
    audit({ decision: "resolved", skill_id: parsed.skillId, confidence: parsed.confidence });
    return { status: "resolved", skillId: parsed.skillId, confidence: parsed.confidence };
  }

  return { classify, enabled };
}

// Default transport to a local Ollama server (deployment-pinned). Tool-free,
// deterministic decoding, JSON-constrained. Only used when the classifier is
// enabled AND no transport was injected; tests inject their own.
async function defaultOllamaInvoke({ model, endpoint, system, prompt, timeoutMs, numCtx }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        system,
        prompt,
        stream: false,
        format: "json",
        // num_ctx must fit id + description for the whole eligible catalog; the
        // 2048 default silently truncated the 57-skill list (see benchmark notes).
        options: { temperature: 0, num_ctx: Number.isFinite(numCtx) ? numCtx : CLASSIFIER_DEFAULT_NUM_CTX },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    return data?.response ?? "";
  } finally {
    clearTimeout(timer);
  }
}

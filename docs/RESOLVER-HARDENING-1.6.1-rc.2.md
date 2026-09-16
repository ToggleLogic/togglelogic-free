# Resolver hardening — ToggleLogic Free 1.6.1-rc.2

Status: **prerelease, not installed live.** This pass builds on the green
uncommitted 1.6.1-rc.2 tree. Nothing here installs, publishes, commits, tags, or
mutates live `~/.openclaw` config/state. The example config below is documentation,
not an applied change.

## The measured gap

Two facts about the skill-resolution path as it stood:

1. **The snapshot fingerprinted each skill's description but stripped it from the
   snapshot and the verified catalog.** `skillFingerprint()` hashed the
   host-reported description at generation time, but `buildSnapshotFromSkillsList`
   did not store the description in `snapshot.skills[]`, and `loadSkillInventory`
   did not carry it into the catalog. So the text was gone by the time anything
   downstream could use it.
2. **The bounded classifier received only opaque skill ids** (`eligibleIds`) and ran
   the local model at `num_ctx: 2048`.

### Actual local benchmark findings (NOT re-run in this pass)

Prior local Ollama testing over **all 57 eligible skill ids** on the reference host
produced poor routing:

- **`glm4:9b` — unsafe.** Misrouted or outright rejected most tasks. Not usable as
  the resolution classifier.
- **`gemma4` — improved but insufficient.** With **id + description** supplied and
  **`num_ctx: 8192`**, it reached ~**4/5** on the sample set. But
  **"Prepare me for my 2 PM meeting today" still misrouted** — the exact
  owner-critical composition from the 2026-09-15 incident.

> These numbers are the earlier local findings. **This pass did not rerun Ollama**,
> so no fresh "benchmark passes" claim is made. The design conclusion stands
> regardless: a probabilistic small local model must not be the sole path for a
> known, owner-critical composition. That is why the deterministic intent recipe
> exists.

## The four permanent, fail-closed corrections

### 1. Descriptions preserved and tamper-bound

- `src/skill-routing/skill-inventory.js`
  - `SNAPSHOT_SCHEMA_VERSION` **2 → 3**. A `v2` snapshot is rejected loudly.
  - `sanitizeDescription()` — bounded (`MAX_DESCRIPTION_CHARS = 400`), single-line,
    C0/DEL-control-free, idempotent. Exported.
  - `buildSnapshotFromSkillsList()` stores `description: sanitizeDescription(...)`
    per skill.
  - `computeInventoryFingerprint()` binds `…@sha256(sanitizeDescription(desc))` per
    skill, so **the description participates in tamper/drift validation** — a
    hand-edited stored description (the vector for injecting text into the classifier
    prompt) drifts the fingerprint and fails the snapshot closed.
  - `loadSkillInventory()` enforces the **size bound explicitly** (a stored
    description longer than the bound fails closed with a precise reason) and carries
    the sanitized description into every catalog entry.

### 2. Classifier gets the verified catalog, bounded

- `src/skill-routing/resolver.js`
  - The resolver catalog now carries a bounded `description`; `classifierCatalog()`
    exposes `[{ id, description }]` — the exact, auditable universe the classifier
    may choose from (**never arbitrary prompt data**).
  - `createSkillClassifier()`:
    - System prompt lists `- <id>: <bounded description>` (re-bounded to
      `MAX_CLASSIFIER_DESC_CHARS = 160`).
    - Configurable **`numCtx`**, clamped `[2048, 32768]`, default **8192** (sized for
      the 57-skill catalog fed as id + description; the old `2048` silently truncated
      that list). Passed through to the Ollama transport `options.num_ctx`.
    - Strict output schema + eligible-id validation (a hallucinated id → `malformed`).
    - **Fails closed without invoking the model** if the eligible catalog exceeds
      `MAX_CLASSIFIER_ENTRIES = 128` or the assembled system prompt exceeds
      `MAX_SYSTEM_PROMPT_CHARS = 24000`.
    - Still **prohibited from performing the task**: its output is only a skill id
      that is then routed normally, never executed as the answer.

### 3. Deployment-owned deterministic intent recipes

- `src/skill-routing/intent-recipes.js` (new)
  - Declarative normalized-token rule: `{ id, allTerms:[…], anyTerms:[…],
    skillIds:[one-or-more installed ids] }`. **No code, no raw regex.**
  - `allTerms` — every term must be present (word-boundary, normalized). `anyTerms` —
    at least one present when non-empty. A rule with no discriminating term or no
    valid skill id is dropped.
  - **Resolves only if every target skill is in the fresh verified inventory**,
    otherwise inert (fail safe). Matching recipes that resolve to **different** skill
    sets → **ambiguous** (fail closed / clarify). Same skill set from several rules is
    not a conflict.
  - Evaluated in `coordinator.handleGate` **only after exact installed-skill
    resolution returns none and before the classifier.**

### 4. Meeting-preparation recipe (tested)

With the example recipe configured (below):

- **"Prepare me for my 2 PM meeting today"** → recipe resolves installed
  `microsoft-graph` + `zoom-meetings` deterministically → the already-built
  meeting/calendar contract clarifies at 16:03 (2 PM already past) — **zero planner,
  model, or classifier calls.**
- **"Send an Outlook email …"** (no recipe match) → bounded classifier → Graph.
- **"Write me a poem …"** → exact/recipe/classifier all decline → the unchanged
  universal no-skill fail-safe.
- Out-of-scope / shadow turns keep prior passthrough; recipes never evaluate
  off-canary.

## Example deployment config

```json
{
  "skillRouting": {
    "useSnapshotInventory": true,
    "classifier": {
      "enabled": true,
      "provider": "ollama",
      "model": "gemma4",
      "endpoint": "http://127.0.0.1:11434",
      "confidenceThreshold": 0.6,
      "numCtx": 8192
    },
    "intentRecipes": [
      {
        "id": "meeting-prep-compose",
        "allTerms": ["meeting"],
        "anyTerms": ["prepare", "prep", "brief", "briefing", "ready"],
        "skillIds": ["microsoft-graph", "zoom-meetings"]
      }
    ]
  }
}
```

Notes:

- The recipe is **high-precision by design**: it requires an explicit prep/brief
  INTENT (`allTerms:["meeting"]` **and** one of `anyTerms:["prepare","prep","brief",
  "briefing","ready"]`), so it composes only for a request like "**prepare** me for my
  2 PM **meeting**" — not for every mention of a meeting ("what meetings do I have
  today?" does not fire it). Add further meeting nouns/verbs to the term lists to
  widen it deliberately; the terms are normalized, word-boundary tokens (no stemming),
  so include the exact forms you intend to match.
- The recipe is inert unless **both** `microsoft-graph` and `zoom-meetings` are in
  the verified snapshot; if either is absent the turn fails safe to the no-skill
  fail-safe rather than composing a partial route.
- The classifier is still **off unless a model is pinned**. Even with `gemma4`
  pinned, the meeting composition does not depend on it — the recipe is
  deterministic. The classifier only handles un-named, un-recipe'd requests
  (e.g. generic Outlook email) and still fails safe on low confidence / malformed
  output.
- Regenerate the snapshot after upgrading to schema v3:
  `node scripts/generate-skill-inventory.mjs --out ~/.openclaw/togglelogic/skill-inventory.snapshot.json --free 1.6.1-rc.2 --intelligence 1.4.1-rc.2`.

## Tests

- `tests/skill-intent-recipes.test.js` — recipe engine: multi-skill resolve,
  all/any term semantics, absent-skill fail-safe, conflicting-recipe ambiguity,
  same-set non-conflict, normalize bounds/dedupe.
- `tests/skill-inventory.test.js` (extended) — description preserved to catalog,
  description-in-fingerprint tamper → fail closed, oversized description → fail
  closed, `v2` snapshot → fail closed, `sanitizeDescription` idempotence/bounds.
- `tests/skill-routing-modules.test.js` (extended) — classifier given id +
  description, bounded `numCtx` passthrough, catalog-bounds fail-closed (never
  invokes), hallucinated id → malformed.
- `tests/skill-recipe-gate.test.js` — the six gate acceptances (incident prompt
  zero-model/planner/classifier, email→classifier→Graph, poem→fail-safe,
  absent-skill recipe→fail-safe, conflicting recipes→one clarification,
  out-of-scope passthrough).

Full suite: **233 passing** (was 211). `npm run quality` passes; `git diff --check`
clean.

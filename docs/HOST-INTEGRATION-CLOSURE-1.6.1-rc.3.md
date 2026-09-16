# Host-integration closure — ToggleLogic 1.6.1-rc.3 (paired Intelligence 1.4.1-rc.3)

Release-candidate closure for the four remaining 1.6 gaps after the rc.2 host-
integration pass. All work is durable implementation on the uncommitted
Free/Intelligence trees plus documentation; **no live `openclaw.json` was mutated,
nothing was installed live / activated / published / tagged, the live gateway and
the live 4 AM refresh job were not touched, and no owner approval record was
altered.** Every claim below is backed by a check that was actually run (§Checks).

Host: **OpenClaw 2026.9.4** (`3a9d69d`), verified in-process and via a real
isolated gateway round trip. Supersedes rc.2 without reusing a stable identifier;
rc.2's Blockers 1–3 (calendar bridge, bounded-child limits, gateway proof) remain
closed — see `docs/HOST-INTEGRATION-CLOSURE-1.6.1-rc.2.md`.

---

## Gap 1 — the monthly cloud policy was decorative: CLOSED

**Was:** `skillRouting.monthlyCloudSpendUsd` was a static configured number
(default 0). A deployment past its amortized budget still saw cloud routes offered;
the README admitted "no live spend ceiling."

**Now:** month-to-date CLOUD spend is authoritative and LIVE.

- `src/usage/spend-snapshot.js` (+ `scripts/generate-spend-snapshot.mjs`): builds and
  verifies a versioned + fingerprinted current-policy-month cloud-spend snapshot from
  `openclaw gateway usage-cost --all-agents --expect-final --json`. Fails CLOSED on:
  malformed usage JSON, a stale/wrong policy month (source `updatedAt` month ≠ policy
  month), negative/non-finite day totals, ANY unpriced CLOUD `missingCostByModel`
  entry (unpriced LOCAL/Ollama rows are the expected $0), wrong source/pair, future
  timestamp, staleness, or fingerprint drift.
- `src/usage/spend-provider.js`: resolves the live spend per plan; on an
  unavailable snapshot under a declared finite cloud budget it returns a
  budget-exhausted signal.
- `src/skill-routing/coordinator.js`: the `before_agent_reply` gate feeds the live
  spend to `Intelligence.planSkills`. **AUTHORITATIVE PRECEDENCE (corrected in the
  rc.3 correction pass): when `skillRouting.spend.enabled` is true the VALIDATED live
  snapshot always wins — no caller / event / tool parameter can override it.** A
  hand-entered value (especially a zero) can never reopen cloud after a valid or
  exhausted snapshot; an attempted override while live spend is enabled is IGNORED
  and AUDITED (`caller_spend_ignored`). The public `monthly_cloud_spend_usd` tool
  parameter was REMOVED. The static `monthlyCloudSpendUsd` is used only when live
  spend is disabled, or via the documented no-finite-budget fallback. Intelligence's
  existing headroom logic (`max(0, budget − spend)`, cloud excluded above headroom,
  local never headroom-capped) then withholds cloud once spend meets the budget —
  **no Intelligence engine change required.** The universal no-skill fail-safe runs
  before any of this.
- **No cache double-pricing, and the delta FAILS CLOSED (corrected in the rc.3
  correction pass):** the optional cost-log delta sums already-reconciled `costUsd`
  for cloud calls strictly after the snapshot's `through` instant (a row at
  `ts == through` is assumed in the snapshot and skipped; near-boundary overlap can
  only OVERSTATE spend, the safe direction). It no longer claims "cannot miss spend"
  by silently skipping rows: any post-through cloud call lacking a finite nonnegative
  cost, any row whose provider provenance is unknown, any parse/tail-truncation
  condition that could conceal a post-through row, or an unreadable ledger now sets
  the spend provider **unavailable / cloud-suppressed** (finite budget) instead of
  returning the base total as verified. A local ($0 marginal) row is skipped only
  when its provider is in the EXPLICIT configured local set. If the bounded tail read
  cannot prove it reaches back to `through_ms`, it fails closed rather than tail-skip.
- **Missing-cost reconciliation (corrected in the rc.3 correction pass):** for each
  daily row the nonnegative-integer sum of `missingCostByModel` must EQUAL
  `missingCostEntries`; any deficit, surplus, negative, fractional, or malformed
  count is unattributed/invalid and fails the snapshot closed (one proven local row
  can no longer silently absorb other unexplained missing rows).
- **Fingerprint binds every trust field (corrected in the rc.3 correction pass):**
  the canonical fingerprint now covers `generated_at_ms` / `generated_at` (so a
  hand-edit to bypass staleness drifts the fingerprint), `local_providers`, and the
  local missing-cost attribution map. The consumer additionally cross-checks the
  snapshot's `local_providers` against the plugin's OWN configured local set (exact
  normalized match) and fails closed on mismatch — the snapshot's self-declared local
  set is never trusted to decide local-vs-cloud classification. The fingerprint is a
  PUBLIC checksum (drift/tamper evidence, not authentication); authenticity is the
  deployment-owned 0600 file under a 0700 directory the plugin only ever reads.
- **Generator window (corrected in the rc.3 correction pass):** the generator passes
  `--days` (floor 35) to `openclaw gateway usage-cost` — the tool defaults to 30 days,
  which can omit day 1 of a 31-day policy month — and still filters to the owner
  policy month, so older rows the wider window returns are discarded, never summed.
- **Empirical:** the generator produced a valid snapshot from live data —
  September MTD **$23.13** cloud, 16 days, cloud-missing **0**, local-missing **36**
  (`ollama/glm4:9b`). $23.13 already exceeds the ~$8.33 amortized budget, so cloud is
  withheld and local-capable routes remain.

**Also fixed:** `skillRouting.skillRequirements` was read by the code but **rejected
by config validation** (absent from the manifest `configSchema`, which is
`additionalProperties:false`). It is now in the schema, so the Graph/Zoom capability
floors are actually settable. Verified with `openclaw config validate` on the
distributable example (`valid: true`).

**Tests:** `tests/cloud-spend-snapshot.test.js`, `tests/spend-coordinator.test.js`,
`tests/spend-generator-args.test.js`, and `tests/skill-platform-recipes.test.js` —
the builder/loader/provider fail-closed matrix (local-vs-cloud missing costs,
month/timezone/freshness/future/negative/drift/pair, missing-cost reconciliation,
fingerprint binding of freshness + local-provider fields, config↔snapshot
local-provider cross-check), the budget-exhaustion sentinel, the delta fail-closed
matrix (unpriced cloud / unknown provenance / unparseable row / tail truncation /
unreadable ledger), the AUTHORITATIVE-spend precedence regression (caller zero cannot
reopen cloud after a valid or exhausted snapshot), the generator `--days` window, and
the deterministic platform intent recipes (Outlook→Graph, Zoom→Zoom).

---

## Gap 2 — snapshots expire but the generators are deploy-time only: CLOSED (candidate)

`scripts/togglelogic-runtime-refresh.mjs` + `src/maintenance/runtime-refresh.js`: a
durable, conservative, fail-closed stage the existing 4 AM job can call AFTER a
managed install to atomically refresh the paired inventory + spend snapshots and
write a sentinel. Six ordered stages, stop at first failure: `plugin_present`,
`feature_enabled` (read-only config check), `compatible_pair` (Intelligence
`validated_versions` + release-state parity), `inventory_generated`,
`spend_generated` (which fails closed on malformed usage / stale-month / unpriced
cloud), `committed` (atomic pair rename — both new snapshots validate or neither is
published). It does **not** bake a dev path into production (plugin root defaults to
its own install location) and never mutates the live config/gateway/schedule.

**Not activated.** The candidate one-line patch for `refresh_registry.sh`, the
sentinel shape, and install/rollback steps are in `docs/RUNTIME-STATE-REFRESH.md`.

**Tests:** `tests/runtime-refresh.test.js` (7) — sequencing, fail-closed skip +
cleanup, throwing stage, and the compatible-pair matrix. Empirically dry-run end to
end against live data: 6/6 stages ok, 57 eligible skills + $23.13 spend, atomic
commit, sentinel `overall: success`.

---

## Gap 3 — the gateway proof was historical/manual: CLOSED (genuinely automated)

`scripts/isolated-gateway-probe.sh` step 7 no longer documents a manual run. It now
performs a REAL automated round trip: picks a collision-checked, non-live loopback
port (excludes the live gateway port; never `--force`), starts ONLY its own
`openclaw gateway run`, sends the actionable no-skill prompt **"Write a limerick
about pickles."**, and asserts:

- reply is EXACTLY `I don't have a skill that relates to what you're asking me to do.`
  (and no other assistant text leaked);
- exactly ONE `before_agent_reply` `no_skill_failsafe` audit row;
- ZERO `before_model_resolve` rows;

then kills only its own PID and removes only its own temp dir. It exits non-zero and
labels the round trip UNPROVEN if it cannot prove it. **Run result: exit 0, 7/7
checks proven, round-trip 2/2**, `durationMs: 17` with no API key present — the gate
handled the turn with zero provider model calls. No stray gateway process remained.

---

## Gap 4 — paired RC bump: DONE

Free **1.6.1-rc.3** / Intelligence **1.4.1-rc.3** across package identity,
manifest, `PLUGIN_VERSION`, changelogs, README/docs, `validated_versions`, and the
regenerated Intelligence BOM (29 files). The Intelligence classifier entrypoint is
byte-identical (`entrypoint_sha256` unchanged). Pair gate: **PASS (Intelligence
1.4.1-rc.3 + Free 1.6.1-rc.3)**.

**Honest blocker state (unchanged):** OpenClaw 2026.9.4 still exposes no hard
in-flight model-pass/token/cost abort, so unattended/global enforcement remains
blocked. Owner-only scoped canary is the next stage. `PUBLICATION_GATE.md` in the
Intelligence repo still records the owner's **1.3.0 / Free 1.5.1** private-release
approval — no new owner approval was fabricated for rc.3; that record must be
refreshed by the owner, not by this task.

---

## Mailbox-identity addition (SAM-HQ) — CLOSED

The final SAM-HQ mail gap: route a Gmail request to the right skill, and give the
bounded child the AUTHORITATIVE mailbox identity for the resolved skill so Al's
Microsoft 365 mailbox and SAM's own `clickitco@gmail.com` are never conflated. All
durable code + docs + tests on the uncommitted tree; **rc.3 identity preserved** (no
release-identity change; no package bytes changed beyond source/docs).

- **Deterministic, inventory-bound Gmail recipe (`gmail-mail`).** In
  `docs/examples/sam-hq-owner-policy.openclaw.json`: literal `gmail` **plus** an email
  action/object term → the installed **`gog`** skill (SAM's Gmail service), evaluated
  with the other platform recipes AFTER exact resolution and BEFORE the classifier.
  It routes the exact SAM address `clickitco@gmail.com` + an email term too (the
  address contains the `gmail` token). High-precision by construction: never fires on
  Outlook/M365 (Graph keeps those via `outlook-mail`), on generic Google
  Drive/Docs/Calendar, or on a platform-less email; inert → exact universal no-skill
  fail-safe when `gog` is absent; a request naming both `outlook` and `gmail` fails
  closed (ambiguous). A bare exact-address recipe was deliberately **not** added — it
  would be redundant with `gmail-mail` and could capture Drive/Sheets work that merely
  mentions the address (documented in `docs/examples/README.md`).
- **Bounded per-skill execution identity (`skillRouting.skillIdentities`).** New
  deployment-owned, sanitized, non-model-selected contract in
  `src/skill-routing/skill-contracts.js` (normalized in `src/config/normalize.js`,
  admitted by the manifest `configSchema`, passed in from `src/capabilities.js`). It
  attaches the authoritative mailbox/account + sender identity + send policy to the
  routed child, **keyed only to the verified resolved skill id**:
  - `microsoft-graph` → the OWNER's Microsoft 365 mailbox; compose/send as Al / on
    behalf of Al.
  - `gog` → SAM's own `clickitco@gmail.com`; SAM in SAM's own identity; never
    impersonate Al.
  - send policy: a specific owner instruction to send a NAMED message authorizes that
    exact send; a general write/compose/draft/reply request is draft-only until the
    owner confirms.
  The identity is injected into the child's system prompt (via `contractPrompt`) AND
  recorded, **credential-free**, in the audit/receipt (`execution_identity` on the
  `skill_routing` decision and the post-run usage audit). Because the identity is
  applied only to a skill present in the resolved route, a Graph identity can never
  cross onto a Gmail route (or vice versa), and no identity is ever supplied for a
  skill that did not resolve or for a lookalike id. Values are labels + policy
  sentences only — **no OAuth token/credential** is placed in config, the prompt, or
  the audit; the `gog` skill's Gmail tokens stay with the skill.
- **Honest limitation.** The identity is in the child prompt + audit/receipt metadata
  but NOT in the short user-facing execution footer (kept deliberately non-invasive,
  per the addition's own fallback clause). The mailbox address appears in the
  prompt/audit because the child must know which account it acts in — an account
  address, not a secret.
- **Tests:** `tests/skill-mailbox-identity.test.js` (16) — recipe precision +
  inert-when-absent + ambiguity; identity cannot-cross / not-for-unverified-skill;
  send policy; field sanitization/bounding; the GATE round trips (Outlook→Graph/Al,
  Gmail & the exact address→gog/SAM, generic Drive not captured, absent gog→fail-safe,
  ZERO classifier calls, NO send performed); and config-normalization survival.

---

## Checks run — all green

| Suite | Command | Result |
| --- | --- | --- |
| Free unit/integration | `npm test` | **329 pass / 0 fail** (was 313; +16 `tests/skill-mailbox-identity.test.js` for the Gmail recipe + per-skill mailbox identity) |
| Free quality gate | `npm run quality` | **PASS** (syntax + release-identity rc.3 + pack allowlist) |
| Spend generator (live) | `node scripts/generate-spend-snapshot.mjs … --days` | **PASS** — `--days 35`, Sept MTD $23.13, 16 days, cloud-missing 0, local-missing 36 (temp out; no live state touched) |
| Snapshot verify-load | `loadSpendSnapshot(… expectedLocalProviders:['ollama'])` | **ok: true**; config↔snapshot local-provider mismatch **fails closed** |
| Runtime refresh (live dry-run) | `node scripts/togglelogic-runtime-refresh.mjs` | **PASS** — 6/6 stages, atomic commit |
| Config example schema | `openclaw config validate` | **valid: true, 0 issues** (real 2026.9.4 schema; placeholders filled). Example now carries the **4** platform recipes (incl. `gmail-mail` → `gog`), the `skillRouting.skillIdentities` mailbox contract (added to the manifest `configSchema`), and **no `_comment` keys** — OpenClaw's strict root schema rejects unknown root keys, so annotations live in `docs/examples/README.md`. |
| Automated isolated gateway | `bash scripts/isolated-gateway-probe.sh` | **exit 0** (7/7 + round-trip 2/2, no stray PID) |
| Real local Gemma via gate | `node scripts/gemma-recipe-check.mjs` (gemma4:latest) | Outlook→`microsoft-graph` **0 classifier calls**; Zoom→`zoom-meetings` **0 calls**; poem→no-skill fail-safe **1 call** |
| Intelligence quality | `npm run quality` | **PASS** (manifest + BOM 29 files) |
| Intelligence canary | `npm run canary:skill-routing` | ran (`production_routing_changed: false`) |
| Release pair gate | `TOGGLELOGIC_FREE_PATH=… npm run release:quality` | **PASS (Intelligence 1.4.1-rc.3 + Free 1.6.1-rc.3)** |

---

## Release recommendation

- **rc.3 correction pass (independent re-review):** seven trust/bypass blockers in the
  initial rc.3 spend/routing work were reproduced and FIXED on the uncommitted tree —
  authoritative spend precedence (caller can no longer override the live snapshot; the
  `monthly_cloud_spend_usd` tool parameter removed), generator `--days` window,
  fingerprint binding of all freshness/trust fields + config↔snapshot local-provider
  cross-check, missing-cost attribution reconciliation, delta fail-closed (no silent
  skip), and deterministic platform intent recipes. All gates re-run green (table
  above). Details in CHANGELOG "rc.3 correction pass" and the Gap 1 bullets.
- **Scoped owner canary (Al's SAM Telegram DM, account `default`): GO — re-affirmed
  ONLY after the correction pass** above, with the live spend snapshot generated by the
  durable refresh stage (or manually) and the scoped example config
  (`docs/examples/sam-hq-owner-policy.openclaw.json`). All rc.2 blockers stay closed;
  the spend ceiling is live and fails closed; explicit-platform prompts resolve
  deterministically without relying on the local classifier. Not installed live.
- **Global / unattended release: NO-GO** until OpenClaw adds a subagent
  model-token/pass cap + in-flight abort. The plugin must not claim a runtime token
  ceiling it cannot enforce.
- **Versioning:** keep the paired identifiers **Free 1.6.1-rc.3 / Intelligence
  1.4.1-rc.3**. No tag/publish/commit was performed.

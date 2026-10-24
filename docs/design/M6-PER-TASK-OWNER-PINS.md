# M6 design — Per-task owner pins

Status: **design — owner rulings applied; ready to build** (revised 2026-10-24;
original draft 2026-10-23). Target: **ToggleLogic Free 2.3.0** (minor). Baseline:
**Free 2.2.1** (`v2.2.1` = `0bdd628`; routing core unchanged since `v2.2.0`).
This document is design only — no code change ships with it.

Related designs: [M1 — Host adapters and the decision API](M1-HOST-ADAPTERS-AND-DECISION-API.md)
(decision order, Decision API v1 shapes); [M2 — Tamper-evident audit log](M2-AUDIT-LOG.md)
(audit record shape, field allowlists, the v2 audit chain that lands later in
2.5.0). Roadmap row: [ROADMAP.md](../ROADMAP.md) §M6 and the 2.3.0 release-table
row. State-file schema: [schemas/owner-pins.v2.schema.json](schemas/owner-pins.v2.schema.json).

---

## Owner decisions (plain words)

Al's rulings of 2026-10-24, in plain words. The engineering detail is in the
sections below and the resolved-questions list in §10.

- **The owner is in charge.** If the owner picks a model in chat (a `/model`
  pick), that choice wins over every pin. A skill can never override the owner's
  pins.
- **Then the owner's pins.** A pin set for the current task applies; if there is
  none, the all-tasks pin applies. A task pin beats the all-tasks pin (§4.4).
- **Below the pins:** a skill's requested model, then the configured route.
- **Behavior change from 2.2.x.** An explicit `/model` pick now beats an active
  all-tasks owner override. In 2.2.x the override won. This is stated loudly in
  the CHANGELOG and the README at release. The override still beats a skill's
  request selection and the configured route — that part is unchanged.
- **Host-contract note.** On a host where several people may chat, every allowed
  chat user's `/model` pick counts as the owner's. A host that needs otherwise
  must not mark such picks `source: "user"`.
- **Free never recommends a model.** Choosing the model is the owner's job.
  Model *recommendations* (benchmarks, multiple-choice) are a licensed
  ToggleLogic Intelligence capability and are not part of Free. The only pointer
  Free carries is a single line printed by the `togglelogic-pin` CLI (§4.3); it
  never appears in chat replies, decision responses, audit or routing logs, or
  errors, and it is omitted when a licensed layer is configured.
- **All engineering questions are resolved** (§10); this design is ready to
  build.

## 1. Problem and the owner's direction

Today an owner who wants a specific model has exactly one lever: the **all-tasks
owner override** (`src/routing/owner-override.js`). It is binary and global —
one model, applied to every turn, with no indication in the decision or the
audit record of *which* task it was meant for. An owner who pins a strong model
for one job (say inventory reconciliation) silently forces that same model onto
unrelated chat turns, and nothing on the decision tells the host that a global
pin is the reason. There is no scoped pin, and the override's presence is
invisible unless someone reads the state file.

Al's direction (2026-10-20 and 2026-10-23, finalized 2026-10-24):

- A pin should be **remembered for its task only** — set once for a labelled
  job, it applies to that job and never leaks onto other tasks. Unlabelled turns
  never match a task pin.
- Pin state must be **visible on every decision** so the host can show the owner
  what is pinned, to what, and why — including the case where a pin exists but
  was *not* applied.
- The **all-tasks override stays**, but becomes an *explicit* scope that
  **requires an expiry** at set time (a global pin should not be forever by
  accident). An all-tasks pin set without an expiry is rejected loudly. An
  already-existing all-tasks file without an expiry keeps working and is reported
  as held.
- A pin target may be an **exact model** or a **model family**; a family resolves
  to the newest configured member, and failure to resolve fails **loudly**.
- Free ships a **small CLI** to set/clear/list pins. The routing hook still only
  reads; the CLI is the only writer.
- Task-pin expiry is **optional**: a task pin holds until cleared unless the
  owner gives one.

The engine stays host-agnostic: no host, skill, or customer names appear in code
or examples. Examples below use a neutral label, `inventory-sync`.

---

## 2. Current behavior, from source (Free 2.2.1)

### 2.1 Decision order — `src/core/decide.js`

`decide()` applies selections in this exact order (`decide.js:136`–`229`;
restated in the file header `decide.js:9`–`16` and in M1 §4.3):

| Step | Selection | Source |
|---|---|---|
| 1 | Governed escalation pre-check | `decide.js:141` |
| 2 | **Owner override** | `decide.js:145`–`153` (`resolveOwnerOverride`) |
| 3 | Protected user selection (`requested.source === "user"`) | `decide.js:183` |
| 4 | Request selection (`requested.source === "request"`) | `decide.js:192` |
| 5 | Early failover of the pending model | `decide.js:203` |
| 6 | Mode dispatch (`configured` route lives here) | `decide.js:213` |
| 7 | Governed escalation post-check | `decide.js:215` |
| 8 | Failover of the selected model | `decide.js:225` |

**The owner override today sits at step 2 — ABOVE protected user selection
(step 3) and request selection (step 4).** In 2.2.1 an active owner override
therefore beats an explicit user or request model pick.

**2.3.0 changes this.** Owner pins — task and all-tasks alike — move to a single
tier that sits **below** protected user selection and **above** request
selection and the configured route (§10, Q1/Q2 resolved). The new `decide()`
order is in §4.1. The consequence: an explicit `/model` pick now beats an active
all-tasks owner override, where 2.2.x had the override win. The override still
beats a skill's request selection and the configured route. This behavior change
is stated loudly in the CHANGELOG and the README at release.

The configured per-task route is resolved inside mode dispatch
(`modes.js:65`–`77`, mode `configured`), i.e. at step 6 — below everything
above it.

### 2.2 Owner-override state file — `src/routing/owner-override.js`

- **Shape** (`owner-override.js:46`–`56`): a single JSON object with `active`
  (bool, required), `model_ref` ("provider/model", required), optional
  `provider_override`, and opaque `set_by` / `set_at_ms` / `reason` /
  `family_input` fields passed through for audit only.
- **One file, one path.** Config `ownerOverride.statePath`, default
  `~/.openclaw/togglelogic/owner_model_override.json` (`normalize.js:17`,
  `:80`). Read via `statSync` + `readFileSync` (`owner-override.js:112`, `:136`).
- **TTL rules** (`ttlVerdict`, `owner-override.js:79`–`88`):
  - `expires_at_ms` **absent** → `"apply"` — holds until `active:false` or the
    file is removed (backward-compatible, pre-1.0.5 behavior).
  - finite future deadline → `"apply"` until the deadline.
  - finite past deadline → `"expired"` → not applied, quiet (normal TTL).
  - **present but not a finite number** (string/null/NaN/object) → `"malformed"`
    → **fail-closed**: the override is rejected and a structured
    `rejected: "malformed_expires_at_ms"` is returned so the caller emits one
    loud audit event (`owner-override.js:139`–`144`; decision Al 2026-07-14).
  - Unreadable file / malformed JSON → **fail-open** to the classifier
    (`owner-override.js:169`–`171`); never throws into the hook.
- **mtime cache** (`owner-override.js:95`–`132`): a per-process map keyed by
  resolved path, holding `{ mtimeMs, result }`. One `statSync` per request; the
  read+parse only runs when the file changes, so a write takes effect on the
  very next request with no gateway restart. On a cache hit a live (future
  deadline) result is re-checked against the clock so it can lapse to expired
  without a file change (`owner-override.js:128`). A malformed file is never
  cached as applied, so its loud rejection is emitted once per file version.
- **The module NEVER writes** (`owner-override.js:20`–`25`): "this plugin NEVER
  writes the state file"; whatever sets/clears it "lives outside this plugin."
  §4 changes this principle precisely (see §4.3).

### 2.3 The ask handler — `src/adapters/openclaw/owner-override-ask.js`

A `message_sending` handler (`owner-override-ask.js:37`) that, on a substantive
outbound turn, reads the active override (`resolveOwnerOverride`, `:48`) and
hands the consumer a generic payload (`override_model`, `set_by`, `set_at_ms`,
`family_input`, `owner-override-ask.js:51`–`58`). Observe + notify only; never
rewrites outbound. It reads the same single state file — §4 keeps it working by
resolving the **`all` scope** for it.

### 2.4 Configured routes and task labels — `src/routing/modes.js`, `normalize.js`

- `configuredTaskLabel(event, hookContext)` (`modes.js:171`–`187`) reads the
  first non-empty of exactly six structured fields: `hookContext.taskType`,
  `hookContext.task`, `hookContext.capability`, `event.taskType`, `event.task`,
  `event.metadata.taskType`. It **trims** the value (`modes.js:186`) but does
  **not lowercase** it. Prompt text is never read.
- `pickConfiguredRoute` (`modes.js:156`–`169`) looks up
  `configuredRoutes[taskKey]` with the trimmed (not lowercased) label, falling
  back to `configuredRoutes.default`.
- `normalizeConfig` keeps `configuredRoutes` entries whose value is a non-empty
  string (`normalize.js:77`) — it does **not lowercase the keys** either.
- A route value beginning `family:` is detected (`modes.js:68`) and today
  **passes through** with reason `"family aliases require ToggleLogic
  Intelligence"` — a no-op. Note `openclaw.plugin.json`'s `configuredRoutes`
  value pattern is `^[^/\s]+/[^/\s]+$` (plugin.json:15), which **rejects**
  `family:<name>` (no slash) at host config validation; §5 widens it.

Net: label matching today is **trim-only and case-sensitive**. §3.5 specifies
lowercase+trim for both pin lookup and configured routes, which is a behavior
change flagged in Q4.

### 2.5 Family resolution — `src/routing/lineage-resolver.js`

`resolveLineage` (`lineage-resolver.js:40`–`49`) filters a catalog to the
allowed+matching models with a valid release date, sorts newest-first
(`:45`, `releaseDate` desc then ref asc), and returns the newest configured
child with reason `"newest-configured-release"`; if no dated candidate, the
first allowed match in configured order (`"configured-order-no-release-date"`);
else `"no-configured-child"`. `createLineageResolver` (`:51`–`64`) walks the
configured fallback lineages and records `skipped` resolutions. `validLineage`
(`:12`–`16`) accepts a `provider/*` glob or a ref whose derived lineage equals
itself. This is the same resolver §5 reuses for pins.

### 2.6 Audit, replay, response

- **Audit** (`src/audit/audit-events.js`): `AUDIT_SCHEMA =
  "togglelogic-audit/v1"` (`:31`); `EVENTS.ROUTING_DECISION`
  (`:82`). The owner-override decision emits a `ROUTING_DECISION` success with
  `principal.source: "owner"` and `details.mode: "owner_override"`
  (`decide.js:151`).
- **Replay** (`src/core/replay.js`): `owner_override` is listed in
  `NOT_REPLAYABLE` (`replay.js:33`) because owner state "is not in the log";
  replay forces `ownerOverride.enabled:false` (`:89`). `task_label_not_logged`
  (`:98`) already covers configured-mode records that carry no label.
- **Response** (`docs/design/schemas/decision-response.v1.schema.json`):
  `additionalProperties:false` (`:6`); the `reason` enum (`:23`) lists
  `owner_override`, `user_selection`, `request_selection`, `configured`, … .
  Adding a `pins` block and new reasons is additive (M1 §4: additive keeps
  `v1`), but requires editing this schema.

---

## 3. State-file schema v2

Published draft: [schemas/owner-pins.v2.schema.json](schemas/owner-pins.v2.schema.json).

### 3.1 One file, many scopes — and why

**Decision: keep ONE state file holding every scope** (a `pins` map keyed by
scope), rather than one file per task. Justification against the three axes the
brief names:

- **Atomicity.** The existing `ownerOverride.statePath` is one path with one
  atomic contract. A single file keeps the drop-in migration (§3.2) and lets the
  CLI replace the whole document with one temp+rename (`state-store.js:38`–`50`
  idiom), so a reader never sees a partial document. Set/clear of one pin is a
  read-modify-write of the whole doc, committed atomically.
- **Cache.** The hot path reuses the existing mtime cache unchanged: **one
  `statSync` per decision, one read+parse on change**, serving every scope. One
  file per task would multiply the cache to one entry per label and add a
  directory scan for "what pins exist." A single file preserves the current cost
  model exactly.
- **Concurrent writers.** The CLI is the **only** writer (the hook never
  writes). A single file turns set/clear into a read-modify-write, whose only
  hazard is two concurrent CLI runs clobbering each other (lost update). This is
  handled by an exclusive lock around the RMW (§4.3) — cheap, because pin edits
  are rare, owner-driven, and interactive. One file per task would avoid the RMW
  race but at the cost of the migration, the single-watch host contract, and the
  single-stat hot path — a worse trade for a rare write.

A single file also gives the host exactly one artifact to watch and ship, and
keeps the `all` scope and the ask handler (§2.3) reading the same place they do
today.

### 3.2 The v2 shape

```json
{
  "schema": "togglelogic-owner-pins/v2",
  "pins": {
    "all": {
      "active": true,
      "family": "google/gemini-3.5-*",
      "set_by": "togglelogic-pin",
      "set_at_ms": 1780000000000,
      "expires_at_ms": 1780086400000,
      "reason": "owner all-tasks pin"
    },
    "task:inventory-sync": {
      "active": true,
      "model_ref": "anthropic/claude-opus-4-8",
      "set_by": "togglelogic-pin",
      "set_at_ms": 1780000500000
    }
  }
}
```

- Scope keys: `all`, or `task:<label>` where `<label>` is the **normalized**
  (lowercase, trimmed — §3.5) host task label.
- Each pin carries **exactly one of** `model_ref` (exact "provider/model") or
  `family` (a lineage accepted by `validLineage`), plus `active`, `set_by`,
  `set_at_ms`, optional `provider_override`, optional `reason`, optional
  `expires_at_ms`.
- `expires_at_ms` keeps the v1 semantics verbatim (§2.2): absent → holds;
  finite future → holds until then; finite past → expired (quiet); present but
  non-finite → **malformed → fail-closed loud**. The CLI additionally **refuses
  to write an `all` pin without an expiry** (§4) — a set-time guard, not a
  read-time rule.

### 3.3 Migration from v1

A file lacking both `schema` and `pins` but carrying a top-level `active` +
`model_ref` is a **v1 file** (`owner-override.js:46`–`56` shape). It is read as a
single **`all`-scope** pin:

- Honored exactly as today; applied via the same TTL verdict.
- Reported **held** on every decision (§4.2 `pins.all`).
- If it has no `expires_at_ms`, it is still honored (backward-compatible, per
  the ruled scope) and reported with `no_expiry: true` so the host can surface
  "global pin, no expiry." The `all`-expiry-required rule applies only to **new**
  sets through the CLI; it is never retroactively enforced against an existing
  file.
- The resolver detects v1 vs v2 by the presence of the `pins` key. It never
  rewrites a v1 file; the owner migrates by running `togglelogic-pin set` once
  (which writes a v2 file) or by clearing it.

### 3.4 selection reasons and details — exact values

New `selectionReason` values (added to the response enum and the replay/audit
vocabularies):

| Scope applied | `selectionReason` | `selectionDetails` |
|---|---|---|
| `task:<label>` pin, exact ref | `task_pin` | `{ matched_rule: "task_pin", scope: "task:<label>", pin_target: "model", resolved_ref }` |
| `task:<label>` pin, family | `task_pin` | `{ matched_rule: "task_pin", scope: "task:<label>", pin_target: "family", family, resolved_ref, resolution_reason }` |
| `all` pin (v2 or migrated v1) | `owner_override` | `{ matched_rule: "owner_override", scope: "all", pin_target, resolved_ref, no_expiry? }` |

The `all` scope **keeps** emitting `selectionReason: "owner_override"` unchanged
(§10, Q3 resolved). The scope is carried in the new `pins` block, not by a new
reason string, so every existing decision-API consumer keeps working. `task_pin`
is wholly new, so it breaks no existing consumer.

### 3.5 Label normalization — identical on both paths

Pin lookup and configured-route lookup **both** normalize the label with
`label.trim().toLowerCase()`:

- `configuredTaskLabel` (`modes.js:186`) gains `.toLowerCase()`.
- `normalizeConfig` lowercases+trims each `configuredRoutes` key
  (`normalize.js:77`) so stored keys match normalized labels. On a collision
  (two keys normalizing to the same scope) the engine keeps the last and emits a
  `FALLBACK_PLAN_CHECK`-style config warning (loud, not silent).
- The CLI normalizes the `<label>` argument identically before composing the
  `task:<label>` scope key, so a pin set for `Inventory-Sync` and a turn
  labelled `inventory-sync` match.

This is a **behavior change** for configured routes (today case-sensitive) —
Q4. Hosts that already emit lowercase task labels are unaffected; deployments
with mixed-case `configuredRoutes` keys would see matching change.

---

## 4. Decision flow, the response `pins` block, audit, replay

### 4.1 Where the pins resolve in `decide()`

A new resolver, `resolveOwnerPins(config.ownerOverride, { label, paths, clock })`,
replaces the single `resolveOwnerOverride` call and returns, for this turn:

- `task` — the pin for this turn's normalized label (or null if none / no
  label), with a TTL verdict and target resolution.
- `all` — the all-tasks pin (or null), with its verdict.
- a `rejected` reason when a scope is malformed (fail-closed, loud, once per
  file version — the §2.2 pattern, per scope).

`decide()` then applies **the most specific applicable pin**: an applicable
`task` pin wins over an applicable `all` pin (§4.4). The applied pin produces
the override exactly as the owner override does today (`overrideToDecision`,
`decide.js:63`–`69`), sets `selectionReason`/`selectionDetails` per §3.4, and
records.

**Decision order (resolved — §10, Q1/Q2).** Pins resolve as step 3 of
`decide()` — **below** protected user selection (`requested.source === "user"`,
the `/model` pick) and **above** request selection (`requested.source ===
"request"`, a skill's `request_selection`), early failover, and mode dispatch
(the configured route). The full order is:

1. governed escalation pre-check
2. protected user selection (`requested.source === "user"`)
3. **owner pins — task pin, else all-tasks pin** (both scopes share this tier;
   task beats all, §4.4)
4. request selection (`requested.source === "request"`)
5. early failover
6. mode dispatch (configured route)
7. governed escalation post-check
8. failover

So a skill can never override an owner pin, and the owner's own `/model` pick
overrides every pin. On a host where several people may chat, every allowed chat
user's `/model` pick counts as the owner's; a host that needs otherwise must not
mark such picks `source: "user"`.

### 4.2 The `pins` block — carried on EVERY decision

Added to the `DecisionResponse` (and to the routing-log record and the audit
`ROUTING_DECISION` details, subject to the M2 allowlist):

```json
"pins": {
  "labelSeen": "inventory-sync",
  "task": {
    "scope": "task:inventory-sync",
    "status": "applied",
    "reason": "applied",
    "pin_target": "model",
    "model_ref": "anthropic/claude-opus-4-8",
    "resolved_ref": "anthropic/claude-opus-4-8",
    "set_by": "togglelogic-pin",
    "set_at_ms": 1780000500000,
    "expires_at_ms": null
  },
  "all": {
    "scope": "all",
    "status": "not_applied",
    "reason": "outranked_by_task_pin",
    "pin_target": "family",
    "family": "google/gemini-3.5-*",
    "resolved_ref": "google/gemini-3.5-flash",
    "set_by": "togglelogic-pin",
    "set_at_ms": 1780000000000,
    "expires_at_ms": 1780086400000
  }
}
```

- `status` ∈ `applied` | `not_applied`. When `not_applied`, `reason` ∈
  `expired`, `unavailable` (pinned model/family could not resolve to an
  available model), `outranked_by_user`, `outranked_by_request`,
  `outranked_by_task_pin` (for `all`), `no_label` (`task` only — the turn
  carried no label so no task scope could match), `malformed` (fail-closed),
  `inactive` (`active:false`).
- **A pin that exists for this task but was not applied is still reported**, with
  the reason — satisfying the ruled-scope requirement. `pins.task` is `null`
  only when no pin is configured for this label *and* no label was seen; when a
  label is seen but has no pin, `pins.task` is `null` and `labelSeen` carries the
  label so the host can offer to pin it.
- `resolved_ref` is the concrete model a family resolved to (§5), or equals
  `model_ref` for an exact pin. It is what the cost estimate (§5.3) prices.

### 4.3 The CLI writes; the hook never does

`bin/togglelogic-pin.js` (new; added to `package.json` `bin`). Commands:

```
togglelogic-pin set   --scope all|task:<label> (--model <ref> | --family <lineage>)
                      [--provider <p>] [--expires <ISO8601|+<duration>>] [--reason <text>]
                      --config <openclaw.json|plugin config.json>
togglelogic-pin clear --scope all|task:<label> --config <...>
togglelogic-pin list  [--json] --config <...>
```

- **Config** is read the same way as `togglelogic-decide` (`pluginConfigFrom`,
  `togglelogic-decide.js:18`) to find `ownerOverride.statePath` (and to apply
  the same path resolution). The CLI resolves the state path, never guesses a
  home. **The config namespace stays `ownerOverride`** (same key, same
  `statePath`/`enabled`, `normalize.js:80`): v2 pins live in the same file the
  override uses today, so there is no config migration and an existing
  deployment's path keeps being read. "Owner-pins" is the feature's name, not a
  new config key.
- **Atomicity.** `set`/`clear` take an **exclusive lock** on
  `<statePath>.lock` (`open` with `O_CREAT|O_EXCL`, stale-lock timeout, removed
  in a `finally`), then read the file, mutate the one scope, and commit with a
  temp+rename in the same directory (`state-store.js` idiom; mode `0600`). The
  lock serializes concurrent CLI runs so no set/clear is lost. The hook reads
  without the lock (a rename is atomic to a reader).
- **Schema-validated.** The written document is validated against
  `owner-pins.v2.schema.json` before the rename; an invalid write aborts
  non-zero with a message and leaves the file untouched.
- **`all` requires an expiry.** `set --scope all` **without** `--expires` exits
  non-zero with a loud message and writes nothing (ruled scope; proof in §8).
  `--expires` accepts an absolute ISO 8601 time or a `+<duration>` (e.g.
  `+72h`) relative to the injected clock.
- **Exit codes:** `0` success; `1` usage/validation error (bad scope, bad ref,
  missing `--expires` for `all`, unreadable config, lock timeout); `2` reserved.
  `list` prints a table (or `--json`) of every scope with target, resolved note
  (best-effort; the CLI may show `family (resolved at decision time)` rather than
  resolving live), set_by/at, expiry, and `no_expiry` flag for a migrated v1
  `all`.
- **Auditing set/clear without a second audit writer.** The CLI does **not**
  write the audit stream (that keeps one audit writer — important for the M2
  v2 chain in 2.5.0). Instead the plugin emits a one-shot `OWNER_PIN_CHANGE`
  audit event the first time a decision observes a new file version (the mtime
  cache already detects the change), carrying the scopes present and their
  set_by/set_at/expiry — so every set/clear is accounted for in the audit
  stream, by the single writer. A malformed/rejected scope emits
  `OWNER_PIN_REJECTED` once per version (the §2.2 loud pattern).
- **One recommendation pointer, CLI-only (Free never recommends a model).** Free
  does not recommend models — choosing the model is the owner's job; model
  *recommendations* (benchmarks, multiple-choice) are a licensed ToggleLogic
  Intelligence capability, out of scope for Free. The only pointer Free carries
  is a single plain line the CLI prints **after** its `set` and `list` output:
  `Want the best model recommended for each task? See ToggleLogic Intelligence —
  https://togglelogic.ai`. It appears **only** on CLI `set`/`list` stdout —
  never in chat replies, decision responses, audit or routing logs, or error
  output. The CLI **omits** the line when the resolved config shows a licensed
  layer already configured (detected from config only; the CLI never loads the
  licensed layer). No pricing, per the house rules.

**Principle update.** `owner-override.js`'s "this plugin NEVER writes
the state file" (`:20`) becomes precise: **the routing hook and resolver never
write; the package now ships a CLI that writes.** The doc comment and the
module's independence note are updated to say so; the hot path's read-only
property is unchanged.

### 4.4 Task pin vs all-tasks override — relative order, justified

**Task pin ranks ABOVE the all-tasks override.** Specificity decides: a
`task:<label>` pin is a narrower, more deliberate statement ("for *this* job use
X") than a global `all` pin ("for *everything* use Y"). If both are active and
the turn's label matches the task pin, the task pin applies and the `all` pin is
reported `not_applied / outranked_by_task_pin`. For a turn whose label matches
no task pin (or carries no label), the `all` pin applies. This is the only
ordering that makes a task pin meaningful in the presence of a global pin, and
it matches the configured-route precedence intuition (a matched label route
beats the `default` route, `modes.js:158`).

**Cross-ref — where this tier sits.** The pin tier as a whole is step 3 of
`decide()` (§4.1): below the owner's own `/model` pick and above a skill's
request selection and the configured route. §4.4 governs only the task-vs-all
ordering *within* that tier — task beats all — and is unchanged by the R1
ruling.

### 4.5 Replay — decision

**Decision: log the full `pins` snapshot in every routing record (for audit and
human/auditor verification), and keep automated `replay` marking pin-driven
records NOT replayable, with precise reasons.** Rationale:

- The snapshot on each record means an auditor can *see* exactly what was pinned
  and why it did/didn't apply, at decision time — the observability the ruled
  scope wants.
- But `replay` deliberately runs with **no live state, no seam, no availability**
  (`replay.js:88`–`90`). A family pin's `resolved_ref` depended on the catalog
  and provider availability at the time, which the log does not reproduce;
  re-resolving would guess. Consistent with how `owner_override`,
  `provider_unavailable`, and `intelligence` are already treated
  (`replay.js:31`–`39`), pin records are counted, not re-run.
- New `NOT_REPLAYABLE` reason: `task_pin: "task-pin state is not reconstructed
  by replay"`. The `all` scope keeps emitting `owner_override` (§3.4; §10, Q3),
  which is **already** in `NOT_REPLAYABLE` (`replay.js:33`), so no new reason is
  needed for it. (Exact-ref pin replay is **deferred** — §10, Q5: the snapshot
  is logged, but pin records stay not-replayable with precise reasons; re-running
  an exact-ref pin from the snapshot is a possible future enhancement, not built
  in 2.3.0.) `replay` continues to force the pin resolver off, as it does for the
  override (`replay.js:89`).

---

## 5. Family resolution, failover, cost

### 5.1 Resolving a family pin

A pin whose target is `family` resolves through the **existing**
`createLineageResolver` / `resolveLineage` (`lineage-resolver.js:40`–`64`): the
newest configured+allowed member with a valid release date wins
(`"newest-configured-release"`), else configured order
(`"configured-order-no-release-date"`). The resolved child becomes
`resolved_ref`; `resolution_reason` is carried in `selectionDetails` and the
`pins` block. The same resolver serves **configured per-task routes** that name
a `family:<name>` value (§2.4) — §5.2.

### 5.2 Configured `family:` routes

`modes.js:68` currently makes a `family:` configured route a no-op passthrough.
In 2.3.0, `configured` mode resolves a `family:<lineage>` route through the same
resolver to the newest configured member, mirroring a family pin. Two edits are
required beyond the mode logic: (a) `openclaw.plugin.json`'s `configuredRoutes`
value pattern (`plugin.json:15`, today `^[^/\s]+/[^/\s]+$`) must also accept
`^family:[a-z0-9][a-z0-9._-]*(/\*)?$`; (b) `normalizeConfig` keeps `family:`
values (it already keeps any non-empty string, `normalize.js:77`). A
`family:<lineage>` that fails `validLineage` is dropped with a loud config
warning, not silently kept.

### 5.3 Failover and loud failure

- When a pinned exact model's provider is unavailable, the existing failover
  path (`decide.js:155`–`179`) runs after the pin sets the pending model: the
  lineage resolver finds the newest available configured member, and the
  decision reports `provider_unavailable` with the resolved child — **loud**, in
  the audit and the `pins` block (`status: not_applied, reason: unavailable`
  for the original pin target, plus the failover record).
- When a **family** pin resolves to **nothing** available (no configured child,
  or all unavailable), the decision is `fallback_unresolved`
  (`decide.js:164`–`169`) — never a silent drop. The `pins` block carries
  `status: not_applied, reason: unavailable`, and the usage-events +
  fallback-logger loud path fires (`decide.js:96`–`101`).

### 5.4 Cost governance interaction

Cost is unchanged and keeps the house rules (dollars, unpriced visible, never
`$0`). `estimate()` (`decide.js:105`–`120`) prices **the ref that will actually
run** — for a pin that is `resolved_ref` (the family child or the exact model).
If that model is outside the price catalog or unpriced, `costEstimate` reports
`priced:false` with a reason (`decide.js:110`–`119`), exactly as today. No new
cost code; the pin only changes *which* ref is priced.

---

## 6. Host contract (engine wording only)

What a host shows the owner, and how it drives pins — no host/skill/customer
names, generic throughout:

- **Show, every turn:** read `response.pins`. If `pins.task.status == "applied"`
  or `pins.all.status == "applied"`, show "pinned to `resolved_ref` for
  `scope`" with set_by/when and expiry. If a pin exists but `status ==
  "not_applied"`, show it greyed with the `reason` (expired / unavailable /
  outranked / no_expiry). `labelSeen` tells the host which task this turn was.
- **Offer to pin:** when `labelSeen` is set and `pins.task` is `null`, the host
  may offer "pin a model for `<label>`," calling `togglelogic-pin set --scope
  task:<label> --model <ref>` (or `--family`).
- **Set / clear / list:** the host invokes the CLI (§4.3). For an all-tasks pin
  it must pass `--expires`; the CLI refuses otherwise and the host surfaces the
  loud error. `list --json` backs a "what's pinned" view.
- **The host never writes the state file directly** — it goes through the CLI so
  the atomic-write, schema-validation, and all-expiry guard are enforced in one
  place.

The exact CLI/field contract for host integrators is carried separately; this
doc defines the engine surface only.

---

## 7. Capability gates and health

A host that sends **no task labels** gets only the `all` scope and the declared
default — a documented limitation (ROADMAP M6 risk). It is made visible:

- A capability gate `taskPins`, registered alongside the others
  (`register.js:46`–`47`, `:56`): `{ id: "taskPins", enabled:
  <ownerOverride enabled>, ready: true, reason: <see below> }`. Reasons:
  `"no-task-labels-seen"` (enabled, but no labelled turn observed yet),
  `"active"` (labelled turns seen / task pins configured), `"disabled"`
  (`ownerOverride.enabled !== true`).
- The gate's `reason` flips from `no-task-labels-seen` to `active` the first
  time a decision observes a non-null `labelSeen`, so an operator can tell at a
  glance whether per-task routing is actually reaching the engine (a real gap:
  a deployment can run indefinitely with zero labelled turns and never benefit
  from configured routes or task pins, with nothing today making that visible).
- Per-decision, `pins.labelSeen == null` is the turn-level signal of the same
  condition; the gate is the aggregate.
- `OWNER_PIN_CHANGE` / `OWNER_PIN_REJECTED` audit events (§4.3) make set/clear
  and malformed state observable in the audit stream.

---

## 8. Test plan (mapped to ROADMAP M6 proofs)

Constraints: Free tests run under `node --test` and **must not spawn npm**
(`package.json` `scripts.test`); CLI tests invoke the bin entry as a module or a
`node` subprocess, never `npm`. Any `*.jsonl` fixture must be force-added
(`git add -f`) because `.gitignore` excludes `*.jsonl` (`.gitignore`), except
under `tests/fixtures/` where `routing.jsonl` is already tracked.

ROADMAP M6 proofs:

1. **A pin on task A never changes task B.** `tests/owner-pins.test.js`: set
   `task:a`; a turn labelled `b` resolves without the pin (`pins.task` null,
   mode route unchanged); a turn labelled `a` applies it. An **unlabelled** turn
   never matches a task pin.
2. **The pin is visible on every decision.** Assert `response.pins` is present
   on every path — applied, not-applied (each `reason`), and no-pin — including
   when a pin exists but is outranked or expired.
3. **A family route resolves the newest configured member and fails over
   loudly.** Reuse `lineage-resolver.test.js` fixtures: a family pin resolves to
   the newest dated child; with that provider unavailable it fails over
   (`provider_unavailable`) to the next; with nothing available it is
   `fallback_unresolved` — assert the loud usage-event + audit, never a silent
   model.
4. **All-tasks override without an expiry is rejected at set time; an existing
   one is honored and held.** CLI test: `set --scope all` without `--expires`
   exits non-zero and writes nothing; a pre-seeded v1 file (no expiry) is honored
   and reported `pins.all.status: applied, no_expiry: true`.

Additional:

5. **Label normalization** — `Inventory-Sync` pin matches `inventory-sync` turn;
   configured route key `Inventory-Sync` matches both; collision warning fires.
6. **v1 migration** — a v1 file reads as `all`, honored, reported held; is not
   rewritten; a CLI `set` turns it into a v2 file.
7. **Expiry edges** — absent (holds), future (holds then lapses on the injected
   clock with no file change, via the cache re-check), past (quiet not-applied).
8. **Malformed fail-closed** — `expires_at_ms` present but non-finite in any
   scope → that scope rejected, `OWNER_PIN_REJECTED` once per version, decision
   routes as if unpinned.
9. **Replay** — a routing log with `task_pin` records is counted under the new
   `NOT_REPLAYABLE` reason, and `all`-scope records (reason `owner_override`) stay
   counted under the existing `owner_override` not-replayable reason; non-pin
   records still replay; the logged `pins` snapshot is preserved in the record.
10. **Decision-API backward compatibility** — existing fixtures
    (`tests/fixtures/decision-matrix/`) still pass; `pins` is additive; a
    consumer ignoring `pins` is unaffected. Q3 is resolved: the `all` scope
    **keeps** emitting `selectionReason: "owner_override"` (scope carried only in
    the `pins` block), so assert the reason string is **unchanged** and no
    existing consumer breaks. `task_pin` is the only new reason.
11. **Decision order (R1).** A turn with an explicit `/model` pick
    (`requested.source === "user"`) overrides an active all-tasks pin **and** an
    active task pin (both reported `not_applied / outranked_by_user`). A skill's
    request selection (`requested.source === "request"`) does **not** override an
    applicable pin (task or all); the pin wins and the request is outranked. A
    task pin beats the configured route for the same label (Q6).
12. **Recommendation pointer is CLI-only (R2).** The `togglelogic-pin` CLI prints
    the single pointer line after `set` and after `list`, and **nowhere else** —
    assert it is absent from chat replies, decision responses, audit and routing
    logs, and error output. Assert the line is **omitted** when the resolved
    config shows a licensed layer configured (config-only detection; the CLI
    never loads the licensed layer). No dollar price appears in the line.
13. **CLI** — set/clear/list each scope; atomic write (temp+rename observed);
    schema validation rejects a bad ref; exclusive lock serializes two concurrent
    writers; exit codes.
14. **Ask handler** — `owner-override-ask.js` keeps working by resolving the
    `all` scope; a task-only pin does not trigger it.

Canary-host acceptance (release-time, not part of this doc): a labelled turn
pinned and visible on the decision; a second task unaffected; a family pin
failing over loudly; the `all`-without-expiry rejection; before/after routing
log and audit.

---

## 9. Implementation task breakdown (for CC; Codex candidate noted)

Rough sizes: S ≈ <½ day, M ≈ ~1 day, L ≈ ~2 days, each with tests.

| # | Piece | Size | Notes |
|---|---|---|---|
| T1 | `src/routing/owner-pins.js`: `resolveOwnerPins` (scopes, TTL per scope, v1→`all` migration, malformed fail-closed, per-scope mtime cache reusing the §2.2 pattern) | **L** | Core of the feature; CC. Extend, don't fork, the owner-override resolver. |
| T2 | `decide.js` wiring: replace the single override call, apply most-specific pin at the resolved pin tier (§4.1), set reasons/details (§3.4), build the `pins` block (§4.2) | **M** | CC. Order resolved (§10, Q1/Q2) — no longer gated. |
| T3 | Label normalization: `modes.js` lowercase, `normalize.js` lowercase keys + collision warning (§3.5) | **S** | CC. Behavior change, Q4 resolved: lowercase+trim both sides, loud collision warning, CHANGELOG note. |
| T4 | Family pins + `family:` configured routes via the existing resolver; `openclaw.plugin.json` pattern widening (§5.2) | **M** | CC. |
| T5 | `bin/togglelogic-pin.js` CLI: set/clear/list, exclusive lock, atomic write, schema validation, `all`-expiry guard, exit codes, **and the single CLI recommendation-pointer line** (§4.3, R2) | **L** | **Assigned to Codex** — self-contained, clear contract, bounded surface; stops at an open PR; CC reviews. Depends on the v2 schema (this doc) and T1's path resolution. |
| T6 | Response schema + `pins` block + the new `task_pin` reason in `decision-response.v1.schema.json` (the `all` scope keeps `owner_override`, Q3); audit events `OWNER_PIN_CHANGE`/`OWNER_PIN_REJECTED` + `controlsFor` entries | **S** | CC. |
| T7 | Replay: new `NOT_REPLAYABLE` reasons; preserve the `pins` snapshot in the record (§4.5) | **S** | CC. |
| T8 | `taskPins` capability gate + health reason flip (§7) | **S** | CC. |
| T9 | Tests (§8), docs (README/ROADMAP note, host-contract note), CHANGELOG, version bump to 2.3.0 in all three places (`package.json`, `openclaw.plugin.json`, `src/index.js` `PLUGIN_VERSION`), tag — **release step, CC only** | **M** | CC. Intelligence 2.1.2's validated-pairs list needs Free 2.3.0 added in its next release (below). |

Suggested order: T1 → T2 → T3/T4 → T6/T7/T8, with T5 (Codex) running in parallel
once T1's path resolution lands → T9. T2 is no longer gated — the decision order
is resolved (§10, Q1/Q2).

**Intelligence compatibility.** The licensed layer's accepted Free range is
`>=2.0.0 <3.0.0` (ROADMAP compatibility constraint), so 2.3.0 is in range and a
present licensed layer keeps working. A licensed-side follow-up to record 2.3.0
as a validated pairing is tracked privately, not here.

---

## 10. Resolved decisions (2026-10-24)

Every question in this section is **resolved**; the design is ready to build.
The question numbers are kept for traceability.

**Q1 — Decision order. RESOLVED (R1).** The owner is in charge: the owner's own
pick in chat (`/model`, `requested.source === "user"`) overrides every pin, and
a skill can never override the owner's pins. The `decide()` order is:

1. governed escalation pre-check
2. protected user selection (`requested.source === "user"`)
3. **owner pins — task pin, else all-tasks pin** (both scopes share this tier;
   task beats all, §4.4)
4. request selection (`requested.source === "request"`, a skill's
   `request_selection`)
5. early failover
6. mode dispatch (configured route)
7. governed escalation post-check
8. failover

**Behavior change vs 2.2.x — stated loudly in the CHANGELOG and the README:** an
explicit `/model` pick now beats an active all-tasks owner override (in 2.2.x the
override won). Unchanged: the override still beats a skill's request selection
and the configured route. **Host-contract note:** on a host where several people
may chat, every allowed chat user's `/model` pick counts as the owner's; a host
that needs otherwise must not mark such picks `source: "user"`. ROADMAP §M6 prose
is corrected to match.

**Q2 — Does the all-tasks override move with the task pin? RESOLVED (R1).** Yes.
The task pin and the all-tasks pin (including migrated v1 files) **share one
tier** at step 3, below protected user selection. The legacy `all` override no
longer holds a step-2 position above user/request. Within the tier, task beats
all (§4.4).

**Q3 — reason string. RESOLVED (R3).** The `all` scope **keeps** emitting
`selectionReason: "owner_override"`; scope lives in the new `pins` block, not in
a new reason string. There is **no** `owner_override_all` reason. `task_pin` is
the only new reason, and is additive.

**Q4 — case-insensitive label matching. RESOLVED (R3).** Lowercase **and** trim
both the `configuredRoutes` keys and the incoming task label (one consistent
rule). A key collision (two keys normalizing to the same scope) emits a loud
config warning; the behavior change is noted in the CHANGELOG.

**Q5 — replay of exact-ref pins. RESOLVED (R3) — deferred.** The `pins` snapshot
is logged on every record, but automated `replay` keeps marking pin-driven
records **not replayable**, with precise reasons (§4.5). Re-running an exact-ref
pin from the snapshot is not built in 2.3.0.

**Q6 — task pin vs configured route for the same label. RESOLVED (R3).** The
task pin **beats** the configured route for the same label: the owner's explicit
pin resolves at the pin tier (step 3), above mode dispatch (step 6). The owner's
pin wins over the static config.

**Q7 — `list` live resolution. RESOLVED (R3).** `togglelogic-pin list` shows the
family and notes "resolved at decision time"; it does **not** resolve a family
to its current child live. No live catalog in the CLI (keeps the CLI
dependency-light).

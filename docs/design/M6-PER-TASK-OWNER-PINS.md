# M6 design — Per-task owner pins

Status: **design draft for owner review** (2026-10-23). Target: **ToggleLogic
Free 2.3.0** (minor). Baseline: **Free 2.2.1** (`v2.2.1` = `0bdd628`; routing
core unchanged since `v2.2.0`). This document is design only — no code change
ships with it.

Related designs: [M1 — Host adapters and the decision API](M1-HOST-ADAPTERS-AND-DECISION-API.md)
(decision order, Decision API v1 shapes); [M2 — Tamper-evident audit log](M2-AUDIT-LOG.md)
(audit record shape, field allowlists, the v2 audit chain that lands later in
2.5.0). Roadmap row: [ROADMAP.md](../ROADMAP.md) §M6 and the 2.3.0 release-table
row. State-file schema: [schemas/owner-pins.v2.schema.json](schemas/owner-pins.v2.schema.json).

---

## 1. Problem and the owner's direction

Today an owner who wants a specific model has exactly one lever: the **all-tasks
owner override** (`src/routing/owner-override.js`). It is binary and global —
one model, applied to every turn, with no indication in the decision or the
audit record of *which* task it was meant for. An owner who pins a strong model
for one job (say inventory reconciliation) silently forces that same model onto
unrelated chat turns, and nothing on the decision tells the host that a global
pin is the reason. There is no scoped pin, and the override's presence is
invisible unless someone reads the state file.

Al's direction (D40 a, D41 a, D42 a on 2026-10-20; D50 a, D51 a on 2026-10-23):

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
- Free ships a **small CLI** to set/clear/list pins (D50 a). The routing hook
  still only reads; the CLI is the only writer.
- Task-pin expiry is **optional** (D51 a): a task pin holds until cleared unless
  the owner gives one.

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
(step 3) and request selection (step 4).** An active owner override therefore
beats an explicit user or request model pick. This fact drives Open Question
**Q1** in §10; the roadmap's own wording about where the override sits is
inconsistent with the source, and the intended 2.3.0 order must be confirmed
before anything is built.

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
  §4 changes this principle precisely (see D50 note there).

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
| `all` pin (v2 or migrated v1) | `owner_override_all` | `{ matched_rule: "owner_override_all", scope: "all", pin_target, resolved_ref, no_expiry? }` |

`owner_override_all` **replaces** the old `owner_override` reason for the
all-tasks scope. That is the one consumer-visible reason-string change in 2.3.0
and is called out in Q3 (the ruled scope promises existing consumers keep
working). `task_pin` is wholly new, so it breaks no existing consumer.

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
records. **Order relative to user/request selection is Q1 — not decided here.**

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

### 4.3 The CLI writes; the hook never does (D50 a)

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

**Principle update (D50 a).** `owner-override.js`'s "this plugin NEVER writes
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
- New `NOT_REPLAYABLE` reasons: `task_pin: "task-pin state is not reconstructed
  by replay"`, `owner_override_all: "owner-pin state is not reconstructed by
  replay"`. (An exact-ref pin is in principle deterministic from the snapshot;
  re-running it is a possible future enhancement, noted but not built in 2.3.0 —
  Q5.) `replay` continues to force the pin resolver off, as it does for the
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
9. **Replay** — a routing log with `task_pin` / `owner_override_all` records is
   counted under the new `NOT_REPLAYABLE` reasons; non-pin records still replay;
   the logged `pins` snapshot is preserved in the record.
10. **Decision-API backward compatibility** — existing fixtures
    (`tests/fixtures/decision-matrix/`) still pass; `pins` is additive; a
    consumer ignoring `pins` is unaffected; the `owner_override` → 
    `owner_override_all` reason change is asserted (and gated on Q3).
11. **CLI** — set/clear/list each scope; atomic write (temp+rename observed);
    schema validation rejects a bad ref; exclusive lock serializes two concurrent
    writers; exit codes.
12. **Ask handler** — `owner-override-ask.js` keeps working by resolving the
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
| T2 | `decide.js` wiring: replace the single override call, apply most-specific pin, set reasons/details (§3.4), build the `pins` block (§4.2); **gated on Q1 order** | **M** | CC. Do not start until Q1 is answered. |
| T3 | Label normalization: `modes.js` lowercase, `normalize.js` lowercase keys + collision warning (§3.5) | **S** | CC. Behavior change — land with Q4 confirmed. |
| T4 | Family pins + `family:` configured routes via the existing resolver; `openclaw.plugin.json` pattern widening (§5.2) | **M** | CC. |
| T5 | `bin/togglelogic-pin.js` CLI: set/clear/list, exclusive lock, atomic write, schema validation, `all`-expiry guard, exit codes (§4.3) | **L** | **Codex candidate** — self-contained, clear contract, bounded surface, stops at an open PR; CC reviews. Depends on the v2 schema (this doc) and T1's path resolution. |
| T6 | Response schema + `pins` block + new reasons in `decision-response.v1.schema.json`; audit events `OWNER_PIN_CHANGE`/`OWNER_PIN_REJECTED` + `controlsFor` entries | **S** | CC. |
| T7 | Replay: new `NOT_REPLAYABLE` reasons; preserve the `pins` snapshot in the record (§4.5) | **S** | CC. |
| T8 | `taskPins` capability gate + health reason flip (§7) | **S** | CC. |
| T9 | Tests (§8), docs (README/ROADMAP note, host-contract note), CHANGELOG, version bump to 2.3.0 in all three places (`package.json`, `openclaw.plugin.json`, `src/index.js` `PLUGIN_VERSION`), tag — **release step, CC only** | **M** | CC. Intelligence 2.1.2's validated-pairs list needs Free 2.3.0 added in its next release (below). |

Suggested order: T1 → (Q1) → T2 → T3/T4 → T6/T7/T8 → T5 (Codex, parallel once
the schema is fixed) → T9.

**Intelligence compatibility.** The licensed layer's accepted Free range is
`>=2.0.0 <3.0.0` (ROADMAP compatibility constraint), so 2.3.0 is in range and a
present licensed layer keeps working. A licensed-side follow-up to record 2.3.0
as a validated pairing is tracked privately, not here.

---

## 10. OPEN QUESTIONS FOR CLAUDE

**Q1 — Decision order (must answer before T2). The roadmap wording is
internally inconsistent with the source.**
Source today (`decide.js:145`–`192`): the owner override is at **step 2, ABOVE**
protected user selection (step 3) and request selection (step 4) — an active
override **beats** a user/request pick. ROADMAP §M6 says the task pin "sits above
the configured route and **below user/request selection** — **the same position
the owner override holds today**." Those two clauses contradict each other,
because the override does **not** sit below user/request today — it sits above.
The brief's stated order (governed → user/request → task pin → all-tasks
override → configured → mode) matches the "below user/request" clause.
**Behavior change implied if we adopt "below user/request":** a user's or
request's explicit model selection would **override an active all-tasks owner
pin**, which is the **reverse** of 2.2.x (where the owner override wins over a
user pick). That silently weakens every existing owner-override deployment.
Please rule: (a) pins (task + all) go **below** user/request (adopt the roadmap
prose; accept the override-weakening behavior change, and the existing
owner-override moves down too); or (b) pins stay **above** user/request (keep
today's override position; the roadmap prose is corrected). Not decided here.

**Q2 — Does the all-tasks override keep beating user/request, or move with the
task pin?** If Q1 is (a), confirm whether the *existing* all-tasks override
(incl. migrated v1 files) also drops below user/request, or whether only the new
task pin does and the legacy `all` override keeps its step-2 position for
backward compatibility. (The doc assumes task pin and `all` share one position,
chosen by Q1 — confirm.)

**Q3 — `owner_override` → `owner_override_all` reason string.** The all-tasks
scope will report `selectionReason: "owner_override_all"` (§3.4), not
`owner_override`. The ruled scope promises existing decision-API consumers keep
working. Is changing this one reason string acceptable, or must the `all` scope
keep emitting `owner_override` (with scope carried only in the new `pins`
block)? `task_pin` is new regardless.

**Q4 — Case-insensitive label matching is a behavior change for configured
routes.** §3.5 lowercases both the stored `configuredRoutes` keys and the
looked-up label (today trim-only, case-sensitive). Hosts that already emit
lowercase labels are unaffected, but a deployment with mixed-case route keys
would see matching change. Confirm we lowercase both sides
(recommended, for one consistent rule) and emit a loud collision warning.

**Q5 — Replay of exact-ref pins.** §4.5 logs the `pins` snapshot but keeps
automated `replay` marking pin records not-replayable (consistent with
`owner_override` today). An exact-ref (non-family) pin is deterministic from the
snapshot and *could* be re-run in replay. Worth building in 2.3.0, or defer?

**Q6 — Where does the task label come from when BOTH a configured route and a
task pin exist for the same label?** The doc applies the task pin above the
configured route (pin at the override tier, configured route at mode dispatch,
per §4.1/§4.4). Confirm a task pin should override a configured route for the
same label (expected), i.e. the owner's explicit pin beats the static config.

**Q7 — `list` live resolution.** Should `togglelogic-pin list` resolve a family
to its current child live (needs the pricing catalog + availability, i.e. host
wiring in the CLI), or only show the family and note "resolved at decision
time"? The doc assumes the latter (no live catalog in the CLI) to keep the CLI
dependency-light; confirm.

# Changelog

All notable changes to ToggleLogic (Free Tier) are documented here.

## 1.7.0-rc.3 — 2026-09-16 (owner-scoped canary; pairs with Intelligence 1.5.0-rc.3)

- Rejects an impossible token or cost plan before showing and persisting an
  owner model choice; an advertised route must be executable by the configured
  bounded-child preflight.
- Threads the global bounded-child cost ceiling into Intelligence as a planning
  constraint, while preserving any stricter per-skill ceiling.

## 1.7.0-rc.2 — 2026-09-16 (owner-scoped canary; pairs with Intelligence 1.5.0-rc.2)

- Explains when Recommended and Premium resolve to the same model and are
  combined, instead of leaving a two-choice marketplace unexplained.
- Clarifies that the recommended model has the best overall weighted result
  even when another eligible model leads one individual benchmark.

## 1.7.0-rc.1 — 2026-09-16 (owner-scoped canary; pairs with Intelligence 1.5.0-rc.1)

- Replaces three policy labels that could all resolve to the same model with an
  honest skill-specific marketplace: Economy, Recommended, and Premium routes
  are distinct durable model lineages when those alternatives are eligible.
- Shows each route's skill-specific advantage, trade-off, estimated workflow
  cost range, and the reason for ToggleLogic's recommendation.
- Collapses the prompt to one plainly labeled choice when only one eligible
  lineage exists; ToggleLogic no longer disguises one route as three choices.
- Keeps simple owner replies (`1`, `2`, or `3`) session- and sender-bound and
  persists the exact strategy and lineage shown for the current skill version.
- Separates planned routing from observed execution in owner receipts. A planned
  model is never described as the model actually used unless the completed child
  transcript supplies host-observed provider/model evidence.
- Retains the 1.6 owner-only scope, fail-closed skill boundary, bounded child,
  budget, privacy, and capability safeguards. Global and unattended enforcement
  remain unavailable pending the OpenClaw in-flight runtime safeguard.
- Makes the routed-child tool guard fail closed after a child session is
  positively identified. Internal guard errors now block the call, emit an
  immediate hashed audit/log entry, and appear in the post-run usage audit;
  unrelated non-child sessions still remain untouched.
- Replaces minimum-component tool ceilings on multi-skill work with an explicit
  bounded composite: unique component budgets add together but can never exceed
  the deployment-wide `maxChildToolCalls`. This prevents valid Graph+Zoom and
  presentation workflows from inheriting only the smallest component budget.

## 1.6.2 — 2026-09-16 (security-review metadata; pairs with Intelligence 1.4.2)

- Adds a permanent packaged security-review note documenting the plugin's
  bounded subprocess, pricing-network, local-state, and credential boundaries.
- Rebuilds the public artifact after ClawHub inconsistently marked 1.6.1
  suspicious even though the equivalent rc.13 runtime scanned clean and local
  validation reported zero issues.
- Routing behavior is unchanged from 1.6.1.

## 1.6.1 — 2026-09-16 (owner-scoped release; pairs with Intelligence 1.4.1)

- Promotes the tested owner-scoped 1.6 release candidate to stable distribution.
- Global and unattended enforcement remain explicitly unavailable pending an
  OpenClaw hard in-flight model token/cost/pass abort safeguard.
- Runtime behavior is unchanged from rc.13.

## 1.6.1-rc.13 — 2026-09-16 (ClawHub replacement; pairs with Intelligence 1.4.1-rc.14)

- Replaces the unreadable ClawHub rc.12 reservation created by a registry-side
  publication failure.
- Runtime behavior and corrected publication metadata are unchanged from rc.12.

## 1.6.1-rc.12 — 2026-09-16 (publication metadata correction; pairs with Intelligence 1.4.1-rc.13)

- Revises the public package summary to describe the owner-scoped skill-aware
  1.6 release accurately and to state that ToggleLogic Intelligence is privately
  distributed under its own license.
- Declares OpenClaw `2026.9.4` as the minimum tested host for this feature set,
  eliminating the ClawHub host-version drift warning.
- Documents that global and unattended enforcement remain unavailable pending
  an OpenClaw hard in-flight model token/cost/pass abort safeguard.
- Runtime routing behavior is unchanged from rc.11.

## 1.6.1-rc.11 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.12)

- Separates human conversation from actionable work at the bounded local
  classifier boundary. Social conversation, acknowledgements, personal
  reflection, brainstorming, opinions, and advice can pass to SAM normally;
  requests to perform or retrieve work must still resolve to an installed skill.
- Conversation decisions cannot name or execute a skill, are confidence-gated,
  and fail closed when malformed or uncertain.

## 1.6.1-rc.10 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.11)

- Accepts natural SAM vocative prefixes on deterministic budget controls,
  including `Sam - Set my ToggleLogic budget to $50 per month.` and `Sam, please
  raise my monthly cloud budget to $75.`

## 1.6.1-rc.9 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.10)

- Adds an authenticated-owner control sentence for durable monthly cloud-budget
  changes, such as `Set my ToggleLogic budget to $50 per month.` The parser is
  deterministic and bounded; no general model interprets or writes policy.
- Reports month-to-date cloud spend and remaining headroom after a successful
  budget update.

## 1.6.1-rc.8 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.9)

- Accepts a bare `1`, `2`, or `3` only when an authenticated owner has a live
  routing choice in the same conversation. The durable pending plan remains
  session- and sender-bound; unrelated numeric messages cannot create or replay
  a choice.
- Rewrites the owner-facing education prompt in shorter language and explains
  how to raise the monthly ToggleLogic budget when cloud headroom is exhausted.

## 1.6.1-rc.7 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.8)

Fail closed on restart-time cloud-spend regression. OpenClaw's usage cache can
briefly report `$0` while the gateway is starting; a same-month runtime refresh
must never replace a higher committed cumulative spend with that transient value.

- Add a pure same-month non-regression check to the durable refresh stage.
- Preserve the previous paired snapshots and emit a failed sentinel if generated
  month-to-date cloud spend moves backwards.
- Permit normal spend growth and a lower value when a new policy month begins.
- Tests: Free quality gate **342/342**.

## 1.6.1-rc.6 — 2026-09-16 (prerelease; pairs with Intelligence 1.4.1-rc.7)

Restore assistant usability without weakening the governed skill boundary.

- Pure deployment-declared greetings such as “Good morning, Sam.” bypass the
  skill gate and return to normal conversation. The anchored pattern does not
  exempt a greeting followed by an actionable request.
- Owner-facing education now identifies over-monthly-allowance cloud choices,
  shows the resulting overage, and states that the sender-bound one-time `TL-`
  reply is explicit approval for that execution. No over-budget route is selected
  automatically.
- Preserve the no-skill fail-safe for actual unsupported requests and the hard
  capability, privacy, per-run-cost, bounded-child, and tool-call gates.
- Tests: Free quality gate **340/340**.

## 1.6.1-rc.5 — 2026-09-15 (prerelease; pairs with Intelligence 1.4.1-rc.5)

Durable release candidate correcting a just-proven **owner-auth propagation**
defect in the skill-routing education gate. Prerelease — the owner-only scoped
canary remains the next stage; global/unattended enforcement stays blocked on the
host in-flight token/pass/cost abort (unchanged from rc.4). No model-family lineage
architecture changed and the Intelligence classifier entrypoint is byte-identical
(re-pair only); the rc.4 explicit-calendar-inspection precedence is preserved
unchanged.

### Owner-auth propagation (`skill-routing` education gate)

- **Was (canary defect):** on a live owner-only Telegram turn the trusted sender
  (the configured owner sender) was correctly admitted into canary scope — the audit principal
  resolved to `owner` and explicit Graph inspection resolved `microsoft-graph` —
  yet `coordinator.plan()` returned `teaching_authorized=false` and the owner saw
  *"An authenticated owner must start this teaching choice."* Root cause:
  `plan()` derived owner status **only** from `hookContext.senderIsOwner === true`,
  but the `before_agent_reply` agent context does not carry that bit. The canary
  scope evaluator's `isOwner()` already handles this correctly — it falls back to
  the configured `ownerSenderIds` (or the `senderIds` scope dimension) matched
  against the trusted `senderId` — so the two owner decisions disagreed on exactly
  the path scope had already admitted as an in-scope owner turn.
- **Now:** `plan()` makes ONE trusted owner decision via the existing scope
  evaluator (`scope.isOwner`), the SAME decision that admits the turn into scope.
  This never weakens scope — it only ADDS the explicit-allowlist path to the raw
  bit (any turn `senderIsOwner === true` authorized before still authorizes) — and
  falls back to the bare bit when no scope evaluator is wired (the optional planning
  tools / unit fixtures). The staged choice is still bound to the exact staging
  `senderId`, so a different proven sender in the same session can never consume it.
- **Tests:** `tests/skill-routing.test.js` — a configured `ownerSenderIds` fallback
  stages the education choice when `senderIsOwner` is absent; the `senderIds`
  dimension does too when no `ownerSenderIds` allowlist is set; an explicit
  `senderIsOwner` bit still authorizes even with the allowlist unmatched;
  non-owner / missing-sender / explicit-`false` / mismatched-sender turns cannot
  stage a token and still render the authenticated-owner notice; and a choice
  staged via the fallback remains bound to the staging sender.

## 1.6.1-rc.4 — 2026-09-15 (prerelease; pairs with Intelligence 1.4.1-rc.4)

Durable release candidate cutting the just-verified **explicit-calendar-inspection
precedence** correction over rc.3. Prerelease — owner-only scoped canary remains the
next stage; global/unattended enforcement stays blocked on the host in-flight
token/pass/cost abort (unchanged from rc.3). No model-family lineage architecture
changed; the Intelligence classifier entrypoint is byte-identical (re-pair only).

### Explicit calendar-inspection precedence (`skill-contracts` preflight)

- **Was (canary defect):** the meeting/calendar contract's cost-saving past-meeting
  short-circuit was over-broad. An owner request that EXPLICITLY directs SAM to
  inspect the Outlook calendar via Microsoft Graph ("Check my Outlook calendar using
  Microsoft Graph and tell me whether I had a 2 pm meeting today") was wrongly
  clarified away as `past_meeting_reference` merely because the referenced 2 pm had
  already passed — refusing exactly the authoritative verification the contract exists
  to protect.
- **Now:** `detectCalendarInspectionIntent` adds a NARROW precedence in
  `src/skill-routing/skill-contracts.js`. When the resolved route contains the
  authoritative Microsoft Graph calendar AND the message carries explicit inspection
  intent — an inspection verb (check/inspect/search/query/look up/verify/confirm/pull
  up/review/read/"tell me whether"/"did I have"…) AND an Outlook / Microsoft Graph /
  calendar target — preflight returns `proceed` / `explicit_calendar_inspection`. It
  runs through the Graph skill/bridge under the SAME meeting/calendar contract (Outlook
  is the one authoritative calendar; never fabricate), reporting the truth whether or
  not the meeting existed. It proceeds even with no wired calendar port — the
  child/bridge performs the authoritative check; the precedence is not deferring to a
  port-confirmed event.
- **High-precision by construction.** Requires BOTH the inspection verb and the
  calendar/Graph target, so an ordinary ambiguous meeting-PREP request ("prepare me
  for my 2 pm meeting") — which carries neither — still takes the cost-saving
  `past_meeting_reference` clarification. A route without the authoritative calendar
  (Zoom alone) still clarifies (`subordinate_meeting_skill_not_authoritative`); Zoom is
  never the authoritative calendar, so explicit inspection cannot rescue it.
- **Tests:** `tests/skill-contract-intent.test.js` — intent detection (prompt B and
  natural inspection phrasings true; prompt A and single-signal near-misses false),
  the preflight proceed-vs-clarify matrix on a PAST time (with and without a wired
  port), the Zoom-not-rescued case, and the two-prompt canary regression driven
  through the real `before_agent_reply` gate (prompt A clarifies before the planner
  with zero model/child calls; prompt B proceeds through microsoft-graph to the
  bounded child).

## 1.6.1-rc.3 — 2026-09-15 (prerelease; pairs with Intelligence 1.4.1-rc.3)

Material follow-up to rc.2: the hardware-equivalent monthly cloud policy is now
enforced with a LIVE, validated month-to-date cloud-spend number instead of a
static configured constant, plus a durable runtime-state refresh stage and a
genuinely automated isolated-gateway proof. Prerelease — owner-only scoped canary
remains the next stage; global/unattended enforcement stays blocked on the host
in-flight token/pass/cost abort (unchanged from rc.2).

### Live cloud-spend ceiling (`skillRouting.spend`)

- **Authoritative live spend.** New `src/usage/spend-snapshot.js` +
  `scripts/generate-spend-snapshot.mjs` build and verify a versioned +
  fingerprinted, current-policy-month cloud-spend snapshot from
  `openclaw gateway usage-cost --all-agents --expect-final --json`. The coordinator
  consumes it via `src/usage/spend-provider.js` as the month-to-date spend fed to
  Intelligence. **When `skillRouting.spend.enabled` is true the validated snapshot is
  AUTHORITATIVE — no caller / event / tool parameter may override it** (see the
  correction-pass note below). The static `monthlyCloudSpendUsd` is the fallback only
  when the feature is off (or via the no-finite-budget fallback).
- **Fails closed on unpriced CLOUD rows.** Missing-cost LOCAL (Ollama) rows are the
  expected $0; any missing-cost CLOUD row fails the snapshot closed so spend is
  never understated. Also fails closed on wrong month/timezone, stale, future,
  negative/non-finite totals, wrong source/pair, or fingerprint drift.
- **Budget-exhausted fail-closed.** When the snapshot is missing/stale/invalid and
  `spend.finiteCloudBudgetApplies` is set, cloud routes are withheld (Intelligence
  headroom collapses to 0) while local-capable routes remain. The universal
  no-skill fail-safe always runs before any model selection.
- New `skillRouting.skillRequirements` is now declarable in the manifest schema
  (previously read by the code but rejected by config validation).

### rc.3 correction pass (independent re-review — trust/bypass hardening)

An independent review reproduced seven blockers in the initial rc.3 spend/routing
work; all are fixed on the uncommitted tree (version stays rc.3):

- **Authoritative spend precedence (was backwards).** `coordinator.plan()` used a
  caller-supplied value before the live provider, and the tools exposed a
  `monthly_cloud_spend_usd` parameter. Now the validated live provider ALWAYS wins
  while live spend is enabled; an attempted caller/tool override is ignored and
  audited (`caller_spend_ignored`), and the public tool parameter was removed. A
  hand-entered zero can no longer reopen cloud after a valid or exhausted snapshot.
- **Generator window.** `scripts/generate-spend-snapshot.mjs` now passes `--days`
  (floor 35) to `openclaw gateway usage-cost` — its 30-day default could omit day 1
  of a 31-day policy month — and still filters to the owner policy month.
- **Fingerprint binds every trust field.** `generated_at_ms` / `generated_at`,
  `local_providers`, and the local missing-cost attribution map are now bound, so a
  hand-edit to bypass staleness or reclassify providers drifts the fingerprint. The
  consumer also cross-checks the snapshot's `local_providers` against the plugin's
  OWN configured local set (exact normalized match) and fails closed on mismatch.
  The fingerprint is a public checksum (drift/tamper evidence, not authentication);
  authenticity is the deployment-owned 0600 file the plugin only reads.
- **Missing-cost attribution reconciles.** Per daily row, the nonnegative-integer sum
  of `missingCostByModel` must equal `missingCostEntries`; any deficit, surplus,
  negative, fractional, or malformed count fails closed (one proven local row can no
  longer absorb other unexplained missing rows).
- **Post-snapshot delta FAILS CLOSED (was silent-skip).** It no longer claims it
  "cannot miss spend": any post-through cloud call lacking a finite nonnegative cost,
  any row of unknown provider provenance, any parse/tail-truncation condition that
  could conceal a post-through row, or an unreadable ledger sets the provider
  unavailable / cloud-suppressed under a finite budget — never the base total as
  verified. A local row is $0 only when its provider is in the explicit configured
  local set; a too-large ledger that can't prove it reaches back to `through_ms`
  fails closed rather than tail-skip.
- **Deterministic platform intent recipes.** The local Gemma classifier misrouted
  explicit-platform prompts; the SAM-HQ example now declares high-precision,
  inventory-bound recipes (explicit Outlook + email/mail/inbox → `microsoft-graph`;
  explicit Zoom + transcript/recording → `zoom-meetings`) that resolve BEFORE the
  classifier, only when the target skill is installed, and never fire on generic
  Gmail/Google or generic meeting text. The meeting-prep Graph+Zoom recipe is kept.

### SAM-HQ mailbox-identity addition

Closes the last SAM-HQ mail gap: routing a Gmail request to the right skill, and
giving the bounded child the AUTHORITATIVE mailbox identity for the resolved skill so
the two mail identities are never conflated. Version stays **rc.3** (durable code +
docs + tests on the uncommitted tree; no package bytes changed beyond source/docs).

- **Deterministic Gmail recipe (`gmail-mail`).** The SAM-HQ example adds an
  inventory-bound recipe: literal `gmail` **plus** an email action/object term
  (`email`/`mail`/`inbox`/`send`/`draft`/`reply`/`search`/`read`/`find`) resolves to
  the installed **`gog`** skill — including a request naming the exact SAM address
  `clickitco@gmail.com` (which contains the `gmail` token) with an email term. It is
  high-precision by construction: it never fires on Outlook/M365 (no `gmail` token →
  Graph still owns those via `outlook-mail`), on generic Google Drive/Docs/Calendar,
  or on a platform-less email; if `gog` is absent it is inert and an explicit Gmail
  request returns the exact universal no-skill fail-safe. A message naming BOTH
  `outlook` and `gmail` fails closed (ambiguous). A bare exact-address recipe was
  deliberately NOT added — it would be redundant with `gmail-mail` and would risk
  capturing generic Drive/Sheets work that merely mentions the address.
- **Per-skill execution identity (`skillRouting.skillIdentities`).** A new
  deployment-owned, bounded, sanitized contract (in `src/skill-routing/skill-contracts.js`,
  wired through `src/config/normalize.js`, the manifest `configSchema`, and
  `src/capabilities.js`) that attaches the authoritative mailbox/account, sender
  identity, and send policy to the routed child — keyed **only** to the *verified
  resolved skill id*, never selected by the model. For SAM-HQ: `microsoft-graph` =
  Al's own Microsoft 365 mailbox (compose/send as Al / on behalf of Al); `gog` =
  SAM's own `clickitco@gmail.com` (SAM in SAM's own identity, never impersonate Al).
  It is injected into the child's system prompt and surfaced (credential-free) in the
  audit/receipt `execution_identity` field. Because an identity is applied only to a
  skill that actually resolved, a Graph identity can never cross onto a Gmail route
  (or vice versa) and an identity is never supplied for an unverified skill.
- **Send policy.** A specific owner instruction to send a NAMED message authorizes
  exactly that send; a general write/compose/draft/reply request is draft-only until
  the owner confirms the exact message. Represented in the child prompt for both
  mailboxes.
- **Never a credential.** `skillIdentities` values are identity labels + policy
  sentences only; no OAuth token/credential is ever placed in config, the prompt, or
  the audit. The `gog` skill's Gmail tokens stay with the skill.
- **Honest limitation.** The identity is injected into the child prompt and recorded
  in the audit/receipt metadata, but is NOT appended to the short user-facing
  execution footer (kept deliberately non-invasive). The mailbox address is included
  in the prompt/audit because the child must know which account it acts in — an
  account address, not a secret.
- **Tests:** `tests/skill-mailbox-identity.test.js` (16) — recipe precision +
  inert-when-absent + ambiguity, identity cannot-cross / not-for-unverified-skill,
  send policy, field sanitization/bounding, the GATE round trips (Outlook→Graph/Al,
  Gmail & the exact address→gog/SAM, generic Drive not captured, absent gog→fail-safe,
  zero classifier calls, no send performed), and config normalization survival.

### Durable runtime-state refresh (candidate; not activated)

- `scripts/togglelogic-runtime-refresh.mjs` + `src/maintenance/runtime-refresh.js`:
  a fail-closed stage the existing 4 AM job can call after a managed install to
  atomically refresh the paired skill-inventory + cloud-spend snapshots and write a
  sentinel. Fails closed + visible on missing plugin, disabled feature, incompatible
  pair, malformed usage JSON, stale/wrong month, or unpriced cloud spend. Runbook +
  candidate patch: `docs/RUNTIME-STATE-REFRESH.md`. The live job is untouched.

### Genuinely automated isolated-gateway proof

- `scripts/isolated-gateway-probe.sh` now performs a REAL round trip: it starts its
  own gateway on a collision-checked, non-live loopback port, sends an actionable
  no-skill prompt, and asserts the exact fail-safe reply, ONE no-skill
  `before_agent_reply` audit row, and ZERO `before_model_resolve` rows, then cleans
  up only its own PID/temp dir. Exits non-zero and labels the round trip unproven if
  it cannot prove it. Replaces the prior historical/manual step 7.

### Economic profile

- `docs/ECONOMIC-PROFILE.md` + `docs/examples/sam-hq-owner-policy.openclaw.json`
  (validated against the real 2026.9.4 schema): $400 capital ÷ 48 months = ~$8.33/mo
  derived cloud budget; Graph/Zoom require `tool_calling_strong` (general-purpose-only
  local models excluded); high-precision meeting recipe (meeting + prepare/brief);
  SAM-HQ Telegram account `default` scope with an owner-peer placeholder.

## 1.6.1-rc.2 — 2026-09-15 (prerelease; pairs with Intelligence 1.4.1-rc.2)

Permanent correction after the 2026-09-15 skill-routing canary failure. 1.6.0
gated skill routing on structured planned-skill metadata that the OpenClaw host
never supplies on the routing hooks, so it could not intercept a skill invocation
and executed inline on a fat main session instead. Prerelease — supersedes the
failed 1.6.0 pairing without reusing the stable identifier.

### Host-integration closure (Blockers 1–3) — see docs/HOST-INTEGRATION-CLOSURE-1.6.1-rc.2.md

- **Blocker 1 — calendar grounding wired (real subprocess bridge).** The
  `/me/calendarView` port now has a production transport: an explicitly configured
  bridge executable (`skillRouting.calendar.bridge.command` → the vault-backed
  `microsoft-graph/scripts/calendar_bridge.py`, new), spawned with `execFile` + an
  explicit argv array (no shell; injection-safe), a wall-clock timeout, a stdout cap,
  and strict JSON validation. Sanitized to `id/subject/start/end`; never prints
  tokens; fails closed on auth/network/timeout/malformed/invalid-args. Graph-side
  (16) and adapter (12) tests added.
- **Blocker 2 — bounded-child limits (plugin-enforceable set).** New
  `before_tool_call` guard (`child-tool-guard.js`) enforces, on `:togglelogic-skill:`
  children only: re-entrant-routing-tool deny, a per-skill tool allowlist, and a hard
  per-run tool-call COUNT ceiling (`maxChildToolCalls`, default 32). Per-skill
  `disableTools` (empty tool surface) via `skillRouting.skillTools`. Post-run actual
  usage audit (tool-call count, denied, wall-clock, stopReason). The residual gap —
  the host exposes no model-token/pass cap or in-flight abort — is documented, not
  claimed (`docs/BOUNDED-CHILD-LIMITS.md`); every child audit carries
  `runtime_token_ceiling_enforced:false`. Scoped canary = defensible; global release
  still needs the host cap.
- **Blocker 3 — proven in a real gateway.** In an isolated OpenClaw 2026.9.4 temp
  profile (loopback gateway, no live mutation), a real user turn to
  `before_agent_reply` returned the no-skill fail-safe in 15 ms with ZERO provider
  model calls (0 `before_model_resolve`, 0 model-call log lines, no creds present).
  Setup harness: `scripts/isolated-gateway-probe.sh`.
- **Managed capability consent.** `configContracts.dangerousFlags` flags
  `skillRouting.calendar.enabled` (subprocess execution); surface documented in
  `docs/CAPABILITY-CONSENT.md`; `plugins install --accept-capabilities` verified.
- **Native session-maintenance candidate** (`docs/SESSION-MAINTENANCE-CANDIDATE.md`)
  using validated 2026.9.4 keys (`compaction.maxActiveTranscriptBytes`,
  `session.reset`, `subagents.runTimeoutSeconds`); `openclaw config validate` →
  `valid:true` in an isolated profile.

### Second remediation pass — owner-directed fail-closed architecture

- **Universal fail-closed skill rule.** On a governed (in-scope, active) turn,
  EVERY actionable request must resolve to an active installed skill. If none
  relates, the gate returns the verbatim fail-safe *“I don't have a skill that
  relates to what you're asking me to do.”* — it never silently passes the
  request to a general model. A specifically named unavailable skill returns the
  same fail-safe. Non-action conversation/control messages bypass the gate ONLY
  through explicit deployment-owned categories (`skillRouting.nonActionCategories`,
  default empty). Out-of-scope/shadow turns keep the prior safe passthrough and
  are never represented as governed.
- **Live installed-skill inventory is authoritative** (`skillRouting.useLiveInventory`,
  `inventoryPath`, `skillsDir`, `inventorySnapshotPath`). The resolver's
  membership set is generated from the host's own `skill_manifest.json` (enabled
  skills) with a per-skill fingerprint/version and **startup drift detection**
  against a plugin-owned snapshot. A temporary plugin-cache copy or a hand-written
  catalog id that is not installed is reported as *configured-but-not-installed*
  and never resolves. `skillCatalog` is now only an alias supplement.
- **Gate fails closed on internal error.** An internal error on a governed turn
  or a token reply returns a handled error and holds the turn — it no longer
  falls through to inline model routing (the incident path). The interceptor’s
  defense-in-depth catch uses the coordinator’s total `evaluateScope` to fail
  closed for governed turns.
- **Bounded child uses supported SubagentRunParams.** The unsupported
  `contextTokenBudget` field (silently ignored by the host) was removed; the
  child now runs with `promptMode: "minimal"` + `lightContext: true` plus a fresh
  session. The estimate ceiling is labelled a PRE-FLIGHT guard, not a runtime
  ceiling. (Closure update: a `before_tool_call` guard now adds real per-child
  tool-call/allowlist/re-entrancy enforcement; the host still exposes no model
  token/pass cap, so that residual runtime ceiling remains unclaimed — see the
  Host-integration closure above and docs/BOUNDED-CHILD-LIMITS.md.)
- **Microsoft Graph `/me/calendarView` grounding port** (`skillRouting.calendar`).
  A deterministic, transport-injected port returns a UNIQUE future event only;
  zero/multiple/ambiguous/auth/timeout/unwired all fail CLOSED (clarify, never
  fabricate). Zoom stays subordinate (never consulted here). Wired into the
  meeting-prep contract. (Closure update: the production transport is now the
  configured subprocess bridge — see the Host-integration closure above.)

- **Guaranteed pre-execution gate.** Skill routing now runs through a
  `before_agent_reply` gate (host-enforced `eligibleTriggers: ["user"]`) that
  returns `handled:true` + a reply before any model is resolved or called. It no
  longer depends on the model voluntarily calling a tool or on host skill
  metadata. The dead `structuredPlannedSkills`-only preflight path is removed
  from `before_model_resolve`.
- **Deterministic skill resolver** (`skillRouting.skillCatalog`,
  `resolverMode`, `ambiguityPolicy`). Exact installed skill id / alias references
  in the message resolve deterministically; a named-but-uninstalled skill is
  clarified, never guessed. Models are assigned to resolved skills, never to raw
  task text.
- **Canary scope** (`skillRouting.scope`). Active routing/education is bounded to
  configured trusted hook identities (channel/account/sender/chat/session) so a
  canary can be limited to one owner channel; out-of-scope turns (other channels,
  senders, cron, heartbeat, CLI, inter-session) stay shadow/passthrough. An
  unconstrained scope is inert unless `allowGlobal` is set.
- **Bounded-child ceiling** (`skillRouting.maxChildTokens`,
  `maxChildCostUsd`). The owner's token choice and learned routes execute in a
  fresh bounded child; a plan estimated above the ceiling fails loud instead of
  amplifying to the full main-session context.
- **Meeting-prep execution contract.** Deterministic pre-execution validation
  (owner-local clock) plus an injected bounded-child contract: Outlook via
  Microsoft Graph is authoritative, past/nonexistent meetings are clarified not
  fabricated, Zoom history only after an Outlook confirmation, never synthesize a
  calendar event from history.
- **Fail-loud host-affordance self-check** at registration; missing affordances
  or unconfigured scope force shadow with a loud gateway + audit warning instead
  of a silently dead preflight.
- **Cache-token pricing reconciliation.** One calculation (`pricing.costBreakdown`)
  shared by the cost log and the owner receipt: cache reads/writes are priced
  from source cache-tier rates when present, otherwise a documented input-rate
  proxy (`costVisibility.pricing.cacheReadMultiplier`/`cacheWriteMultiplier`),
  with the basis stated loudly. Removes the full-input-rate cache billing that
  overstated the incident cost ~1.9x.
- Real-hook-payload acceptance tests and an isolated real-gateway end-to-end
  message test replace the synthetic planner-only coverage.

### Third remediation pass — intent- and skill-aware meeting/calendar contract

- **The meeting/calendar truth contract no longer binds only to the absent
  `meeting-prep` id.** On the reference host `meeting-prep` is NOT installed;
  natural-language meeting/calendar requests there resolve to the ELIGIBLE
  `microsoft-graph` skill (the authoritative Outlook/Graph calendar) and/or
  `zoom-meetings` (subordinate recordings, never a calendar). Applicability is now
  **intent-aware and skill-aware**: the deterministic Outlook/current-time contract
  (both the preflight check and the injected bounded-child contract) applies when a
  turn shows a calendar/meeting intent AND resolves to a calendar-capable installed
  skill — through `meeting-prep`, `microsoft-graph`, or a `microsoft-graph` +
  `zoom-meetings` composition. Generic Graph email/contact work (no meeting intent)
  is deliberately left untouched. Deployment-overridable via
  `createSkillContracts({ calendarSkillIds, meetingSubordinateSkillIds })`; defaults
  `microsoft-graph` (authoritative) / `zoom-meetings` (subordinate).
- **Zoom alone cannot establish a calendar event.** A meeting/calendar request that
  resolved to Zoom with NO authoritative Outlook/Graph skill in the route is
  clarified deterministically (Zoom is subordinate context, never the calendar) —
  even if a calendar port is wired, because that route has no authoritative source.
- **Deterministic safety preflight now runs BEFORE route/model education/spend.**
  The moment skills resolve on a governed turn, a past or unverifiable
  meeting/calendar request is clarified with ZERO model calls — ahead of the
  three-choice routing education (previously the contract only gated the already
  routed `selected` branch, so a past-meeting request first staged a routing
  choice). Named-unavailable-skill behavior and the universal no-skill fail-safe are
  unchanged.
- Regression tests (`tests/skill-contract-intent.test.js`) use the actual
  installed-skill reality (meeting-prep absent; microsoft-graph + zoom-meetings
  eligible) and assert, via a plan-call counter and a stub subagent: past 2 PM at
  16:03 clarifies before the planner; a future meeting with no Outlook event
  clarifies; a future unique Outlook event proceeds; generic Graph email does not
  trigger the contract; Zoom alone cannot establish an event; and the no-skill
  fail-safe is unchanged.

### Fourth remediation pass — resolver hardening (descriptions, bounded classifier, intent recipes) — see docs/RESOLVER-HARDENING-1.6.1-rc.2.md

Correction for a measured resolution gap: the snapshot fingerprinted each skill's
description but stripped it from the snapshot/verified catalog, and the bounded
local classifier was handed only opaque skill ids with `num_ctx: 2048`. In local
Ollama testing over all 57 eligible ids this routed poorly (`glm4:9b` misrouted or
rejected most tasks; `gemma4` improved to 4/5 only when supplied id + description
at `num_ctx: 8192`, and *still* misrouted "Prepare me for my 2 PM meeting today").
The fix is permanent and fail-closed:

- **Descriptions preserved AND tamper-bound in the snapshot/catalog.** The
  inventory snapshot (`schema_version` 2 → **3**) now carries a sanitized, bounded
  (`MAX_DESCRIPTION_CHARS = 400`, single-line, control-free) per-skill description,
  and the inventory fingerprint binds `sha256(description)` per skill. Hand-editing
  a stored description (e.g. to inject text into the classifier prompt) drifts the
  fingerprint and **fails the snapshot closed**; an oversized stored description
  fails closed on the explicit size bound. A `v2` snapshot is rejected loudly
  (regenerate with `scripts/generate-skill-inventory.mjs`).
- **Classifier is given the verified catalog (id + bounded description), not opaque
  ids**, with a normalized, hard-bounded, configurable `numCtx`
  (`skillRouting.classifier.numCtx`, default **8192**, clamped `[2048, 32768]`), a
  strict output schema, and eligible-id validation (a hallucinated id → malformed).
  It **fails closed** if the eligible catalog exceeds `MAX_CLASSIFIER_ENTRIES` (128)
  or the assembled system prompt exceeds `MAX_SYSTEM_PROMPT_CHARS` (24000) — never
  invoking the model. It still only ever names one listed id; its output is never
  executed as the task answer.
- **Deployment-owned deterministic intent recipes** (`skillRouting.intentRecipes`,
  default empty) — declarative normalized-token rules (`{ id, allTerms, anyTerms,
  skillIds }`; no code, no raw regex) evaluated ONLY after exact installed-skill
  resolution returns none and BEFORE the classifier. A recipe resolves only when
  **every** target skill is present in the fresh verified inventory (else inert);
  matching recipes that resolve to **different** skill sets fail closed with one
  clarification. This lets a deployment declare compositions the classifier gets
  wrong.
- **Meeting-preparation recipe, tested end-to-end.** With the example recipe
  configured, "Prepare me for my 2 PM meeting today" resolves DETERMINISTICALLY to
  installed `microsoft-graph` + `zoom-meetings`, then the already-built
  meeting/calendar contract clarifies at 16:03 (2 PM already past) with **zero
  planner / model / classifier calls**; a generic Outlook email (no recipe match)
  routes through the classifier to Graph; an unrelated poem reaches the exact
  universal no-skill fail-safe. The universal fail-safe sentence and
  shadow/out-of-scope passthrough are unchanged.
- Tests: `tests/skill-intent-recipes.test.js` (recipe engine), extended
  `tests/skill-inventory.test.js` (description preserve/tamper/size-bound/`v2`
  reject), extended `tests/skill-routing-modules.test.js` (classifier id +
  description, bounded `numCtx`, catalog-bounds fail-closed, hallucinated id), and
  `tests/skill-recipe-gate.test.js` (the six gate acceptances above).
- **Honesty note.** No Ollama benchmark was rerun in this pass; the `glm4:9b` /
  `gemma4` numbers above are the prior local findings and are NOT re-claimed as a
  fresh passing run. The intent recipe — not a model — is what makes the incident
  prompt deterministic.

## 1.6.0 — 2026-09-15

- Add the opt-in `togglelogic_skill_plan` simulator,
  `togglelogic_skill_run` child-execution tool, and structured planned-skill
  routing contract for the paired Intelligence 1.4 layer.
- Add restart-safe educational choice state, exact owner selection handling,
  and learned-route continuation without changing production defaults.
- Add cost-parity presentation and lineage-plus-child receipts for skill
  decisions.
- Treat host-configured model refs as authoritative candidates when an embedded
  profile's independent CLI reachability probe cannot see the gateway context.
- Fail loudly on child execution timeout/error and structurally prevent nested
  ToggleLogic child dispatch.
- Fail closed when a pending owner choice was sender-bound but the reply lacks
  the matching sender identity.
- Keep the feature disabled by default pending shadow and production gates.

## 1.5.1 — 2026-09-14

- Add an opt-in ordered host plan spanning a primary model family and fallback
  families while leaving concrete execution and configuration writes with the
  OpenClaw host/deployment.
- Add per-family `acceptedModels` allowlists so catalog discovery cannot promote
  an unaccepted child.
- Resolve the full family ladder atomically and report unresolved or duplicate
  rungs without silently shortening or reordering it.
- Audit whether the resolved family ladder matches OpenClaw's configured
  primary and fallback chain.
- Preserve the same-turn guard that lets OpenClaw advance through its concrete
  fallback candidates without ToggleLogic reclassifying the task.
- Add a public architecture diagram and integration guidance. This relationship
  may be protected by our patent pending.

## 1.5.0 — 2026-09-14

- Make governed escalation portable across agent products by removing
  SAM-specific wording from the routing core.
- Let deployments configure their exact approval and denial phrases,
  external-data notice, and optional friendly provider/model names.
- Keep owner authentication, business-action execution, and action receipts in
  the host or deployment layer instead of implying the router can provide them.
- Add a public integration responsibility contract explaining the boundaries
  among OpenClaw, ToggleLogic, an agent deployment, and external services.
- Add a developer architecture note and diagram for durable model-family
  routing, child resolution, and current-run family-plus-child receipts.
- Preserve the deterministic, one-use, fail-closed approval state machine and
  all existing routing, audit, and honest-cost behavior.
- Validate the stable build with 82 passing tests, package inspection, an
  independent code review, and a live SAM-HQ canary on OpenClaw `2026.9.4`.

## 1.5.0-rc.1 — 2026-09-14

- Remove SAM-specific wording from governed escalation and make the default
  approval experience deployment-neutral.
- Move accepted approval/denial phrases, external-data wording, and friendly
  provider/model names into deployment-supplied configuration.
- Keep the deterministic, one-use, fail-closed approval state machine in the
  router while leaving owner-language interpretation and presentation policy to
  the integrating deployment.
- Add a public integration responsibility contract covering host truth, router
  choice, deployment intent/proof, business-action receipts, common failure
  modes, and conformance tests.
- Preserve routing-core behavior, including no-decision passthrough and honest
  unavailable-cost reporting.

## 1.4.2-rc.1 — 2026-09-14

- Preserve OpenClaw's configured model when ToggleLogic Intelligence returns no
  routing decision; an absent capability tier no longer silently selects the
  governed local model.
- Add unit and end-to-end regressions reproducing the no-decision routing
  failure while retaining explicit local routing for configured local tiers.

## 1.4.1 — 2026-09-13

- Replace OpenClaw's generic negative escalation block with a short, positive
  invitation before any external model receives the request.
- Add natural, two-stage consent: ToggleLogic makes SAM's interpretation
  visible, repeats the provider, model, context boundary, one-use scope, and
  estimate, and requires a final explicit yes/no decision.
- Reject false-zero external runtime costs when positive token usage proves
  work occurred; use a labeled public-rate estimate or report unavailable.
- Replace the dense technical execution line with a short multiline receipt
  showing a friendly model name, location, usage, and emphasized cost.
- Preserve exact provider references, pricing sources, routing evidence, and
  one-use approval evidence in machine-readable audit data.
- Bind an approved execution to its confirmation turn so an interrupted
  approval cannot attach itself to a later unrelated message; retries after
  consumption fail closed with a clear explanation.
- Validate the release on OpenClaw 2026.9.4 with 75 passing tests and live
  Telegram canaries covering local routing, consent, external execution, cost,
  and the final receipt presentation.

## 1.4.1-rc.6 — 2026-09-13

- Remove the redundant one-use approval line from the human-facing receipt.
- Retain approval scope and verification in the machine-readable audit trail.

## 1.4.1-rc.5 — 2026-09-13

- Replace the dense, pipe-delimited technical receipt with a short multiline
  summary for people: friendly model name, location, approval, usage, and cost.
- Put the cost on its own emphasized final line and keep pricing-source and
  exact model-reference evidence in the machine-readable audit trail.
- Shorten the heading from `ToggleLogic execution receipt` to `Receipt`.

## 1.4.1-rc.4 — 2026-09-13

- Reject a zero runtime-cost claim for an external model when runtime evidence
  shows positive token usage.
- Fall back to a labeled public-catalog estimate when pricing is available;
  otherwise report cost as unavailable rather than presenting a false zero.
- Render tiny positive costs as `<$0.0001` instead of rounding them to `$0.0000`.

## 1.4.1-rc.3 — 2026-09-13

- Add a two-stage consent state for external-model use: an initial natural
  affirmative or uncertain reply produces a plain-language confirmation, and
  only the following explicit approval authorizes the one-time execution.
- Keep uncertain replies paused instead of silently discarding the governed
  request or allowing a model to infer authorization.
- Repeat the provider, model, context boundary, one-use scope, and estimated
  cost in the final confirmation question.
- State whether SAM interpreted the first response as affirmative or uncertain,
  while leaving authorization exclusively to the second explicit answer.

## 1.4.1-rc.2 — 2026-09-13

- Accept common explicit approval phrases, including `Yes, approved`,
  `Approved`, and `Go for it`, while an external-model approval is pending.
- Keep authorization deterministic and fail-closed: ambiguous replies do not
  approve external execution, and approval remains valid for one use only.
- Tell the owner in the invitation that natural approval wording is accepted.

## 1.4.1-rc.1 — 2026-09-13

- Claim governed escalation before model resolution with a short,
  deterministic, positive invitation to approve one external use, avoiding
  OpenClaw's generic negative block envelope.
- Keep the proposed model, estimated AI cost, external data boundary, and
  explicit yes/no choice while omitting internal tier and token details.
- Preserve the fail-closed `before_agent_run` gate; no external model receives
  the request before owner approval.
- Cache ordinary preflight routing decisions for the normal model-resolution
  hook so Intelligence classifies each logical turn only once.

## 1.4.0 — 2026-09-13

- Add an opt-in governed-escalation lifecycle that keeps configured ordinary
  work local and blocks configured external capability tiers until the owner
  approves one execution.
- Show the proposed model, reason, estimated usage, estimated AI cost, and
  external-data boundary before any approved external request is submitted.
- Resume the original request after approval and attach a delivery-time receipt
  naming the runtime model, execution location, approval evidence, token usage,
  and either runtime-reported cost, a labeled public-rate estimate, or an
  explicit unavailable marker.
- Suppress false fallback notices only when runtime evidence proves a
  ToggleLogic policy reroute; preserve real and uncertain fallback warnings.
- Bound transient receipt state, require an explicit local quarantine model,
  and keep governed escalation disabled by default.
- Validate on OpenClaw `2026.9.4` with 64 passing tests, independent review,
  and a live block → approve → external receipt → return-to-local canary.

## 1.4.0-rc.4 — 2026-09-13

- Label public-catalog calculations as estimated AI cost rather than actual
  provider billing.
- Distinguish runtime-reported external cost from zero external-provider cost
  for local Ollama execution.
- Add a timed three-minute demonstration runbook with strict response limits.
- Keep this release candidate private pending live canary evidence.

## 1.4.0-rc.3 — 2026-09-13

- Bound and drain transient execution-receipt correlation state across the
  OpenClaw 2026.9.4 dual-hook delivery sequence.
- Require an explicit provider/model local quarantine target whenever governed
  escalation is enabled, preventing an empty local target on older hosts.
- Add a regression that exercises `llm_output` → `reply_payload_sending` →
  `message_sending` in host order and proves one receipt with no retained state.
- Keep this release candidate private pending owner approval for deployment.

## 1.4.0-rc.2 — 2026-09-13

- Use OpenClaw 2026.9.4's delivery-time runtime evidence to attach the
  governed-execution receipt to the final channel payload.
- Suppress OpenClaw's fallback banner only when runtime evidence proves the
  requested/resolved model difference was a ToggleLogic policy reroute and no
  fallback occurred; preserve real and uncertain fallback notices.
- Clarify local receipts as ToggleLogic policy selections with no external AI
  model, while retaining exact runtime model, tokens, and cost evidence.
- Keep this release candidate private while it is canaried on a controlled host.

## 1.4.0-rc.1 — 2026-09-13

- Add an opt-in governed-escalation lifecycle: local-first routing, a pre-run
  estimate and explicit one-time owner approval before configured external
  capability tiers, automatic resumption of the original request, and a
  post-run execution receipt naming the runtime model, boundary, tokens, and
  actual or explicitly unavailable cost.
- Persist pending approval state locally with owner-only permissions so a
  gateway restart cannot silently lose the governance decision.
- Keep this release candidate private while it is canaried against a live SAM
  deployment; no registry or public package release is implied.

## 1.3.4 — 2026-09-04

- Add a bounded, privacy-safe new-session signal so a separately installed
  Intelligence package can choose its general-purpose default on the first turn.
- Preserve that one-shot signal across OpenClaw gateway and worker processes
  using hashed, expiring local markers; raw session identifiers are never stored.
- Wait for licensed Intelligence detection and registry reachability during cold
  one-shot task startup instead of silently missing the first routing decision.
- Split `provider/model` references into OpenClaw 2026.9.1's separate provider
  and model override fields in configured and cheap modes.
- Keep disabled Intelligence detection awaitable so Free-only routing registers
  cleanly on OpenClaw 2026.9.1.
- Validate the release on OpenClaw `2026.9.1` while preserving the intentional
  `>=2026.6.5` host and `>=2026.5.2` plugin API compatibility floors.

- Publish the coordinated Intelligence public-development references while
  preserving the Free package boundary: no Intelligence engine, production
  Toggle Registry, maintained benchmark intelligence, private evidence,
  credentials, signed packs, or services are included here.
- Adopt the ToggleLogic Free Startup Commercial Use License 2.0, including its
  qualifying-startup commercial permissions, published thresholds, transition
  provisions, stable released-version rights, and breach cure.
- Add standalone product, patent, and trademark notices.

## 1.3.2 — 2026-08-28

- Preserve session intent across a single affirmative confirmation by
  inheriting the preceding high-confidence Intelligence decision within that
  session, with a 15-minute TTL and consume-once semantics.
- Classify each logical host turn only once so OpenClaw fallback candidates are
  not re-routed back to the model that already failed.
- Carry the classifier's required execution surface into routing audit details.
- Record explicit Intelligence unavailability as a failed routing decision,
  while ordinary classifier declines remain safe no-ops.

## 1.3.1 — 2026-08-26

Metadata and documentation compatibility release. Routing, model selection,
cost observation, fleet attribution, configuration, and network behavior are
unchanged from 1.3.0.

- Record OpenClaw `2026.7.1-2` as the host used to package and validate this
  release.
- State prominently that ToggleLogic is backward-compatible with OpenClaw
  `2026.6.5` and later and is validated through OpenClaw `2026.7.1-2`.
- Retain the intentional minimum gateway floor `>=2026.6.5` and plugin API
  floor `>=2026.5.2` for existing deployments.
- Clarify that the minimum version is a compatibility floor, not a dependency
  on an obsolete OpenClaw release.
- Add a regression assertion that release metadata cannot silently change any
  of the three compatibility values.

### Verification

- Full ToggleLogic release quality gate passes on OpenClaw `2026.7.1-2`.
- ClawHub package validation and artifact inspection are required before
  publication.

## 1.3.0 — 2026-08-26

- Add opt-in, provider-constrained family aliases for configured routes, with
  fresh complete pricing required and safe passthrough on uncertainty.
- Preserve explicit owner and session model choices above automatic routing.
- Prevent false `$0.00` reporting from zero, blank, or half-priced catalog rows.
- Verify the separately licensed Intelligence classifier by release-manifest
  identity, compatibility interval, ABI, and exact SHA-256 before loading it.
- Add Intelligence shadow mode so recommendations can be audited without
  changing the model selected by OpenClaw.
- Respect OpenClaw named/dev profile isolation for all legacy default paths.
- Add reproducible packaging, SBOM/provenance checks, and expanded security,
  fallback, pricing, routing, integrity, and isolation regression coverage.
- Keep the Free distribution free of the private classifier, registry,
  customer evidence, credentials, and deployment backups.

## 1.3.0-rc.3 — 2026-08-26

- Respect OpenClaw named/dev profile isolation by remapping legacy
  `~/.openclaw/...` defaults through `OPENCLAW_STATE_DIR`.
- Add regression coverage for profile-scoped paths while preserving ordinary
  home-relative paths.

## 1.3.0-rc.2 — 2026-08-26

Release candidate. Reconstructs the useful family-routing experiment in the
authoritative public source tree without carrying forward the unsafe installed
alpha implementation.

### Added

- Opt-in `familyResolution` for explicit `family:<alias>` values in
  `configuredRoutes` only.
- Provider intersection: candidates must be approved by the alias and present
  in OpenClaw's configured provider map.
- Complete-price and freshness gates with `lowest_cost` or bounded `newest`
  selection. Unresolved aliases safely pass through.

### Fixed

- Reject null, blank, half-priced, and 0/0 placeholder rates instead of
  coercing them into a priced zero-dollar call.
- Preserve the documented static behavior of `cheap` mode; it never performs
  family resolution or silently upgrades to a newer model.
- Keep the release candidate npm-private until independent review passes.

### Verification

- Added family-resolution, provider-filter, stale/corrupt-catalog, safe
  fallback, split override, and false-zero regression tests.
- Added direct owner-override, session-provenance, interceptor-priority, and
  fail-open/fail-closed routing tests after independent review.
- Added fail-closed SHA-256 verification of the paired Intelligence classifier
  before dynamic import.
- Added a reproducible quality gate and CI workflow.

## 1.2.4 — 2026-08-23

Patch release. Preserves the private Intelligence layer’s structured
family-resolution result in the existing local routing audit record. No private
classifier, benchmark data, or prompt content is added to the Free package.

## 1.2.3 — 2026-08-23

Patch release. Makes the Intelligence startup status accurately say when a
deployment is in shadow mode. Routing behavior is unchanged from 1.2.2.

## 1.2.2 — 2026-08-23

Patch release. Adds an explicit no-routing-change shadow gate for the separately
licensed Intelligence layer.

### Added

- **Intelligence shadow mode.** Set `intelligence.shadow: true` to evaluate and
  audit every Intelligence recommendation while returning no model override to
  OpenClaw. This permits a release canary before live routing is enabled.

### Verification

- Added a routing-mode test that proves a shadow recommendation cannot alter
  the host selection while its recommended model remains available in the audit.

## 1.2.1 — 2026-08-22

Release-metadata correction. Runtime behavior is unchanged from 1.2.0.

### Fixed

- **Release provenance.** The CycloneDX SBOM now points at the exact public
  source commit for this release. Version 1.2.0's plugin archive remains
  intact, but its immutable SBOM asset carried an incorrect VCS commit URL.

### Verification

- The source, package, manifest, runtime identity, checksum, and SBOM now
  point to one exact release commit.

## 1.2.0 — 2026-08-22

Minor release. Makes the documented static-route behavior real and makes an
explicit Intelligence selection fail visibly instead of silently changing mode.
No private classifier, registry, learning system, customer evidence, or provider
credential is included in the Free package.

### Fixed

- **Static configured routes now honor host-supplied task labels.** `configured`
  mode checks the documented structured labels, then optional `default`; it
  never reads or classifies message text.
- **Explicit Intelligence mode no longer silently downgrades.** When the
  separately licensed layer is unavailable or incompatible, routing passes
  through to the host and records `explicit Intelligence mode unavailable`.
  `auto` retains its documented safe fallback behavior.

### Verification

- Added routing-mode tests for structured labels, default fallback, prompt
  non-inspection, and explicit-Intelligence unavailability.
- Added a release identity test so package, manifest, and runtime versions must
  agree.

## 1.1.2 — 2026-08-21

Patch release. Aligns runtime identity with package metadata and adds a
fail-closed compatibility contract for the separately licensed ToggleLogic
Intelligence layer. Free routing behavior is unchanged.

### Fixed

- **Consistent release identity.** The running plugin, package metadata, and
  OpenClaw manifest now report the same version.

### Safety

- **Private Intelligence compatibility fails closed.** Intelligence is accepted
  only when its release manifest is released, version-consistent, declares seam
  ABI 1, and explicitly includes the running Free-plugin version in its
  compatibility interval.
- **Public/private boundary remains explicit.** The Free package contains no
  classifier, model registry, learning system, customer evidence, or private
  Intelligence source. Missing or incompatible Intelligence is never activated.

### Verification

- The ToggleLogic test suite passes 14 tests.
- The ClawHub Plugin Inspector reports zero issues and zero warnings.

## 1.1.1 — 2026-08-14

Patch release. Resolves current ClawHub manifest validation findings. Routing,
cost observation, fleet attribution, and all runtime behavior are unchanged.

### Fixed

- **Current OpenClaw manifest compatibility.** Removed unsupported top-level
  `license` and `categories` fields from `openclaw.plugin.json`. License
  information remains in the supported `package.json` package metadata; package
  keywords remain available for discovery.

### Verification

- ClawHub package validation passes with zero issues and warnings against
  OpenClaw `2026.8.1-beta.1` and `2026.7.1-2`.
- The ToggleLogic test suite passes (12 tests).

### Compatibility

- Minimum OpenClaw remains `>=2026.6.5`.
- No configuration or behavior change is required for an existing 1.1.0 user.

## 1.1.0 — 2026-08-11

Minor release. Adds privacy-safe local fleet metering. Routing is unchanged.

### Added

- **Deployment attribution.** Cost-log call and summary rows now carry a stable
  `deploymentId` and optional `costCenter`, configured as non-secret portable
  slugs. When no deployment ID is configured, the local hostname is used.
- **Versioned ledger contract.** Fleet rows declare
  `schema: togglelogic.fleet-usage.v1`, allowing a headquarters collector to
  distinguish and validate compatible deployment records.
- **Invoice-safety markers.** Locally calculated dollar figures declare
  `costBasis: public-rate-estimate` and `invoiceEligible: false`. A fleet
  operator must reconcile totals with authoritative provider billing before
  invoicing a customer.

### Privacy

- The ledger remains local and contains no prompt or assistant text.
- ToggleLogic does not send usage, deployment identifiers, cost centers, or
  customer information to Motherboard or any ToggleLogic endpoint.
- Attribution accepts only short slug values; email addresses, filesystem paths,
  and other free-form customer data are rejected by normalization.

### Tests

- Added regression coverage for attribution normalization, row and summary
  stamping, hostname fallback, schema identity, and invoice-safety markers.

### Compatibility

- Minimum OpenClaw remains `>=2026.6.5`; routing behavior is unchanged.

## 1.0.6 — 2026-08-02

Patch release. Correctness fix to cost visibility. Routing is unchanged.

### Fixed

**Cost visibility was lying for a specific case. It's fixed.**

The cost observer had a hole. It computed a dollar figure any time the
model was priced, without checking whether the call actually reported
token usage. When a priced call came back with no usage, or with
non-finite usage, the missing tokens got treated as zero. The result:
`costUsd: 0.00`. A reported number. Nothing distinguished it from a call
that actually cost nothing.

The whole point of cost visibility is that an unpriced call is loud and
never shows up as a false $0.00. This broke that for the missing-usage
case. A day full of these calls could read as zero spend. That's the
exact thing the feature exists to prevent.

It shipped this way in 1.0.3 on 2026-07-06 and has been in every build
since, including the 1.0.5 you can download today.

**What changed:** There are now three distinguishable outcomes instead
of two. A priced call with valid usage records its real cost. A priced
call with missing or non-finite usage goes loud. It is marked
`usageMissing` with the reason `priced-but-usage-missing`, no dollar
figure is recorded, and it counts in the loud bucket so a day full of
them can't read as $0.00. An unpriced model stays loud, same as before.

### Tests

There was already a test carrying the guarantee's name. It only checked
the missing-price half. The missing-usage half that produced the false
zero had never been tested. That's how it shipped without anyone
catching it.

There is now a test covering all four cases: priced+usage-present,
priced+usage-missing, priced+usage-non-finite, unpriced. It fails on
1.0.5. It passes on 1.0.6. The old test is renamed to its actual scope.

### Compatibility

Unchanged. Minimum OpenClaw `>=2026.6.5`. Validated through 2026.6.11.
OpenClaw's plugin manifest has a minimum floor field only. No ceiling
field exists in the loader, so the validated upper bound lives here,
not in the manifest.

## 1.0.5 — 2026-07-15

Patch release. **Routing behavior is unchanged except for owner-override TTL enforcement.**

### Added
- **Optional owner-override expiry (`expires_at_ms`).** An owner-override state file MAY carry a numeric `expires_at_ms` (epoch milliseconds). Once that deadline passes the override stops applying and routing returns to automatic selection — no file rewrite required. Overrides with **no** `expires_at_ms` behave exactly as before (they hold until cleared).

### Fixed
- **Expired overrides are no longer honored.** An override with a past `expires_at_ms` is now rejected (Codex audit finding); previously it was still applied.
- **Malformed `expires_at_ms` fails closed.** If the field is present but not a finite number, the override is rejected and a structured audit event (`routing.decision`, outcome `failure`, `owner_override_rejected`) is emitted — never silently honored.
- **Plugin version string corrected.** `PLUGIN_VERSION` was stale at `1.0.3`; it now matches the package version.

### Compatibility
- Supported OpenClaw unchanged from 1.0.4.

## 1.0.4 — 2026-07-09

Patch release. **Routing and cost-visibility behavior are unchanged from 1.0.3.**

### Fixed
- **Complete manifest description.** Restores the full plugin description in `openclaw.plugin.json`, which was truncated in the 1.0.3 manifest. The published package and the ClawHub listing now carry the complete description — this corrects listing text only, with no routing, pricing, or behavior change.

### Compatibility
- Supported OpenClaw unchanged from 1.0.3.

## 1.0.3 — 2026-07-06

Adds an opt-in **cost-visibility** capability. **Routing behavior is unchanged from 1.0.2.**

### Added
- **See what your calls cost, in dollars.** A new opt-in capability observes each model call (the `llm_output` hook, observe-only) and reports per-model and per-day dollar cost, using **dynamic public pricing** fetched live from [Models.dev](https://models.dev) — cached locally, refreshed on a slow cadence, never fetched per call. Curated to the major providers' standard lineups (Anthropic, OpenAI, Google, xAI, Meta).
- **Bundled offline fallback.** If the live pricing source is unreachable, pricing degrades to a bundled LiteLLM snapshot (MIT) — last-known-good, not a crash and not $0.00.

### Changed
- **Unpriced usage is loud, never a silent $0.00.** Any model the curated free-tier set can't price is reported explicitly as *unpriced* (model + token count, shown separately) and is never rolled into the dollar total as $0.00. Priced and unpriced always appear together.

### Safety
- **Observe-only. Never enforces.** Cost visibility reports; it never blocks, halts, or downgrades a call. Spend enforcement and all-model / guaranteed-current pricing remain the paid tier.
- **No callback to us.** Pricing is fetched directly from the public source; the plugin never contacts any ToggleLogic/Motherboard endpoint for pricing.

### Compatibility
- The cost observer requires the gateway's `plugins.entries.togglelogic.hooks.allowConversationAccess` (the `llm_output` hook is a conversation hook). Supported OpenClaw unchanged from 1.0.2.

## 1.0.2 — 2026-07-05

Metadata and compatibility release. **Routing behavior is unchanged from 1.0.1.**

### Changed
- **Correct catalog listing.** The plugin now declares its categories, so it lists under model-routing / cost-optimization instead of "Other."
- **Canonical source.** The package is now linked to its home organization repository, github.com/ToggleLogic/togglelogic-free, replacing the earlier personal-account link.
- **Explicit compatibility.** Supported OpenClaw: 2026.6.5 – 2026.6.11, validated on 2026.6.11; minimum gateway `>=2026.6.5`, plugin API `>=2026.5.2`.

## 1.0.1 — 2026-06-23

### Fixed
- **Your model selections now hold reliably.** When you pin a model for a session — or set an owner override — that choice is consistently honored above automatic routing. The routing layer still records when automatic selection *would* have chosen differently (visible in the audit stream), but your selection wins.
- **Richer routing-decision detail.** Each routing decision now records the requested model/provider and its provenance alongside the selected one, so the audit log shows what was asked for versus what was applied.

### Changed
- **Packaging metadata cleanup.** Aligned the declared minimum OpenClaw host version with the build target and removed an unsupported package metadata field, so the plugin validates cleanly against current OpenClaw.

---

## 1.0.0

- Initial public release: free-tier model routing for OpenClaw — owner overrides, static configured routes, a deliberately-simple cheapest-default, the optional licensed-Intelligence detection seam, and a structured audit stream.

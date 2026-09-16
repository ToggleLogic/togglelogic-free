# Host-integration closure — ToggleLogic 1.6.1-rc.2 (paired Intelligence 1.4.1-rc.2)

Remediation + deployment report and release recommendation for the three blockers
that held the skill-aware-routing canary at NO-GO after the 2026-09-15 failure. All
work is durable implementation on the uncommitted Free/Intelligence trees plus the
`microsoft-graph` skill; no live `openclaw.json` was mutated, nothing was installed
live/activated/published/tagged, and no customer system was touched. Every claim
below is backed by a check that was actually run (§5).

Host: **OpenClaw 2026.9.4** (`3a9d69d`), verified in-process.

---

## Blocker 1 — authoritative calendar grounding: CLOSED

**Was:** the meeting-prep contract had a deterministic `/me/calendarView` port but
**no transport** was ever wired (the plugin holds no Graph credentials and the host
exposes no synchronous pre-model affordance to invoke the installed skill), so every
lookup failed closed and the canary was NO-GO for a real future-meeting check.

**Now:** a real, deterministic subprocess grounding path — no model instruction
substitutes for it.

- **Graph side** (`microsoft-graph/scripts/calendar_bridge.py`, new): a read-only,
  sanitized `/me/calendarView` bridge that reuses the existing vault-backed
  `graph_call.py` auth layer (`resolve_account` → `_vault_get` → `graph_request`,
  401-refresh-once, exactly like `create_contact._graph`). It requires a bounded
  `[--start,--end]` window (rejects > `--max-window-hours`, default 48h, and
  `end<=start`), emits ONLY `id/subject/start/end` per event, never prints the token
  / vault value / Authorization header, and fails closed on auth / network / rate-
  limit / malformed / invalid-args / config with a structured `{"ok":false,...}`
  envelope + non-zero exit.
- **ToggleLogic side** (`src/skill-routing/calendar-bridge.js`, new): wires
  `calendarPort` through an explicitly configured **bridge executable/path**
  (`skillRouting.calendar.bridge.command`) launched with `execFile` + an explicit
  argv array (`shell:false`, injection-safe), a wall-clock timeout that `SIGKILL`s
  the child, a 1 MiB stdout cap, and strict JSON-envelope validation
  (`ok===true` + schema match + events array), feeding the existing, tested
  `createGraphCalendarPort`. Any failure rejects → the contract clarifies, never
  fabricates.
- **Wiring** (`src/capabilities.js`): builds the transport when the bridge command
  is configured and emits a `calendar-bridge` startup audit line
  (`transportWired: true|false`); the old "NO-GO / not wired" honest-status comment
  is replaced.

**Tests (all run, all green):** Graph-side
`microsoft-graph/tests/test_calendar_bridge.py` (16) and adapter
`tests/calendar-bridge.test.js` (12) cover: unique event, zero, ambiguous
(multiple), auth failure, timeout (child killed), invalid/non-JSON output, wrong
schema, non-zero exit, unwired-command, sanitization (attendees/body stripped), and
injection-resistant arguments (adversarial `--start`/`--account` reach the child as
one literal argv element; `$(...)`, backticks, `;`/`&`/`|` inert).

**Follow-up correction (intent- and skill-aware contract binding).** The grounding
above originally engaged only for the skill id `meeting-prep`, which — as this very
report notes (§5.2, "`meeting-prep` correctly absent") — is NOT installed on the
host. A natural-language meeting/calendar request there resolves instead to the
ELIGIBLE `microsoft-graph` skill (authoritative Outlook/Graph calendar) and/or
`zoom-meetings` (subordinate). Left uncorrected, the wired calendar grounding would
never actually engage for the real resolved route. `skill-contracts.js` now binds
the contract **intent-aware and skill-aware**: it applies when a turn shows a
calendar/meeting intent AND resolves to a calendar-capable installed skill
(`microsoft-graph` and/or `zoom-meetings`, or the builtin `meeting-prep`), while
generic Graph email/contact work is untouched. A meeting request resolved to Zoom
alone (no authoritative Outlook/Graph in the route) is clarified — Zoom cannot
establish an event. The deterministic safety preflight now runs **before**
route/model education/spend, so a past or unverifiable meeting is clarified with
zero model calls the moment skills resolve. Covered by
`tests/skill-contract-intent.test.js` (14) using the installed reality
(meeting-prep absent; microsoft-graph + zoom-meetings eligible).

---

## Blocker 2 — bounded-child limits: CLOSED (plugin-enforceable set) with a
## documented residual host gap

**Enforced now** (see `docs/BOUNDED-CHILD-LIMITS.md`, `src/skill-routing/
child-tool-guard.js`, `coordinator.js`):

- fresh unique child session; `promptMode:"minimal"`; `lightContext:true` (existing);
- **per-skill tool surface** — `disableTools:true` (empty surface) when a skill's
  policy declares no tools; a per-skill allowlist enforced live by a new
  `before_tool_call` guard;
- **`before_tool_call` counter/deny for child sessions** — the guard denies
  re-entrant ToggleLogic routing tools, off-allowlist tools, and any tool call past
  a hard per-run count ceiling (`maxChildToolCalls`, default 32) — and only ever
  acts on `":togglelogic-skill:"` child sessions (abstains elsewhere, never throws);
- wall-clock timeout (`waitForRun({timeoutMs})`) + host `subagents.runTimeoutSeconds`;
- pre-flight token/cost estimate gate (existing);
- **post-run actual usage audit** — every child run (success or failure) emits actual
  tool-call count, denied count, wall-clock, and stopReason.

**Residual gap (documented, NOT silently claimed):** OpenClaw 2026.9.4 `SubagentRunParams`
exposes no model-token/pass cap, no in-flight run abort, and no child token/cost in
the run/wait result. So the plugin cannot cap model-token spend; every child audit
carries `runtime_token_ceiling_enforced:false` and `model_usage_host_observable:false`.
The exact minimal host additions to close it (`maxModelTokens`/`maxModelPasses`/
`budgetUsd` + `subagent.abort` + `usage` in the result) are specified in
`docs/BOUNDED-CHILD-LIMITS.md`.

**Does the gap block a scoped canary or only global release?** Only the unbounded
GLOBAL release. A scoped owner canary is bounded by scope + fresh light-context
session + wall-clock + tool-call ceiling + pre-flight estimate, exposing only the
present owner; the uncapped dimension is model tokens within one wall-clock-bounded,
tool-limited child — an owner-observed risk. Global release stays NO-GO until the
host token/pass cap lands.

**Tests:** `tests/child-tool-guard.test.js` (7) and `tests/bounded-child-limits.test.js`
(5) — allowlist/re-entrancy/count deny, disableTools plumbing, and the usage audit
(incl. on failure).

---

## Blocker 3 — genuine isolated OpenClaw process proof: CLOSED (real gateway)

Proven first-hand in a **real OpenClaw 2026.9.4 process** against a throwaway temp
state/profile (never the live config); the loopback gateway was loopback-only
(127.0.0.1:8199, auth none, no channels), stopped, and its profile removed. The live
`ai.openclaw.gateway` was never authenticated to and never touched.

Evidence chain (reproducible via `scripts/isolated-gateway-probe.sh` for the setup
half; the running-gateway step is documented in that script's header):

1. Dev plugin loaded via `plugins.load.paths` into the temp profile; `openclaw
   plugins doctor --json` → zero `pluginErrors` (loads).
2. Fresh **paired eligible-skill snapshot generated INSIDE the temp profile** from
   `openclaw skills list --json` (25 eligible; `meeting-prep` correctly absent).
3. Isolated config validates against the real schema (`config validate` →
   `valid:true`).
4. `plugins inspect --runtime` → declares 4 typed hooks incl. `before_agent_reply`
   and the new `before_tool_call` (priority 100) + both tools; host-affordances audit
   = `success` (subagent runtime present).
5. Managed capability consent: `plugins install --link --accept-capabilities` accepts
   the declared `dangerousFlags`.
6. **The live proof:** a running gateway (`openclaw gateway --port 8199 --auth none
   --bind loopback`) received a real user turn (`openclaw agent --message "Prepare me
   for my 2 pm meeting using the meeting-prep skill." --session-key agent:main:qa-canary
   --json`). Result: reply = **"I don't have a skill that relates to what you're
   asking me to do."**; audit = `routing.decision before_agent_reply success
   skill_named_unavailable` (1 row); `before_model_resolve` rows = **0**; gateway
   model-call/auth-error lines = **0**; `durationMs = 15`. With **no API key present**
   (the same model failed with "No API key" under `agent exec`), a 15 ms success can
   only mean **the `before_agent_reply` gate handled the turn with ZERO provider
   model calls.** Verdict asserted programmatically: `True`.

**Honesty note (exact evidence, not overstated):** a one-shot `openclaw agent exec`
turn does NOT dispatch the conversation reply hooks (it goes straight to model
resolution; runtime-active `hookNames=[]` until a Gateway start), so the proof uses
the running-gateway path above, which is the correct surface. The prior in-process
`tests/e2e-gateway.test.js` remains labeled as an in-process harness, not a gateway
round trip.

---

## Native session-maintenance candidate + doctor/compat (isolated)

- `docs/SESSION-MAINTENANCE-CANDIDATE.md` — a host-side config using ONLY real
  2026.9.4 keys (`agents.defaults.compaction.maxActiveTranscriptBytes` + `memoryFlush.
  forceFlushTranscriptBytes`, `agents.defaults.subagents.runTimeoutSeconds`,
  `session.reset.{mode,atHour}`, `session.resetTriggers`), **validated by
  `openclaw config validate` in an isolated profile** (`valid:true`, no warnings). It
  bounds the MAIN session (the amplification substrate), complementing the plugin's
  bounded child. No live mutation.
- **Doctor/compat (dev package, isolated):** `plugins doctor` → zero `pluginErrors`
  (an untrusted-provenance warning clears after a managed `--link` install →
  `trust.reason: origin-path`). `plugins validate` reports the entry lacks *static*
  tool/feature authoring metadata — a pre-existing structural trait (tools are
  registered dynamically in `register()` and declared in `contracts.tools`); the
  manifest itself parses and its `configSchema`/`configContracts` are accepted. The
  manifest is valid JSON and the isolated config validates.

---

## Checks run (§5) — all green

| Suite | Command | Result |
| --- | --- | --- |
| Free unit/integration | `npm test` | **197 pass / 0 fail** |
| Free quality gate | `npm run quality` | **PASS** (syntax + release-identity + pack allowlist/diff) |
| Free live pricing verifier | `node tests/proof.mjs` | **PASS** (live + bundled fallback + loud-unpriced) |
| Graph bridge | `python3 -m unittest discover -s tests` | **62 pass** (incl. 16 new) |
| Intelligence quality | `npm run quality` | **PASS** (release manifest + BOM 29 files) |
| Intelligence canary | `npm run canary:skill-routing` | ran (`production_routing_changed:false`) |
| Intelligence release (pair) | `TOGGLELOGIC_FREE_PATH=… npm run release:quality` | **PASS** — release pair PASS (Intelligence 1.4.1-rc.2 + Free 1.6.1-rc.2) |
| Isolated gateway | `bash scripts/isolated-gateway-probe.sh` | **exit 0** (6/6) + live gateway proof |
| Exact model-family | `tests/family-resolver.test.js` (in `npm test`) | **PASS** |

**Live-verifier / shadow honesty:** the plugin refuses to represent shadow as active
— host-affordance or scope failures force shadow with a loud audit line; the calendar
port fails closed when the bridge is unwired; child audits never claim a runtime
token ceiling. Any verifier of live/active behavior must FAIL (not pass) in shadow.

---

## Preserved invariants

- **Universal no-skill fail-closed rule** — on a governed turn, every actionable
  request resolves to an active installed skill or returns the verbatim fail-safe;
  proven live in the gateway (§Blocker 3, step 6).
- **Active eligible-inventory snapshot design** — the resolver's membership set is the
  deployment-owned, versioned + fingerprinted snapshot of the ELIGIBLE set; fails
  closed on missing/stale/wrong-source/wrong-version/drift. Regenerated in-profile for
  the gateway proof.

---

## Release recommendation

- **Scoped owner canary (Al's SAM Telegram DM): GO** — pending one operator step:
  install a durable, reviewed `meeting-prep` skill and wire
  `skillRouting.calendar.bridge.command` to `calendar_bridge.py`, then regenerate the
  inventory snapshot. All three blockers are closed for a scoped canary; the residual
  model-token gap is owner-bounded (§Blocker 2).
- **Global / unattended release: NO-GO** until OpenClaw adds a subagent
  model-token/pass cap + in-flight abort (`docs/BOUNDED-CHILD-LIMITS.md`). The plugin
  must not claim a runtime token ceiling it cannot enforce.
- **Versioning:** keep the paired identifiers **Free 1.6.1-rc.2 / Intelligence
  1.4.1-rc.2**; the pair verifier passes. Promote to a stable pair only after the
  scoped canary runs clean and (for global) the host cap ships. No tag/publish was
  performed.

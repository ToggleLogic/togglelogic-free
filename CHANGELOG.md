# Changelog

## 2.2.0 — 2026-10-22

Milestone M1 part 1 — host adapters and the gateway-neutral Decision API, built
in the steps of `docs/design/M1-HOST-ADAPTERS-AND-DECISION-API.md` §7 (steps 1–5
and 8). OpenClaw routing is unchanged at every step. Behavior changes, all
below: the audit outcome for unchanged-model decisions (D28), the notification
interpreter default, and the new-session marker folder fix.

- **Step 2 — injected paths, clock and state store (no behavior change).**
  New host-neutral `src/core/paths.js` (`createPaths({ home, stateDir })`),
  `src/core/clock.js` and `src/core/state-store.js` (atomic JSON documents;
  a missing document reads as null, a corrupt one throws). The OpenClaw
  adapter (`src/adapters/openclaw/paths.js`) resolves HOME and
  `OPENCLAW_STATE_DIR` exactly as 2.1.x and injects one `paths` object into
  the audit log, routing log, usage events, cost log, pricing cache, balances,
  owner override, governed escalation and the Intelligence detector. A test
  fails if anything under `src/core/` reads the environment, the OS home or
  the host SDK.
- **Step 3 — `decide()` extracted into `src/core/decide.js` (no behavior
  change).** `createDecisionCore({ policy, services })` runs the decision order
  of design §4.3 on a `DecisionRequest` (`requested`, `defaultRef`,
  `candidates`, `fallbacks`) and returns a `togglelogic.decision/v1` response
  (`decision`, `reason`, `rationale`, `engine`). The OpenClaw interceptor is
  now `toDecisionRequest` → `decide` → `applyDecision`; preflight caching,
  duplicate-prompt suppression and session-store provenance stay in the
  adapter, and host state is still read at the same point in the order.
  Proof: a recorded-decision replay fixture (38 scenarios, every selection
  reason, recorded from the step-2 code) must match exactly: return value,
  routing record, audit events, usage events, warnings and seam calls.
- **Step 4 — OpenClaw adapter (no routing behavior change).** Everything
  OpenClaw-specific now lives in `src/adapters/openclaw/`: the plugin entry
  (`entry.js`, `definePluginEntry`), hook registration and service wiring
  (`register.js`), the routing hook (`interceptor.js`), session-store
  provenance (`session-store.js`), the conversation-access check and the
  owner-override notification helper. `src/index.js` only carries the version
  label and builds the adapter. The old module paths re-export the new ones, so
  imports keep working. A test fails if OpenClaw-only code appears outside the
  adapter.
- **Fixed: new-session marker folder.** It now follows the same state-path
  rules as every other ToggleLogic file (HOME, and `OPENCLAW_STATE_DIR` with
  `~` expansion). Before, a `~/…` state dir produced a literal `~` folder.
  With `OPENCLAW_STATE_DIR` unset the folder is unchanged.
- **Step 5 — Decision API v1 responses, decision matrix and replay.**
  `decide()` now returns a response that validates against
  `docs/design/schemas/decision-response.v1.schema.json`: it adds
  `policyDigest` (`sha256:` of the canonical policy JSON) and `costEstimate`
  (dollars for the model that will run, only when the caller supplies
  `usageEstimate` and a pricing service; otherwise `priced: false`, `usd: null`
  and a named `unpricedReason` — never a $0 stand-in), and omits empty
  `provider`/`model` instead of sending null. The internal `recorded` flag is
  gone from the response. New `src/core/request.js` maps a v1 wire request to
  the core request; `content` is never copied. New
  `togglelogic-decide replay --log <routing.jsonl> --config <file> [--json]`
  re-runs recorded routing decisions against a policy and prints the
  differences (exit 2 when any differ). Records that depended on state the log
  does not carry (owner override, the Intelligence seam, provider availability,
  dispatch errors, or a host task label the log did not carry when the policy
  routes on labels) are counted by reason, not guessed at. Replay reads only
  and writes nothing. Invalid token counts and pricing-service errors give
  `invalid_usage_estimate` and `pricing_error`; `decide()` never throws on a
  cost estimate. Tests: a 112-row decision matrix (modes × requested source ×
  provider availability) validates every request and response against the v1
  schemas, requires the OpenClaw hook to return exactly the core's decision,
  and proves request content never reaches a response, routing record, audit
  event or warning.
- **Changed (D28): audit outcome for unchanged-model decisions.** A
  `routing.decision` audit event for a decision that leaves the model unchanged
  is now `noop`; 2.1.x reported `success` when the passthrough came from mode
  dispatch (passthrough mode, no configured or cheap route, Intelligence
  declined, shadow or unavailable). Routing is unchanged. The replay fixture
  was re-recorded and differs from the step-2 recording only in that field, in
  those 7 scenarios.
- **Step 8 — Changed: owner-override notification interpreter is
  configurable.** New `ownerOverride.askInterpreter` (default `python3`,
  resolved from the gateway's `PATH`; a value containing `/` or starting with
  `~` is a file path). 2.1.x always ran `/usr/bin/python3`; to keep exactly
  that, set `askInterpreter` to `/usr/bin/python3`. Only matters when
  `features.ownerOverrideAsk` is enabled. The plugin manifest accepts the new
  key.
- **Step 8 — Deprecated: `src/enforcement/bounded-executor.js`.** It was never
  wired into the plugin. It is now excluded from the npm package and stays in
  the repository only for its tests; the next major removes it.
- **Fixed (tests only): the packaging check no longer spawns npm.** The test
  that proves the deprecated bounded executor stays out of the package now
  asserts the `files` ordering directly instead of running `npm pack` in a child
  process, which raced with other test files under parallel runs. The packed
  file list itself is still verified by `npm pack --dry-run` in every release
  task. No product-code or behavior change.

## 2.1.6 — 2026-10-17

Patch over 2.1.5. Owner opt-in invoice eligibility for public-rate estimates.
Default behavior is unchanged.

- **Added: `costVisibility.attribution.invoiceEstimates`** (boolean, default
  `false`). When a deployment owner sets it to `true`, a cost row that is priced,
  has complete usage and belongs to a billable deployment is written with
  `invoiceEligible: true`. Its `invoiceEligibleReason` stays
  `public-rate-estimate`, so the basis is always visible. Unpriced,
  usage-missing and non-billable rows are never eligible; they stay loud, never
  $0. Provider-invoice reconciliation can replace the estimate later.
- **Fixed:** the export kept a recorded `invoiceEligible: true` even on a
  non-billable row; it now keeps eligibility only while the row is billable.
- Every cost row and export row continues to carry `requestId` (or
  `requestIdReason` when correlation is unavailable).
- No change to export columns, file layout or routing.
- `.claude/settings.local.json` added to `.gitignore`.

## 2.1.5 — 2026-10-13

Patch over 2.1.4. Audit-write failures are loud, counted and recovered; CI runs
on the supported Node versions and against a real OpenClaw host package. No
configuration or file-layout change.

- **Fixed: audit-write failures were silent after the first.** The audit writer
  warned once and then dropped every later failure for the life of the process.
  Now every failed write is counted, and:
  - an error-level host log names the error code, the count and the time of the
    first failure — on the first failure, then at most once a minute with
    cumulative and since-last-report counts, and again at every `session_start`
    while writes keep failing;
  - an `audit_write_failed` event (counts, timestamps, error code; no paths or
    error text) is written to the separate events file;
  - the audit capability gate (`id: "audit"`) reports `ready: false,
    reason: "audit-write-failing"`; the gate is included in the
    `plugin.register` audit record and exposed by `audit.health()`;
  - the first successful write afterwards is followed by an
    `audit.write.recovered` record (controls AU-2, AU-3, AU-5, AU-12) stating
    `failedCount`, `firstFailureAt`, `lastFailureAt`, `lastErrorCode` and
    `recordsLost`, so every gap is visible in the audit log itself.
  Routing and dispatch remain fail-soft; failed records are not buffered.
- **Added: license-header and patent-identifier test.** Nine source files that
  lacked the published license header now carry it
  (`index.js`, `capabilities.js`, `routing/interceptor.js`, `config/normalize.js`,
  `path-utils.js`, `registration-mode.js`, `governance/approval-gate.js`,
  `enforcement/artifact-manifest.js`, `enforcement/bounded-executor.js`);
  `tests/license-header.test.js` fails on any shipped file without it.
- **CI:** Node 24 and 26 on Linux, macOS and Windows (Windows informational
  until its first green run), plus a host-compatibility job that installs
  OpenClaw 2026.9.9 and 2026.10.2 and registers the plugin against the real
  plugin SDK (`tests/openclaw-host-compat.test.js`; skipped locally when no
  OpenClaw package is installed). CI previously declared Node 22, which the
  supported OpenClaw host does not run on.
- Tests: 8 new; 198 pass without a host package, 200 with one (Node 24.21 and
  26.11 on Linux, OpenClaw 2026.9.9 and 2026.10.2).

## 2.1.4 — 2026-10-12

Patch over 2.1.3. Session model pins are recognised by provenance again on
OpenClaw releases that keep sessions in SQLite.

- **Fixed: a user's session pin is honored even when it names the agent's
  default model.** The pin reader now asks the host through its read-only
  session accessor (`api.runtime.agent.session.getSessionEntry`), which every
  plugin receives and which returns `modelOverrideSource`. A `user` pin wins
  above routing (`selectionReason: user_selection`, `pin_source: host_runtime`).
  Previously such a pin was routed away from, because `request_selection` only
  sees a *difference* from the default. This removes the 2.1.3 "known
  limitation"; no host change is needed.
- **Fixed: a host-set `auto` override is no longer treated as a user choice.**
  When the session's stored override has `modelOverrideSource: "auto"` (or host
  fallback provenance) and is the model the host resolved, routing applies
  normally. An explicit one-off `--model` that differs from it is still honored
  via `request_selection`. `modelOverrideSource: "default"` is not protected.
- **Changed:** the legacy `sessions.json` reader is now the fallback, used only
  when the host has no session accessor (older OpenClaw). The once-per-run
  `session_pin_store_absent` audit event and warning now fire only when neither
  source can be read, and include the host error when there is one.
- Removed `canary-2.1.2.mjs` and `docs/PROPOSAL-fail-closed-mode.md` from the
  repository root (internal working files; never in the package).
- Tests: 9 new (`tests/session-pin-host-runtime.test.js`); 192 pass.

## 2.1.3 — 2026-10-12

Patch over 2.1.2. Session model-pin observability + clarity. On OpenClaw
releases that keep sessions in SQLite, the legacy per-agent pin store
`sessions/sessions.json` does not exist, so `src/routing/session-store.js`
always returns `read_error` and the interceptor's `user_selection` branch
(which requires `status: "found"`) never fires. This was silent.

- **A user's model selection is still honored** on these releases: when the host
  resolves a one-off `--model` or a stored `/model` session pin into the
  request's model, the interceptor's `request_selection` branch (added in 2.0.3)
  passes it through above routing. That path reads the host-resolved model from
  the hook context, not the legacy file, so it is unaffected by the SQLite move.
- **New:** the plugin now emits a `session_pin_store_absent` audit event (and an
  info log) **once per gateway run** when the legacy pin store is unreadable, so
  the inert legacy path is observable instead of silently dead. It records the
  store path + read error only — never conversation content.
- The legacy `sessions.json` reader is **retained** (it still works on older
  OpenClaw releases that have the file); nothing is removed, so there is no
  regression for those deployments.
- Tests cover the once-per-run emit on `read_error` and that `request_selection`
  still honors a host-resolved non-default model with no `sessions.json` present.

Known limitation (needs an OpenClaw host change, not a Free-plugin fix): a user
pin **equal to** the agent's host default is not "locked" — `request_selection`
only triggers on a *difference* from the default, and OpenClaw does not expose
the pin's provenance (user vs auto) to a plugin hook, so the plugin cannot tell
a deliberately-pinned default from an ordinary default. Tracked for a host RFE.

## 2.1.2 — 2026-10-11

Patch over 2.1.1. Makes the conversation-access hook-permission defect
observable. When `features.routing.enabled` is true but the host has not set
`plugins.entries.togglelogic.hooks.allowConversationAccess: true`, the host
blocks ToggleLogic's conversation hooks, so routing silently never fired and
turns fell through to the host default model — the only prior signal was a
host-side startup warning. The plugin now surfaces it itself:

- Error-level startup log naming `plugins.entries.togglelogic.hooks.allowConversationAccess`
  and stating routing is disabled until the flag is set to true and the gateway
  is restarted.
- A `routing.skipped` audit event (controls AU-2 / AU-3 / AU-12), emitted once
  at register time and again on each `session_start` — a non-gated lifecycle
  hook that still fires — so the skip recurs every time routing is skipped. No
  conversation content is recorded.
- When access is denied the routing conversation hooks are no longer registered
  (they would be blocked anyway); the routing and governedEscalation capability
  gates report `ready: false` with reason `conversation-access-denied` in the
  `plugin.register` audit — the readiness indicator.
- A reusable health-check primitive (`togglelogic-conversation-access-required`,
  `src/health/conversation-access-check.js`) encodes the not-ready logic and is
  unit-tested. NOTE: OpenClaw 2026.9.9 does **not** run an external plugin's
  health checks in `openclaw doctor` (doctor loads external plugins with
  `activate:false`), so this primitive is not surfaced there today; the live
  readiness signal is the capability gate + error log + `routing.skipped` audit
  above. The primitive ships ready for a host/bundling that runs plugin health.
- README documents the flag.

Routing code behavior when conversation access **is** granted is unchanged.

## 2.1.1 — 2026-10-10

Documentation only. No code or behavior change from 2.1.0; hosts on 2.1.0 do not
need to upgrade.

- README now describes spend tracking and links to togglelogic.ai, including
  [what it costs us](https://togglelogic.ai/spend-tracking/).

## 2.1.0 — 2026-10-10

Spend tracking release. Same code as 2.1.0-rc.3; only the version changes.

- Every routed call is recorded in dollars with lineage, price source, billable
  flag and invoice-eligibility reason, correlated to the routing requestId.
- Call-time cost events, monthly CSV/JSON export (`togglelogic-cost export`),
  monthly budget alerts and prepaid top-up balance estimates.
- Billing refusals are detected from provider error evidence; the provider is
  put in cooldown and later turns reroute, while owner overrides still win.
- Ordered fallback by model lineage (`routing.fallbackLineages`). Off unless
  configured.

### Install notes

- If your host pins the ToggleLogic Free version in a plugin or skill inventory
  snapshot, regenerate that snapshot for 2.1.0 **before** the gateway restart.
  Otherwise the host may refuse the version mismatch and need a second restart.
- Keep rollback copies of the plugin **outside** the plugin extensions folder.
  The host scans every folder there, and a backup copy causes a
  "duplicate plugin id: togglelogic" warning.

## 2.1.0-rc.3 — 2026-10-05 (release candidate: integration fixes; HQ canary)

- Keep registration active when fallback lineages are invalid, auditing rejected entries while retaining valid order; share one usage-events writer across routing, provider availability, and cost observation.

## 2.1.0-rc.2 — 2026-10-05 (release candidate: TL-5, TL-6, fallback lineages; canary only)

- Resolve fallback lineages to the newest host-configured child using public release dates, skip provider cooldowns, audit unresolved plans, and share mid-name version derivation with the cost ledger.

- TL-6: Record prepaid top-ups, report honest remaining-balance estimates with missing-cost counts, and persist once-per-top-up low-balance alerts.

- TL-5: Detect billing refusals from provider error evidence, emit provider availability events, and reroute subsequent turns during cooldown while preserving owner overrides.

## 2.1.0-rc.1 — 2026-10-03 (release candidate: TL-2, TL-9, TL-7; canary only)

- TL-7: Complete attributed call rows with lineage and price provenance, explicit
  billable/invoice eligibility, offline monthly CSV/JSON exports and dollar
  rollups, and restart-aware monthly budget threshold events with missing-cost counts.

- TL-9: Emit deduplicated call-time cost events and matching audit records; distinguish priced, unpriced, and usage-missing summaries without coverage upsells. Daily summaries now use UTC day boundaries
  instead of host-local time; rename the unpriced reason `not-in-curated-free-set`
  to `outside-price-coverage`; take the ledger `provider` field from the host event.

- TL-2: correlate cost-ledger calls with the routing requestId (also used as
  audit correlationId) through host run/turn identity. Missing correlations
  and aggregate summaries explicitly record requestId: null and requestIdReason.

## 2.0.4 — 2026-09-26

- Correct the runtime version label: 2.0.3 reported itself as 2.0.2 in routing
  and audit records. No behavior change from 2.0.3.
- Add a release guard test so the runtime version must match package.json.

## 2.0.3 — 2026-09-26

- Honor an explicit model choice. When the host resolves a request to a model
  other than the agent's configured default — a one-off `--model`, a `/model`
  selection held in the host's session state, or a host fallback attempt —
  ToggleLogic Free now passes it through (`selectionReason: "request_selection"`)
  instead of silently replacing it with its routing default.
- Fixes user `/model` selections being overridden on OpenClaw releases that store
  sessions in SQLite, where the legacy `sessions/sessions.json` no longer exists.
- Owner overrides still take precedence. Requests on the host default route as before.

## 2.0.2 — 2026-09-20

- Eliminate an OpenClaw lifecycle race that could let a brand-new session reach
  model resolution before its `session_start` signal was visible to routing.
- Apply a bounded settling window only on the first routing observation of a
  session; established sessions continue without the delay.
- Discard late lifecycle markers after a session has already been observed so a
  later turn cannot be mistaken for the first turn.

## 2.0.0 — 2026-09-18

This release restores the canonical ToggleLogic Free product boundary.

### Included in ToggleLogic Free

- Generic model routing from owner overrides, host-supplied structured labels,
  deployment-declared defaults, or the separately licensed Intelligence seam.
- Generic approval, audit, cost-visibility, and bounded-execution primitives.
- Fail-loud compatibility verification between Free and Intelligence releases.

### Removed from ToggleLogic Free

- Assistant-specific intent interpretation and workflow resolution.
- Application-owned contracts, identities, integration policy, and presentation.
- Public workflow planning/run tools and their application-specific configuration.
- In-package model-family catalog judgment; that judgment belongs to Intelligence.

These removals are intentionally breaking, which is why the release is 2.0.0.
Deployments that used the removed 1.7.x surface must install an application-side
orchestration adapter before upgrading.

### Correction to the 1.7.x narrative

The 1.7.x changelog described application workflow improvements as ToggleLogic
Free capabilities. That description blurred the product boundary. Those changes
belonged to the consuming assistant layer. They are not capabilities of the Free
product and are not included in the 2.0.0 package.
# 2.0.1 (2026-09-19)

- Keep governed model approvals bound to their original request for a practical 30-minute default window.
- Fail closed when a late approval arrives after expiry, instead of allowing the bare approval to become a new model request.
- Default cost receipts to governed escalations only; ordinary conversation remains conversational. Deployments may restore the former behavior with `governedEscalation.receiptMode: "always"`.

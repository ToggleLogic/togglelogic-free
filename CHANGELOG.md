# Changelog

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

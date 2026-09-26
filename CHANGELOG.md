# Changelog

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

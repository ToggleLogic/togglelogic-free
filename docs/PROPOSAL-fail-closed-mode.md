# Proposal: opt-in fail-closed routing mode

**Status: PROPOSAL — not implemented in 2.1.2. Requires Al's approval before any
code lands.**

## Problem

Today, when routing cannot function, OpenClaw silently passes the turn through
to the host default model. The two main ways routing "cannot function" are:

1. **Conversation access denied** — the host did not grant
   `plugins.entries.togglelogic.hooks.allowConversationAccess: true`, so the
   routing hook is never registered (addressed observably in 2.1.2: error log,
   `routing.skipped` audit, doctor health check — but the turn still runs
   unrouted).
2. **Intelligence / registry unavailable** — in Intelligence mode the seam is
   down, or in fallback-lineage mode no child resolves, so routing degrades to a
   passthrough / cheap default.

2.1.2 makes case (1) *visible*, but in both cases the turn still executes on
whatever model the host picks. For most deployments that is the right default:
degrade, don't break. But some deployments have a hard requirement that a turn
must **never** run un-routed — e.g. a cost-control or compliance deployment
where an un-routed turn can hit an expensive or non-approved model. For those,
silent passthrough is itself the failure.

This proposes an **opt-in** config flag that converts "cannot route" from a
silent passthrough into a hard, auditable refusal.

## Proposed config shape

A single boolean, default `false`. Two candidate homes (pick one in review):

```jsonc
// Option A — under routing (scopes to the routing capability):
"config": { "routing": { "failClosed": false } }

// Option B — under intelligence (frames it as "fail closed when the
// intelligence path can't make a decision"):
"config": { "intelligence": { "failClosedOnNoConversationAccess": false } }
```

Recommendation: **Option A, `routing.failClosed`.** The condition is broader than
Intelligence (it also covers conversation-access denial and fallback-lineage
exhaustion), so scoping the flag to `routing` reads correctly. `intelligence.*`
should keep owning only Intelligence-specific behavior (see interaction with
`intelligence.fallbackOnError` below).

Normalization: default `false` via the existing `feature`/boolean pattern in
`src/config/normalize.js`; add to `openclaw.plugin.json` `configSchema` under
`routing`.

## Proposed behavior

### At startup (register time)

- **`failClosed: false` (default):** exactly today's behavior plus the 2.1.2
  observability signals. If conversation access is denied, log the error, emit
  `routing.skipped`, register the doctor health check, and do not register the
  routing hooks. Turns run on the host default.
- **`failClosed: true` and conversation access denied:** this is a
  non-recoverable misconfiguration — the plugin cannot intercept turns at all,
  so it cannot refuse them per-turn either. The only honest fail-closed action
  at startup is to make the condition impossible to miss: emit the error log and
  `routing.skipped` as `outcome: failure` (not `skip`), register the health
  check at `severity: error`, and — if and only if the host exposes a supported
  "refuse to start / block activation" signal to plugins — use it. The plugin
  MUST NOT try to crash the gateway process or throw out of `register()`; that
  would take down unrelated capabilities and is not a supported contract. If no
  host-level block signal exists, document that `failClosed` cannot be enforced
  without conversation access and that operators must treat the doctor check as
  a gating pre-flight.

### Per turn (when hooks ARE registered but routing can't decide)

This is where `failClosed` has teeth. When the routing hook fires but routing
cannot produce a decision (Intelligence unavailable, registry missing, all
fallback lineages exhausted):

- **`failClosed: false`:** today's behavior — return the documented passthrough
  / cheap fallback, emit the existing `fallback_unresolved` / passthrough audit.
- **`failClosed: true`:** refuse the turn. Return a host-recognized error/abort
  from the hook rather than an empty override, with an operator-facing reason
  ("routing required but unavailable; refusing per routing.failClosed"). Emit a
  new audit event (proposed `ROUTING_REFUSED: "routing.refused"`, controls
  AU-2/AU-3/AU-12, `outcome: failure`, details `{ reason, requiredSetting? }`,
  no conversation content). The exact refusal mechanism depends on what
  `before_model_resolve` is allowed to return to abort a turn — to be confirmed
  against the host hook contract before implementation.

## Operator use-case

- Cost-control / budget-capped deployments where an un-routed turn can land on a
  flagship model and blow the budget.
- Compliance deployments where only approved (routed) models may ever be
  invoked, and "ran on the host default because routing was down" is an incident,
  not a graceful degrade.

For these, a turn that fails hard is strictly preferable to a turn that quietly
runs on the wrong model.

## Interaction with `intelligence.fallbackOnError`

`intelligence.fallbackOnError` (default `true`) already controls whether an
Intelligence error falls back to the cheap/passthrough path. `failClosed` sits
*above* it:

- `fallbackOnError: true, failClosed: false` — today's default: Intelligence
  error → cheap/passthrough. Turn runs.
- `fallbackOnError: true, failClosed: true` — contradictory intent. Resolve by
  having `failClosed` win: refuse rather than fall back, but surface a startup
  warning that `fallbackOnError` is being overridden so the config isn't
  silently misread.
- `fallbackOnError: false, failClosed: true` — consistent: no fallback, and the
  unroutable turn is refused rather than erroring into whatever the host does
  with a failed hook.

The two flags must be documented together so operators understand `failClosed`
is the stronger, outer guarantee.

## Risks

- **Turns fail hard.** The whole point, but it means a routing outage becomes a
  user-visible outage. Customer impact is immediate and total for affected
  turns — this is why it must be opt-in.
- **Blast radius of misconfiguration.** An operator who enables `failClosed`
  while conversation access is denied gets a deployment that refuses (or, if the
  host offers no block signal, can't actually enforce) — the startup signals
  must be loud and the doctor check must gate.
- **Host-contract dependency.** Per-turn refusal and any startup block depend on
  host-supported signals from `before_model_resolve` / activation. If those
  don't exist or change, the feature's guarantee weakens. Must be validated
  against the live host contract, not assumed.
- **Support load.** "ToggleLogic is blocking all my turns" tickets. Mitigated by
  the explicit opt-in, the named reason in every refusal, and the doctor check.

## Why the default must be off

OpenClaw's whole posture is graceful degradation: a routing problem should not
take down the gateway's ability to answer. Fail-closed inverts that trade-off,
which is correct only for the minority of deployments that explicitly choose
availability-for-correctness. Defaulting it on would turn every transient
routing/Intelligence hiccup — and every host that simply forgot the
conversation-access flag — into an outage. Off by default; on only by deliberate
operator choice.

## Decision requested

Approve/adjust: (1) flag name and home (`routing.failClosed` recommended),
(2) the startup-vs-per-turn behavior split, (3) the new `routing.refused` audit
event, and (4) confirmation of the host refusal/block contract these semantics
depend on. No code ships until approved.

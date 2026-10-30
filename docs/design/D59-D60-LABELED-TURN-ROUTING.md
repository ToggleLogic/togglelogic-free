# D59 / D60 — Labeled-turn routing: route-hint precedence + work-class capability floor

Design for ToggleLogic Free 2.4.0 (owner rulings D59 a / D60 a; version D61 a,
2026-10-30). This note is the public, generic design; it names no models, no
prices, no hosts, and no integration identifiers. Label names, route families,
capability tokens and latency budgets are deployment **data**, never engine code.

## Scope

Two additions, both additive and off by default (empty config ⇒ byte-identical to
2.3.0):

1. **D59 — integration route hint (precedence 4).** A generic, externally-supplied
   model binding that the engine falls back to on a *labeled* turn when its own
   higher-precedence rules decline.
2. **D60 — work-class capability floor.** A host task label can resolve through an
   ordered family route gated by required capabilities **and** a latency budget,
   instead of a single static model. Local-first; loud when no family qualifies.

## D59 — decision precedence

On a labeled turn the engine owns the model choice with this precedence:

1. owner `/model` (the owner's own protected selection)
2. ToggleLogic per-task owner pin
3. ToggleLogic configured route / work class for the task label
4. **integration route hint** (`integration_route_hint`) — the externally-supplied
   binding, **fallback only**
5. box default (host-resolved model)

The hint is a generic object `{ providerOverride?, modelOverride? }`. It is carried
as spawn-time session metadata the host surfaces on every turn
(`event.metadata.routeHint`) and read by generic field name — the engine holds no
integration-specific identifiers. It is plumbed into the `DecisionRequest` as
`routeHint` (wire: `work.routeHint`) and applied at a new precedence-4 step after
mode dispatch declines, only when the turn carries a task label.

**Loud by contract.** A hint that is *present but unusable* (no usable provider or
model) fails loudly as `integration_route_hint_unusable` — it never drops silently
to the box default. A hint whose provider is unavailable runs the normal failover
path (`provider_unavailable`), never a silent box default. A hint is never applied
over an explicit work-class floor failure (below).

Why a fallback and not an override: it keeps ToggleLogic the single authority on a
labeled turn (clean audit and cost ownership) while letting a coordinator bind the
turn when the engine has no opinion. Hook priorities are unchanged; the engine
registers its `before_model_resolve` handler at its existing priority.

## D60 — work-class capability floor

A `workClasses.<label>` config entry describes how a labeled turn resolves:

```
workClasses:
  <label>:
    requires: [ <opaque capability token>, ... ]   # e.g. a structured-output token
    route:    [ "family:<lineage>", "<provider/model>", ... ]   # ordered, local-first
    latencyBudgetMs: <number>                        # optional p95 ceiling
```

Resolution walks `route` in order and returns the **first** member that is, together:

- **resolvable** — a `family:<lineage>` resolves (via the existing lineage resolver)
  to a configured, allowed member; a `provider/model` passes through;
- **reachable** — its provider is not currently marked unavailable;
- **capable** — it satisfies every required capability token;
- **in budget** — when a `latencyBudgetMs` is set, the member's observed or declared
  p95 latency is within it.

Local-first is an emergent property of route **order**: a deployment lists its local
family first and a cheap hosted family after it, so a reachable, capable, fast local
member wins and a slow local one is skipped to the hosted fallback.

### Capability + latency are both the floor

A capability token alone is not enough: a family that meets the required capability
but cannot meet the latency budget on this box is **excluded**, not chosen. This is
why the floor carries both a capability dimension and a budget — a family that is
capable but too slow is not eligible, and the engine falls through to the next route
member (typically a cheap hosted family).

### Where the floor's answers come from

Two sources, in order:

1. **The licensed Intelligence seam**, when present, answers per-box observed
   capabilities and p95 latency through a synchronous seam query (seam ABI
   extension). It must read only pre-warmed state — never block the hot path on a
   reachability probe.
2. **Deployment-declared data**, when the seam is absent: a `capabilities` map
   (`{ "<token>": [ "family:<lineage>" | "<provider/model>", ... ] }`) and an
   optional `familyLatencyMs` map (declared p95 per member).

**No silent bypass.** When *neither* the seam nor the declared data can answer the
required capabilities, and when no route member clears both the capability and
latency floor, the result is a loud `work_class_floor_unmet` passthrough. The engine
never routes capability-gated work (for example, forced structured output) to a
family that cannot meet the floor.

## Cost: local turns are an explicit, visible zero

A configured local provider is recorded as explicitly priced at zero — a real,
visible ledger row with the basis `local-zero-cost` — rather than left visible-but-
unpriced. This is distinct from both a hosted priced estimate and the loud hosted-
unpriced path, which stays loud for hosted models that cannot be priced. The offline
exporter and ledger reader carry the new basis and count such rows as priced zero,
not unpriced.

## Compatibility

- Empty `workClasses` / `capabilities` / `familyLatencyMs` and an absent `routeHint`
  ⇒ no behavior change from 2.3.0. Owner `/model`, owner pins and configured routes
  are untouched.
- Replay treats the new selection reasons as not-replayable (they depend on live
  seam/availability state or a hint not carried in the log), so a recorded log from
  an earlier release replays unchanged.
- The seam query is an additive ABI extension; a licensed layer that does not
  implement it simply declines, and the floor falls back to declared data or fails
  loud.

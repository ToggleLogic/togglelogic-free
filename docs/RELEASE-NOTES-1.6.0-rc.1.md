# ToggleLogic Free 1.6.0-rc.1

This release candidate adds the public orchestration surface for owner-taught,
skill-aware model routing when a compatible ToggleLogic Intelligence 1.4 layer
is installed.

- Adds the opt-in `features.skillRouting` capability, the read-only
  `togglelogic_skill_plan` simulator, and `togglelogic_skill_run` for execution
  in a child session pinned to the learned route's current accepted child.
- Accepts planned skill identity, version, fingerprint, and execution class as
  structured metadata; Free never infers skills from prompt text.
- Presents Intelligence-produced lowest-cost, benchmark-best, and automatic
  choices with lineage, resolved child, location, estimate, and budget effect.
- Persists unanswered education state locally with a bounded TTL and hashed
  session correlation.
- Saves an exact owner choice through the Intelligence seam and routes the
  continuation to the selected concrete child.
- Executes learned skill work only through a gateway-scoped child run, reports
  the actual child provider/model, and fails loudly on timeout or terminal
  child error.
- Leaves the capability disabled by default. Existing routing behavior is
  unchanged until a deployment explicitly enables it.

The durable profile target is a model lineage or selection strategy. A numbered
model appears only as the execution child and audit evidence.

Owner teaching replies use a one-time plan token and are correlated to the
authenticated owner session (and sender identity when the host exposes it).
Shadow mode never stages a profile or emits a taught model override. The
deployment-supplied month-to-date spend participates in both preflight and
learned-route eligibility; it must be refreshed from an authoritative ledger.

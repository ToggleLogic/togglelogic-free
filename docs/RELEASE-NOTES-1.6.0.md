# ToggleLogic Free 1.6.0

This feature release adds opt-in owner-taught, skill-aware model routing when
paired with ToggleLogic Intelligence 1.4.0.

- `togglelogic_skill_plan` simulates routes and explains cost, benchmark,
  lineage, concrete child, location, and monthly-budget effects.
- `togglelogic_skill_run` executes learned skill work in a gateway-scoped child
  session pinned to the current accepted child of the stored lineage/strategy.
- Education choices are one-time, owner/session/sender-bound, restart-safe, and
  deterministically reused until skill or evidence invalidation.
- Host-configured models are authoritative routing candidates, while known
  broken/unstable models remain excluded.
- Child receipts name the actual runtime provider/model; timeout and terminal
  execution errors fail loudly.
- The feature remains disabled until a deployment explicitly enables it.

The Free package contains the orchestration and policy enforcement surface. The
benchmark registry and selection engine remain in the separately delivered
Intelligence package.

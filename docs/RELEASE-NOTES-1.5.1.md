# ToggleLogic Free 1.5.1

ToggleLogic Free 1.5.1 makes ordered host fallbacks compatible with durable
model families without confusing routing policy with runtime execution.

## What changed

- Family aliases may declare `acceptedModels`; newer discovered children cannot
  enter a route until the deployment accepts them.
- `familyResolution.hostPlan` records one primary family and an ordered list of
  fallback families.
- The resolver materializes that plan to the concrete references OpenClaw needs
  and fails closed if a rung is unresolved or duplicated.
- At startup, ToggleLogic compares the resolved plan with
  `agents.defaults.model` and emits an auditable aligned, drift, unresolved, or
  disabled result.
- Provider discovery recognizes models declared in OpenClaw's primary,
  fallback, and model-allowlist configuration.
- The router continues to classify a logical turn once and then preserves each
  OpenClaw fallback candidate.

## Responsibility boundary

ToggleLogic does not rewrite OpenClaw configuration. The deployment owns model
acceptance and materializes the resolved children before startup. OpenClaw owns
runtime failover and supplies the evidence saying whether a fallback occurred.

This model-family and ordered-fallback relationship may be protected by our
patent pending.

## Compatibility

The feature is opt-in. Existing 1.5.0 configurations behave unchanged. An
absent `hostPlan` records `disabled`; malformed or unresolved plans never alter
the host model chain.

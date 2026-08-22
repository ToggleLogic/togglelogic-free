# ToggleLogic Free 1.2.0

ToggleLogic Free 1.2.0 corrects two public routing-contract gaps.

- `configuredRoutes` now matches only structured task labels supplied by the
  host, then an optional `default`. It never reads prompt text.
- Selecting `mode: "intelligence"` now reports an unavailable licensed layer
  and passes through to OpenClaw. It no longer silently changes to cheap mode.
- `mode: "auto"` preserves its documented safe fallback behavior.

This remains the Free plugin. It does not contain the private Intelligence
classifier, registry, learning system, customer data, or provider credentials.

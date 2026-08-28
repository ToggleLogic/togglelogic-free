# ToggleLogic Free 1.3.2

This release repairs conversation continuity and fallback isolation in the
licensed Intelligence seam, introduces the ToggleLogic Free Startup Commercial
Use License 2.0, and clarifies the ClawHub-facing product boundary.

- An unmatched prompt now leaves the host-selected model untouched.
- A short affirmative confirmation can inherit one preceding high-confidence
  routing decision, but only in the same session, only for 15 minutes, and only
  once.
- Repeated model-resolution passes for the same logical turn pass through to
  OpenClaw, allowing its fallback chain to advance normally.
- Required execution-surface metadata is retained in audit details.
- Qualifying startups may embed ToggleLogic Free in commercial products while
  below the published funding and revenue thresholds, with a defined notice and
  transition path after either threshold is crossed.
- The package introduction now leads with configured routing, persistent owner
  overrides, local audit evidence, and local cost visibility.

The plugin remains fail-open to the host model when Intelligence declines and
does not include the proprietary classifier or registry.

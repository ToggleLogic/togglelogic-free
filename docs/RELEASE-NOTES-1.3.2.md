# ToggleLogic Free 1.3.2

This release repairs conversation continuity and fallback isolation in the
licensed Intelligence seam.

- An unmatched prompt now leaves the host-selected model untouched.
- A short affirmative confirmation can inherit one preceding high-confidence
  routing decision, but only in the same session, only for 15 minutes, and only
  once.
- Repeated model-resolution passes for the same logical turn pass through to
  OpenClaw, allowing its fallback chain to advance normally.
- Required execution-surface metadata is retained in audit details.

The plugin remains fail-open to the host model when Intelligence declines and
does not include the proprietary classifier or registry.

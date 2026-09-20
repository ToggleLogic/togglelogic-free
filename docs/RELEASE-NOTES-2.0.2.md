# ToggleLogic Free 2.0.2

This maintenance release makes new-session routing deterministic on OpenClaw
hosts that deliver `session_start` on an independent continuation.

- A bounded settling window bridges the small lifecycle race between
  `session_start` and `before_model_resolve`.
- The wait applies only when a session is first observed by the plugin process.
- Established sessions remain immediate, and late markers are safely discarded.

This prevents simple first-turn requests from bypassing the configured
general-purpose Intelligence route while preserving continuity on later turns.

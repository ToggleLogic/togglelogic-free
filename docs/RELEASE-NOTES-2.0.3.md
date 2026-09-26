# ToggleLogic Free 2.0.3

Maintenance release: ToggleLogic Free respects a model the user explicitly chose.

- A request resolved by OpenClaw to a model different from the agent's configured
  default is treated as an explicit selection and passed through unchanged.
- This restores `/model` selections on current OpenClaw hosts, whose session state
  moved to SQLite, and honors one-off `openclaw agent --model` requests.
- Owner overrides keep top precedence; ordinary requests on the default model are
  routed exactly as in 2.0.2.

Found by the SAM-Andy dogfood acceptance test on 2026-09-26.

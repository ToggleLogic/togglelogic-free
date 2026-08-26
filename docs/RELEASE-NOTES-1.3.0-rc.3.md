# ToggleLogic Free 1.3.0-rc.3

This candidate supersedes rc.2 after the isolated Headquarters canary exposed
one deployment-isolation defect. Default paths rooted at `~/.openclaw` now
follow OpenClaw's active `OPENCLAW_STATE_DIR`, so named and development profiles
cannot write plugin audit, routing, pricing, catalog, or owner-override state
into the production profile.

All routing capabilities remain opt-in and disabled by default. The security,
pricing, compatibility, reproducibility, and fail-safe changes documented for
rc.2 remain included.

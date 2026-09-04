# ToggleLogic Free 1.3.4

Public compatibility release for OpenClaw 2026.9.1.

## What changed

- Configured and cheap routes now split `provider/model` references into the
  separate provider and model override fields expected by OpenClaw 2026.9.1.
- Cold-start Intelligence detection is awaited for the first routing decision.
- Disabled Intelligence remains a clean, awaitable no-op for Free-only installs.
- New sessions carry a bounded, one-shot general-purpose routing signal to an
  optional separately installed Intelligence package. Cross-process markers are
  hashed, expire after five minutes, and never store raw session identifiers.
- The public License 2.0, notices, compatibility floors, and Free/Intelligence
  package boundary are preserved.

## Verification

- Full public regression suite and release quality gate pass.
- Packaged and validated with OpenClaw `2026.9.1`.
- The distributable excludes the Intelligence classifier, Toggle Registry,
  benchmark evidence, credentials, tests, reports, and repository metadata.

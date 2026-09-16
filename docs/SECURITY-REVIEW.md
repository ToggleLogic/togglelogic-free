# Security review notes

This document records the security-sensitive surfaces intentionally present in
ToggleLogic Free so automated and human reviewers can distinguish them from
unexpected behavior.

## Subprocess boundaries

The package uses Node's child-process API in two bounded adapters:

- `src/capture/owner-override-ask.js` starts a configured local Python consumer
  with a fixed argv array and writes structured input over stdin.
- `src/skill-routing/calendar-bridge.js` calls a deployment-configured calendar
  bridge with `execFile`, literal arguments, a timeout, a response-size ceiling,
  and strict JSON validation.

Neither adapter invokes a shell. User text is never evaluated as a command.

## Network boundary

`src/usage/pricing.js` may fetch public model-pricing data from Models.dev. It
sends no prompts, credentials, messages, calendar data, or owner state. A
bundled pricing snapshot provides the offline fallback.

## Local state and credentials

- Sensitive routing state is written atomically with owner-only permissions.
- The package contains no provider keys, OAuth tokens, passwords, or private
  keys and does not read provider credential values for routing decisions.
- Calendar and provider credentials remain in their deployment-owned bridges
  and host credential stores.

## Package lifecycle

- The package declares no runtime dependencies and has no install, postinstall,
  prepare, or other lifecycle scripts.
- It does not download or execute code during installation.
- Release artifacts are source-linked, checksum-recorded, and validated before
  publication.

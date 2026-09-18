# Changelog

## 2.0.0 — 2026-09-18

This release restores the canonical ToggleLogic Free product boundary.

### Included in ToggleLogic Free

- Generic model routing from owner overrides, host-supplied structured labels,
  deployment-declared defaults, or the separately licensed Intelligence seam.
- Generic approval, audit, cost-visibility, and bounded-execution primitives.
- Fail-loud compatibility verification between Free and Intelligence releases.

### Removed from ToggleLogic Free

- Assistant-specific intent interpretation and workflow resolution.
- Application-owned contracts, identities, integration policy, and presentation.
- Public workflow planning/run tools and their application-specific configuration.
- In-package model-family catalog judgment; that judgment belongs to Intelligence.

These removals are intentionally breaking, which is why the release is 2.0.0.
Deployments that used the removed 1.7.x surface must install an application-side
orchestration adapter before upgrading.

### Correction to the 1.7.x narrative

The 1.7.x changelog described application workflow improvements as ToggleLogic
Free capabilities. That description blurred the product boundary. Those changes
belonged to the consuming assistant layer. They are not capabilities of the Free
product and are not included in the 2.0.0 package.

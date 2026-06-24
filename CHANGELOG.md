# Changelog

All notable changes to ToggleLogic (Free Tier) are documented here.

## 1.0.1 — 2026-06-23

### Fixed
- **Your model selections now hold reliably.** When you pin a model for a session — or set an owner override — that choice is consistently honored above automatic routing. The routing layer still records when automatic selection *would* have chosen differently (visible in the audit stream), but your selection wins.
- **Richer routing-decision detail.** Each routing decision now records the requested model/provider and its provenance alongside the selected one, so the audit log shows what was asked for versus what was applied.

### Changed
- **Packaging metadata cleanup.** Aligned the declared minimum OpenClaw host version with the build target and removed an unsupported package metadata field, so the plugin validates cleanly against current OpenClaw.

---

## 1.0.0

- Initial public release: free-tier model routing for OpenClaw — owner overrides, static configured routes, a deliberately-simple cheapest-default, the optional licensed-Intelligence detection seam, and a structured audit stream.

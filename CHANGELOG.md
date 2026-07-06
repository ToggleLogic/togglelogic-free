# Changelog

All notable changes to ToggleLogic (Free Tier) are documented here.

## 1.0.3 — 2026-07-06

Adds an opt-in **cost-visibility** capability. **Routing behavior is unchanged from 1.0.2.**

### Added
- **See what your calls cost, in dollars.** A new opt-in capability observes each model call (the `llm_output` hook, observe-only) and reports per-model and per-day dollar cost, using **dynamic public pricing** fetched live from [Models.dev](https://models.dev) — cached locally, refreshed on a slow cadence, never fetched per call. Curated to the major providers' standard lineups (Anthropic, OpenAI, Google, xAI, Meta).
- **Bundled offline fallback.** If the live pricing source is unreachable, pricing degrades to a bundled LiteLLM snapshot (MIT) — last-known-good, not a crash and not $0.00.

### Changed
- **Unpriced usage is loud, never a silent $0.00.** Any model the curated free-tier set can't price is reported explicitly as *unpriced* (model + token count, shown separately) and is never rolled into the dollar total as $0.00. Priced and unpriced always appear together.

### Safety
- **Observe-only. Never enforces.** Cost visibility reports; it never blocks, halts, or downgrades a call. Spend enforcement and all-model / guaranteed-current pricing remain the paid tier.
- **No callback to us.** Pricing is fetched directly from the public source; the plugin never contacts any ToggleLogic/Motherboard endpoint for pricing.

### Compatibility
- The cost observer requires the gateway's `plugins.entries.togglelogic.hooks.allowConversationAccess` (the `llm_output` hook is a conversation hook). Supported OpenClaw unchanged from 1.0.2.

## 1.0.2 — 2026-07-05

Metadata and compatibility release. **Routing behavior is unchanged from 1.0.1.**

### Changed
- **Correct catalog listing.** The plugin now declares its categories, so it lists under model-routing / cost-optimization instead of "Other."
- **Canonical source.** The package is now linked to its home organization repository, github.com/ToggleLogic/togglelogic-free, replacing the earlier personal-account link.
- **Explicit compatibility.** Supported OpenClaw: 2026.6.5 – 2026.6.11, validated on 2026.6.11; minimum gateway `>=2026.6.5`, plugin API `>=2026.5.2`.

## 1.0.1 — 2026-06-23

### Fixed
- **Your model selections now hold reliably.** When you pin a model for a session — or set an owner override — that choice is consistently honored above automatic routing. The routing layer still records when automatic selection *would* have chosen differently (visible in the audit stream), but your selection wins.
- **Richer routing-decision detail.** Each routing decision now records the requested model/provider and its provenance alongside the selected one, so the audit log shows what was asked for versus what was applied.

### Changed
- **Packaging metadata cleanup.** Aligned the declared minimum OpenClaw host version with the build target and removed an unsupported package metadata field, so the plugin validates cleanly against current OpenClaw.

---

## 1.0.0

- Initial public release: free-tier model routing for OpenClaw — owner overrides, static configured routes, a deliberately-simple cheapest-default, the optional licensed-Intelligence detection seam, and a structured audit stream.

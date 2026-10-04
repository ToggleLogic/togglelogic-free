<!--
ToggleLogic (Free Tier) — fallback lineages review handoff.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# Fallback lineages review handoff

Repository: ToggleLogic/togglelogic-free.
Branch: codex/free-2.1.0-fallback-lineages.
Base: codex/free-2.1.0-tl6 at 615c05e (PR #25), following TL-5 PR #24.
Version remains 2.1.0-rc.1. Source proposed for Claude Code review only.
No deployment, install, version increment, tag, publish, or merge performed.

Goal: keep fallback order stable as lineages while resolving current eligible
children from public release metadata. Baseline used configured child fallbacks
and terminal-only ledger lineage derivation. Acceptance: host eligibility,
release-date ordering/refresh, deterministic ties, cooldown skip, loud exhaustion,
shared mid-name version derivation, startup plan warnings, and hook integration.

Changed files:
- src/routing/lineage.js: shared syntactic lineage derivation.
- src/routing/lineage-resolver.js: host eligibility, dated-child resolution,
  ordered failover, and startup plan audit.
- src/usage/ledger-row.js: re-export shared derivation.
- src/usage/pricing.js: expose public release metadata on the existing cache cadence.
- src/config/normalize.js and openclaw.plugin.json: fallback lineage configuration.
- src/capabilities.js: shared pricing instance, startup audit, resolver wiring.
- src/routing/interceptor.js: resolve cooldown failover, log lineage/child,
  fail explicitly on exhaustion, invalidate cached decisions after cooldowns.
- tests/lineage-resolver.test.js: resolver, configuration, cache refresh,
  fallback audit, hook registration, and cached-decision regression tests.
- tests/ledger.test.js: required mid-name derivation examples and retained size labels.
- tests/provider-refusal.test.js: adapt failover fixture to the lineage interface.
- CHANGELOG.md, docs/COST-LEDGER.md, docs/FALLBACK-LINEAGES.md, this handoff.

`npm run quality` tail:
```
ℹ tests 160
ℹ suites 0
ℹ pass 160
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1453.188083
```

`git diff --check` passed. Tests use synthetic public-feed-shaped data and
isolated files; registered-hook tests do not call a paid provider or install
software. Live provider behavior and deployment acceptance are not claimed.

Open review questions/limits: models without valid public release dates cannot
resolve, including local models absent from the public feed. Stale public cache
remains usable but cannot reveal newly released children. A newly discovered
child must already be host-configured/allowed; this never broadens permissions.
Core controls the response to rejected hooks and still owns in-turn retries.
Empty lineage plans fail explicitly during provider cooldown; no legacy child
pin is silently substituted. Startup audit warns about unmatched numbered core
fallbacks but does not change core configuration. Existing persisted ledger
lineages are not rewritten. Claude Code reviews and merges the stack in order.

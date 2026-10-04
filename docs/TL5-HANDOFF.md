<!--
ToggleLogic (Free Tier) — TL-5 review handoff.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# TL-5 review handoff

Repository: ToggleLogic/togglelogic-free. Branch: codex/free-2.1.0-tl5.
Baseline: 73af907, v2.1.0-rc.1. Version unchanged; source proposed for review only.
No deployment, installation, release, tag, or merge performed.

Goal: use positive billing-refusal evidence to avoid the same provider on the
next turn, while preserving explicit owner overrides. Baseline has no provider
cooldown. Acceptance: conjunctive classifier, first-only cooldown events,
expiry with success recovery, next-turn reroute, and recorded override conflict.

Exact installed version: `OpenClaw 2026.9.7 (c074824)`.
Verified installed hook: `llm_output.lastAssistant.errorMessage`, gated by
`stopReason === "error"` and matching assistant provider/model. The hook type
includes `lastAssistant`; the built-in harness passes the assistant snapshot
unchanged. Zero usage carries no classification by itself. See the upstream
draft for inspected functions and the separate historical retry report.

Files: provider-refusal.js (classifier/state/host fallback lookup), interceptor.js
(next-turn failover and override conflict), capabilities.js (shared state and
hook registration), normalize.js (cooldown default), events.js (sanitized event
sinks), provider-refusal.test.js, CHANGELOG.md, this handoff, and
upstream/openclaw-billing-402-retry.md.

Tests added: billing/nonbilling matrix including Google prepay and rate limits,
OpenAI insufficient_quota, Anthropic credit balance, bounded long input,
zero-usage/mismatched evidence, cooldown expiry/recovery/deduplication,
next-turn fallback, owner precedence/conflict, and exhausted fallbacks.

`npm run quality` tail:
```
tests 145
suites 0
pass 145
fail 0
cancelled 0
skipped 0
todo 0
```

Open review questions/limits: no live billing failure was induced. Cooldowns
are process-local and reset on restart. Hook errors are controlled by the host;
Free cannot force core to abort or stop its in-turn retry loop. Missing provider
error evidence cannot be classified. Claude Code reviews and merges; item 5
will replace configured-child fallback lookup with configured lineage resolution.

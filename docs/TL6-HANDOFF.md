<!--
ToggleLogic (Free Tier) — TL-6 review handoff.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# TL-6 review handoff

Repository: ToggleLogic/togglelogic-free. Branch: codex/free-2.1.0-tl6.
Base: codex/free-2.1.0-tl5 at 1a8fae9 (PR #24). Version remains 2.1.0-rc.1.
Source proposed only; no deployment, install, release, tag, or merge.

Goal: give owners an honest prepaid balance estimate and persistent low-balance
notification. Baseline has priced call history but no top-ups or balance view.
Acceptance: estimate arithmetic, restart persistence, once-only thresholds,
new-top-up reset, actual CLI execution, and observer-to-ledger integration.

Changed files: src/usage/balances.js; src/usage/cost-observer.js;
src/usage/events.js; src/config/normalize.js; bin/togglelogic-cost.js;
tests/balances.test.js; CHANGELOG.md; docs/PREPAID-BALANCES.md; this handoff.

Tests added: priced spend/date/provider filtering and missing-cost counts;
restart persistence; concurrent threshold deduplication; new-top-up reset;
percentage threshold and negative balance; invalid input/corrupt history;
missing ledger detection; configured CLI paths across invocations; cost observer
writing the call before checking a balance threshold.

`npm run quality` tail:
```
tests 149
suites 0
pass 149
fail 0
cancelled 0
skipped 0
todo 0
```

Open review questions/limits: CLI config must be JSON (JSON5 fails loudly);
alerts replay retained history in the background and can lag on large ledgers;
crash-stale locks require inspection; secondary event/audit delivery is best
effort with the canonical low event retained in balances.jsonl. No provider API
or external balance verification is claimed. Estimates cannot recover deleted
history or provider usage outside this ledger. Claude Code reviews and merges.

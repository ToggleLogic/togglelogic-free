<!--
ToggleLogic (Free Tier) — ledger fields, offline exports, and budget events.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved.
PATENT PENDING.
-->

# Cost ledger and exports

Every new `kind: "call"` row records deployment and cost-center attribution,
serving provider, model, resolved reference, lineage, usage/cache counts, estimated
`costUsd` (or null), `priceSource`, `priceVersion`, `unpriced`, `usageMissing`,
`requestId` (or null), `billable`, `invoiceEligible`, and `invoiceEligibleReason`.
Unknown fields have explicit nulls; missing spend is never converted into zero.
Summary rows are aggregates rather than calls and are excluded from exports and
budget calculations.

Lineage derivation is shared by the ledger and fallback resolver in
`src/routing/lineage.js`. It requires a qualified `provider/model` reference and
removes numeric version/date components introduced by a hyphen, underscore,
colon, or at-sign, including **mid-name** components. Dots join numeric parts
within a whole version group; they never start a group. Components may start
with `v`; attached dotted names such as `ollama/qwen2.5:7b` and size labels
such as `70b` remain literal.
Thus `google/gemini-3.5-flash` becomes `google/gemini-flash`,
`anthropic/claude-haiku-4-5` becomes `anthropic/claude-haiku`,
`openai/gpt-5.5` becomes `openai/gpt`, and `xai/grok-4.3` becomes `xai/grok`.
`example/model-2-fast` becomes `example/model-fast`. A bare, invalid, or
numeric-only model yields `lineage: null` with a `lineageReason`. This syntactic
rule neither consults nor implements any private family resolver. Existing
persisted lineage values are not rewritten; new rows use this shared rule.

`priceVersion` identifies the actual price data: the pricing cache's `fetchedAt`
for Models.dev, or `sha256:<digest>` of the exact override or bundled fallback
file bytes. Stale-cache use retains the original fetch timestamp. Unpriced rows
have null provenance when no price resolved. A priced model with missing usage
still retains the price provenance even though its cost is null.

`costVisibility.attribution.billable` defaults to true. A call is billable only
when a price and usable usage exist and the deployment has not disabled billing.
All public-rate estimates have `invoiceEligible: false`, even if billable. The
reason precedence is `unpriced`, `usage-missing`, `not-billable-deployment`, then
`public-rate-estimate`. Only later reconciliation can promote invoice eligibility;
exports preserve a previously promoted row but never perform that promotion.

## Offline monthly export

Run the packaged command (or `node bin/togglelogic-cost.js` from source):

```sh
togglelogic-cost export --month YYYY-MM --format json --ledger /path/to/cost.jsonl
togglelogic-cost export --month YYYY-MM --format csv --out /path/to/new-export.csv
```

JSON is the default format. The default ledger is
`~/.openclaw/logs/togglelogic-cost.jsonl`, respecting `OPENCLAW_STATE_DIR`.
Use `--ledger` for a custom cost-log destination. Export reads the current ledger
and numbered rotations in the same directory, without network access or changing
the ledger. `--out` creates a new private file and refuses to overwrite an
existing file. Without `--out`, output goes to stdout.

The output header states the UTC month, inclusive start and exclusive end,
estimate basis, incomplete-data status, and reader diagnostics. JSON contains
`rows`, `rollup`, and `totals`. CSV contains three labeled tables: rows, attribution
rollup, and totals. Dollar totals are calculated at the ledger's micro-dollar
precision. Rollups group by deployment ID, serving provider, and lineage and
include calls, priced dollars, unpriced calls, usage-missing calls, and billable
dollars. No summary rows are counted. CSV strings are quoted and formula-leading
cells are neutralized.

Older rows without the new fields are normalized for export. Missing price
provenance stays null; lineage is derived using the rule above. A legacy priced
call without a `billable` field uses the default true; an explicit false is
preserved. This is an attribution assumption, not invoice eligibility. Corrupt
lines or invalid timestamps are counted in diagnostics and mark the report
incomplete. Missing ledgers also produce an explicitly incomplete report.
Totals cover retained files only: export cannot recover rotations already removed.
For a stable financial review, export a snapshot rather than a rotating live file.

## Monthly budget awareness

Set `costVisibility.budgets.monthlyUsd` to a positive dollar limit. With no valid
limit, budget tracking is disabled. `thresholdsPct` defaults to `[50, 80, 100]`;
a configured array replaces it. Thresholds must be positive finite numbers;
duplicates are removed and the values sorted.

Budget tracking rebuilds priced month-to-date spend for the current deployment
from the ledger and numbered rotations at startup. It includes non-billable
calls because they still represent spend. Ledger appends queue behind replay,
so a call arriving during startup is counted once. Replay, writes, and event
emission run in the background; the `llm_output` handler does not await them.

A crossing emits `budget_threshold_crossed` through the event and audit streams:
`month`, `thresholdPct`, `monthlyUsd`, `spentUsd`, `unpricedCalls`,
`usageMissingCalls`, and `historyIncomplete`. The two missing-cost counts are
always present, including when zero. A disabled/unreadable ledger or corrupt
history raises a host warning and flags the event as incomplete. A priced
subtotal never represents unpriced or missing-usage spend.

Each threshold emits once per deployment per UTC month; startup can emit a
previously unrecorded crossing. Suppression survives restarts through retained
event records, including the previous month's records for late completions.
Changing a limit or cost center does not reset a threshold already emitted in
that month. A new month starts a new total. Preserve ledger and event history
for the entire accounting period: rotation expiry or manual deletion loses
history. Independent processes must use separate paths; no cross-process writer
lock or provider-invoice reconciliation is performed here.

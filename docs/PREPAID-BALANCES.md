<!--
ToggleLogic (Free Tier) — prepaid balance estimate usage.
(c) 2026 Motherboard, Inc. Source-available under the ToggleLogic Free-Tier
License (see LICENSE); all rights reserved. PATENT PENDING.
-->
# Prepaid balance estimates

Record a top-up with `togglelogic-cost topup --provider <id> --amount <usd>
--date YYYY-MM-DD [--note <text>]`. Read estimates with
`togglelogic-cost balance [--provider <id>]`.

Both commands load `plugins.entries.togglelogic.config` from the standard
OpenClaw JSON config, respecting `OPENCLAW_CONFIG_PATH` and profile state paths.
Use `--config <path>` for an explicit JSON configuration. Non-JSON configuration
fails explicitly; the CLI never silently substitutes default paths for a config
it cannot parse. Export command behavior is unchanged.

`costVisibility.balances.path` controls the append-only history, defaulting to
`~/.openclaw/togglelogic/balances.jsonl`. The cost ledger comes from
`costVisibility.log.path`. Notes are optional local text; do not put credentials
or billing identifiers in them. This feature uses no provider balance API.

Remaining is the sum of recorded top-ups minus priced observed spend since the
earliest top-up date, inclusive at UTC midnight. All top-ups are included;
appending another top-up does not discard earlier spend. Negative remaining
values are preserved. Corrections/refunds are not supported by this command.

The report is always an **estimate**. Priced observed spend is a floor on spend,
so remaining can be overstated. Unpriced and usage-missing calls are counted
separately. Retained ledger files cannot prove complete provider spend; external
usage and deleted rotations cannot be recovered. Missing files or malformed
rows flag detectable incompleteness. No top-ups yields an explicit warning.

After persisted call observations, either `lowBalanceUsd` or `lowBalancePct`
under `costVisibility.balances` can trigger `provider_balance_low`. Percentage
uses cumulative recorded top-ups as its denominator. Each provider alerts once
per latest appended top-up ID, regardless of top-up date. The durable event in
the balance history is also the suppression marker; event-log and audit copies
are best effort. A new top-up starts a new alert period, even if its amount
leaves the estimate below threshold. Thresholds are observations, not spending
limits, and never block a call.

Writers publish a directory lock containing a unique owner record with PID and
timestamp. A lock older than 60 seconds is recovered only when its owner process
is gone; live or recent owners are preserved. Empty legacy locks are recovered
after 60 seconds. Corrupt/incomplete history still fails explicitly.

The observer replays retained ledger files once at startup, before appending
live calls. Later calls update daily spend totals in memory. The top-up history
is reloaded only when its mtime or size changes, including external CLI top-ups.
Daily totals allow backdated top-ups without another ledger replay. Each CLI
invocation takes a fresh ledger snapshot. A running observer does not ingest
external ledger edits; restart it after such edits. Missing costs and retained
history limitations still apply. Low-balance rows carry deployment, cost-center,
and request attribution, with an explicit reason when correlation is absent.

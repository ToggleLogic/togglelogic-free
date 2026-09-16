# Durable runtime-state refresh — candidate stage + runbook (1.6.1-rc.3)

The versioned **skill-inventory** snapshot expires after 24 h and the **cloud-spend**
snapshot after ~26 h, but the two generators
(`scripts/generate-skill-inventory.mjs`, `scripts/generate-spend-snapshot.mjs`) are
deploy-time only. Without a scheduled refresh, both go stale and the plugin fails
closed (no turn resolves to a skill; cloud routes are withheld). This is the durable,
conservative refresh **stage** an existing scheduled job can call **after a managed
install** to keep both snapshots current.

**Nothing here is activated.** This document is the candidate wrapper + patch +
runbook so root can install it safely later. The live schedule, the live
`openclaw.json`, and the live gateway are untouched by this task.

## What the stage does

`scripts/togglelogic-runtime-refresh.mjs` runs six ordered stages and **fails
closed** at the first failure, recording every stage in a sentinel:

| Stage | Fails closed when |
| --- | --- |
| `plugin_present` | plugin `package.json` / `openclaw.plugin.json` unreadable, or version ≠ `--free` |
| `feature_enabled` | `features.skillRouting.enabled` or `skillRouting.spend.enabled` is not true (read-only) |
| `compatible_pair` | Free version not in the installed Intelligence `release-manifest.json` `validated_versions`, or release-state mismatch |
| `inventory_generated` | `openclaw skills list --json` empty/unreadable, or the generated snapshot fails re-validation |
| `spend_generated` | **malformed usage JSON, a stale/wrong month, or any unpriced CLOUD row** (unpriced LOCAL/Ollama rows are expected $0), or re-validation fails |
| `committed` | atomic rename of the validated pair into place fails |

The two new snapshots are written to **temp files** and committed with back-to-back
renames only when BOTH validate — so a failed run leaves the previous good snapshots
untouched (no half-updated pair). Cleanup removes any leftover temp files.

It does **not** bake a development path into production: the plugin root defaults to
the script's own install location (`--plugin-root` / `TOGGLELOGIC_PLUGIN_ROOT`
override), and all validators are imported from the **installed** plugin, never a dev
copy. It reads the live config **read-only** to confirm the feature is enabled and
never shells out to `openclaw` except the two generators' documented, deploy-time
`skills list` / `gateway usage-cost` reads.

## Sentinel

Default `~/.openclaw/togglelogic/runtime-refresh.sentinel.json`:

```json
{
  "schema": "togglelogic_runtime_refresh_sentinel/v1",
  "overall": "success",
  "failed_stages": [],
  "started_at": "…", "finished_at": "…", "duration_ms": 1234,
  "stages": [ { "name": "spend_generated", "status": "ok", "detail": { "policyMonth": "2026-09", "monthToDateCostUsd": 23.13 } }, … ],
  "plugin_root": "…", "free": "1.6.1-rc.3", "intelligence": "1.4.1-rc.3",
  "inventory_out": "…", "spend_out": "…"
}
```

The process exits non-zero on failure so the calling job can surface it.

## Manual dry run (safe; writes only snapshots + sentinel)

```sh
node <MANAGED_PLUGIN_ROOT>/scripts/togglelogic-runtime-refresh.mjs \
  --plugin-root <MANAGED_PLUGIN_ROOT> \
  --intelligence-root ~/togglelogic-intelligence \
  --free 1.6.1-rc.3 --intelligence 1.4.1-rc.3 \
  --timezone America/New_York \
  --config ~/.openclaw/openclaw.json
# (defaults: --inventory-out ~/.openclaw/togglelogic/skill-inventory.snapshot.json,
#            --spend-out ~/.openclaw/togglelogic/cloud-spend.snapshot.json,
#            --sentinel  ~/.openclaw/togglelogic/runtime-refresh.sentinel.json)
```

## Candidate patch for the existing 4 AM refresh job (NOT applied)

`~/.openclaw/workspace/.toggle_registry/scripts/refresh_registry.sh` currently runs
its eight registry steps and writes `.last_refresh.json`. Append a single stage at
the end (after `rebuild_routing_policy`, before the sentinel write) — root reviews
and applies:

```sh
# --- ToggleLogic runtime-state refresh (candidate; managed install only) ---
TL_PLUGIN_ROOT="${TOGGLELOGIC_PLUGIN_ROOT:-$HOME/.openclaw/plugins/togglelogic}"  # managed install path
tl_refresh_rc=0
if [ -f "$TL_PLUGIN_ROOT/scripts/togglelogic-runtime-refresh.mjs" ]; then
  "$(command -v node)" "$TL_PLUGIN_ROOT/scripts/togglelogic-runtime-refresh.mjs" \
    --plugin-root "$TL_PLUGIN_ROOT" \
    --intelligence-root "$HOME/togglelogic-intelligence" \
    --timezone "America/New_York" \
    --config "$HOME/.openclaw/openclaw.json" >> "$LOG" 2>&1
  tl_refresh_rc=$?
  [ "$tl_refresh_rc" -ne 0 ] && _note_fail "togglelogic_runtime_refresh(rc=${tl_refresh_rc})"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] togglelogic runtime refresh SKIPPED (plugin not managed-installed at $TL_PLUGIN_ROOT)" >> "$LOG"
fi
# --- end ToggleLogic runtime-state refresh ---
```

This reuses the job's existing `_note_fail` / `$LOG` so a stale or fail-closed refresh
shows up in the registry sentinel (`.last_refresh.json` `failed_steps`) and the job's
log, in addition to the stage's own `runtime-refresh.sentinel.json`.

## Install

1. Managed-install the paired plugins so `<MANAGED_PLUGIN_ROOT>` exists (e.g.
   `openclaw plugins install <checkout> --link --accept-capabilities`).
2. `--free`/`--intelligence` may be omitted; the stage reads them from the installed
   `package.json` files. Pin them only to assert an exact pair.
3. Dry-run the manual command above; confirm `overall=success` and the two snapshots
   updated.
4. Apply the candidate patch to `refresh_registry.sh` (as root, after review).

## Rollback

- Remove the appended block from `refresh_registry.sh` (the job returns to its prior
  eight steps; no ToggleLogic state is written by it).
- The snapshots and sentinel are plain files under `~/.openclaw/togglelogic/`; delete
  them to force the plugin fully fail-closed until the next manual generate.
- No `launchd`/cron unit is added or modified by this candidate; the existing
  `com.motherboard.toggle-registry-refresh` unit is unchanged.
